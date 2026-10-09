/**
 * One Cursor AgentService/Run: open an HTTP/2 stream, read it, then tear it down.
 *
 * Ported from magpie's Cursor provider (MIT):
 * https://github.com/magpie-community/plugins/tree/main/packages/cursor
 * which itself was ported from magpie's Go client (internal/provider/cursor*.go).
 *
 * Not ported: parked HTTP/2 sessions, checkpoint resume, run journals, and the
 * OpenCode chat-completions adapter (errorResponse / kept / owed usage).
 * A tool call ends this Run. Pi executes the tool and sends the result on the
 * next request's history. Nothing writes a tool result back to this stream.
 */
// @ts-nocheck
import { createHash, randomBytes, randomUUID } from "node:crypto"
import http2 from "node:http2"
import { EMPTY, failure, field, fields, frame, frames, pb, pbAny, pbNum, pbStr, pbValue, regional } from "./codec.ts"
import { AGENT, API, CALL, GOOS, NAMESPACE, clientVersion, tempDir, unary } from "./client.ts"
import { request as resolveModel, usable } from "./models.ts"

const NO_RESULT = "Tool use was interrupted and did not produce a result."

function defaultConnect(origin) {
  return http2.connect(origin)
}

const textOf = (c) =>
  typeof c === "string" ? c : Array.isArray(c) ? c.filter((p) => p?.type === "text").map((p) => p.text ?? "").join("") : ""

// joinSplitCalls joins an assistant message onto the assistant message
// before it when that one made tool calls: Anthropic takes consecutive
// assistant messages as one turn, and an agent can send a turn's parallel
// calls split over two of them, answered together after (yetone/magpie#1275).
// Answered at the second message, the first calls would be marked
// interrupted and their real results dropped. msgs is left as it is.
function joinSplitCalls(msgs) {
  const out = []
  for (const m of msgs) {
    const prev = out.at(-1)
    if (m?.role === "assistant" && prev?.role === "assistant" && prev.tool_calls?.length) {
      const content = [textOf(prev.content), textOf(m.content)].filter(Boolean).join("\n\n")
      out[out.length - 1] = { ...prev, content, tool_calls: [...prev.tool_calls, ...(m.tool_calls ?? [])] }
      continue
    }
    out.push(m)
  }
  return out
}

function parseArgs(s) {
  if (s && typeof s === "object") return s
  try {
    const v = JSON.parse(s || "{}")
    return v && typeof v === "object" ? v : {}
  } catch {
    return {}
  }
}

// tools are the caller's tools the model may call.
function toolsOf(chat) {
  return (chat.tools ?? [])
    .filter((t) => t?.type === "function" && t.function?.name)
    .map((t) => {
      const schema = t.function.parameters ?? { type: "object", properties: {} }
      return { name: t.function.name, description: t.function.description ?? "", schema, schemaText: JSON.stringify(schema) }
    })
}

// catalog lists the caller's tools for the model. It sees MCP tools only
// through Cursor's GetDynamicTools and CallDynamicTool, and Cursor names
// them in a prompt of its own, which this conversation goes without:
// without the list the model says it has no such tool. Each entry is
// written as the CallDynamicTool call itself: listed as <tool name=...>,
// some models (GLM-5.3) called the names bare, as tools of their own, and
// those calls went nowhere (#11).
function catalog(tools) {
  if (!tools.length) return ""
  let s = `\n\n<dynamic_tool_catalog>\nThe MCP namespace "pi" has the tools below. They are reached only through \`${CALL}\`, never as tools of their own. Each entry is the exact call to make; its arguments must match the schema given. The schemas are complete, so there is no need to call \`GetDynamicTools\` first.\n`
  for (const t of tools) s += `<call>${CALL}({"namespace":"${NAMESPACE}","toolName":"${t.name}","arguments":{...}})\n${t.description}\narguments schema: ${t.schemaText}\n</call>\n`
  return s + "</dynamic_tool_catalog>"
}

// callID is a call's id as Cursor gave it, before the line in it was sent
// to the caller as __.
const callID = (id) => (id.startsWith("call_") ? id.replace("__fc_", "\nfc_") : id)

function result(id, text, isError) {
  let res = text
  try {
    res = JSON.parse(text)
  } catch {}
  return {
    type: "tool-result",
    toolCallId: callID(id),
    toolName: CALL,
    result: res,
    experimental_content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  }
}

// messages is the conversation as AI SDK messages, in JSON: the system
// prompt with the caller's tools listed, then each turn. A tool result
// answers a call of the reply before it; a call left unanswered is
// answered for, as the API wants every call to have its result. With it,
// the user's last words.
function conversation(chat, tools) {
  const out = []
  const add = (m) => out.push(Buffer.from(JSON.stringify(m)))
  const system = []
  let last = "."
  for (const m of chat.messages ?? [])
    if (m.role === "system" || m.role === "developer") system.push(textOf(m.content))
  const sys = system.filter(Boolean).join("\n\n") + catalog(tools)
  if (sys) add({ role: "system", content: sys })
  let pending = []
  let results = []
  const answer = () => {
    for (const id of pending) results.push(result(id, NO_RESULT, true))
    pending = []
    if (results.length) add({ role: "tool", content: results })
    results = []
  }
  for (const m of joinSplitCalls(chat.messages ?? [])) {
    if (m.role === "system" || m.role === "developer") continue
    if (m.role === "tool") {
      const id = m.tool_call_id ?? ""
      const i = pending.indexOf(id)
      if (i >= 0) {
        pending.splice(i, 1)
        const text = textOf(m.content)
        results.push(result(id, text, false))
      }
      continue
    }
    if (m.role === "assistant") {
      answer()
      const content = []
      const text = textOf(m.content)
      if (text) content.push({ type: "text", text })
      for (const c of m.tool_calls ?? []) {
        if (c?.type && c.type !== "function") continue
        const args = parseArgs(c.function?.arguments)
        content.push({ type: "tool-call", toolCallId: callID(c.id), toolName: CALL, args: { namespace: NAMESPACE, toolName: c.function?.name, arguments: args } })
        pending.push(c.id)
      }
      if (content.length) add({ role: "assistant", content })
      continue
    }
    // the user's
    const content = []
    const parts = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content ?? []
    let first = ""
    for (const p of parts) {
      if (p?.type === "text" && p.text) {
        content.push({ type: "text", text: p.text })
        first ||= p.text
      } else if (p?.type === "image_url") {
        const u = typeof p.image_url === "string" ? p.image_url : p.image_url?.url ?? ""
        const d = /^data:([^;,]+);base64,(.*)$/s.exec(u)
        if (d) content.push({ type: "image", mimeType: d[1], image: { __type: "Uint8Array", hex: Buffer.from(d[2], "base64").toString("hex") } })
        else content.push({ type: "text", text: `[attachment image: ${u}]` })
      } else if (p?.type === "file") {
        content.push({ type: "text", text: `[attachment ${p.file?.filename ?? "file"}]` })
      }
    }
    answer()
    if (first) last = first
    if (content.length) add({ role: "user", content })
  }
  answer()
  return { msgs: out, last }
}

// ---- the request ---------------------------------------------------------------------

// toolDef is an McpToolDefinition.
function toolDef(t) {
  const d = pb().str(1, t.name)
  if (t.description) d.str(2, t.description)
  d.bytes(3, pbValue(t.schema))
  return d.str(4, NAMESPACE).str(5, t.name).str(6, t.schemaText).done()
}

const env = () => pb().str(1, GOOS).str(2, tempDir()).str(10, "UTC")

function sessionOf(input) {
  return String(input?.sessionID ?? "").trim().slice(0, 128)
}

// uuidOf is a version 4 UUID made of a hash's first 16 bytes.
function uuidOf(b) {
  b = Buffer.from(b.subarray(0, 16))
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = b.toString("hex")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

// conversationID is stable for one Pi session plus its first user message,
// so Cursor keeps sending the conversation to the machine that cached the
// prompt. The first message keeps subagents that share a session id apart.
// With no session it is "", and each Run gets a new id.
export function conversationID(chat, session) {
  const key = String(session ?? "").trim()
  if (!key) return ""
  const msgs = Array.isArray(chat?.messages) ? chat.messages : []
  const first = msgs.find((m) => m?.role === "user") ?? msgs[0]
  // role and content only: a timestamp on the same first message must not move the id
  const stable = first === undefined ? "" : JSON.stringify({ role: first.role, content: first.content })
  const sum = createHash("sha256")
    .update("cursor conversation\0" + key + "\0" + stable)
    .digest()
  return uuidOf(sum)
}

// usageOf is a TurnEndedUpdate as magpie counts usage, as the built-in's
// cursorUsage has it (magpie #498). Its input_tokens is the whole prompt,
// what was read from the cache and written to it included, as Cursor's
// own client has it (it takes both out to get the prompt's uncached
// rest); input is that rest, the cache added back for prompt_tokens. Its
// reasoning_tokens is kept as reasoning.
function usageOf(uf) {
  const [inp, cr, cw] = [pbNum(uf, 1), pbNum(uf, 3), pbNum(uf, 4)]
  return { input: Math.max(inp - cr - cw, 0), output: pbNum(uf, 2), cacheRead: cr, cacheWrite: cw, reasoning: pbNum(uf, 5) }
}

function buildRun(msgs, lastUser, tools, model, conv = "", { maxMode = false, params = [] } = {}) {
  const blobs = new Map()
  const put = (b) => {
    const id = createHash("sha256").update(b).digest()
    blobs.set(id.toString("hex"), b)
    return id
  }
  const state = pb()
  for (const m of msgs) state.bytes(1, put(m))
  const mid = randomUUID()
  const user = pb().str(1, lastUser).str(2, mid).varint(4, 1).done() // mode: agent
  const turn = pb().bytes(1, pb().bytes(1, put(user)).str(10, mid)).done()
  state.bytes(8, put(turn)).varint(10, 1).str(22, "cli")
  const defs = tools.map(toolDef)
  const rc = pb().bytes(4, env())
  const mcp = pb()
  for (const d of defs) {
    rc.bytes(7, d)
    mcp.bytes(1, d)
  }
  const action = pb().bytes(2, pb().bytes(2, rc)) // resume_action
  // ModelDetails: model_id, display_model_id, display_name, max_mode (7);
  // RequestedModel: model_id, max_mode (2), parameters (3)
  const details = pb().str(1, model).str(3, model).str(4, model)
  const requested = pb().str(1, model)
  if (maxMode) {
    details.varint(7, 1)
    requested.varint(2, 1)
  }
  for (const p of params) requested.bytes(3, pb().str(1, p.id).str(2, p.value))
  const rr = pb()
    .bytes(1, state)
    .bytes(2, action)
    .bytes(3, details)
    .bytes(4, mcp)
    .str(5, conv || randomUUID())
    .bytes(9, requested)
    .varint(19, 1) // inline images
  return { first: pb().bytes(1, rr).done(), blobs }
}

// ---- the agent API ---------------------------------------------------------------------

// endpoints are the agent API picked for each token (by its hash). As
// cursor-agent does, it is what ServerConfigService/GetServerConfig names —
// a team may be served in one region only, and the global API turns it
// away — asked once a token, and again when fresh is set; the global one
// while it can't be had.

const endpoints = new Map()
export async function agentURL(tok, fresh) {
  const key = createHash("sha256").update(tok).digest("hex")
  const had = endpoints.get(key)
  if (!fresh && had && (had.listed || Date.now() - had.at < 60_000)) return had.url
  let url = AGENT
  let listed = false
  try {
    const cfg = await unary(API, "aiserver.v1.ServerConfigService/GetServerConfig", tok, {}, 10_000)
    for (const raw of [cfg?.agentUrlConfig?.agentUrl, cfg?.agentUrlConfig?.agentnUrl]) {
      try {
        const u = new URL(raw)
        if ((u.protocol === "https:" || u.protocol === "http:") && u.host) {
          url = raw.replace(/\/+$/, "")
          listed = true
          break
        }
      } catch {}
    }
  } catch {}
  // A refresh that learns nothing must not replace a regional URL with the global one.
  if (!listed && fresh && had?.url) return had.url
  endpoints.set(key, { url, at: Date.now(), listed })
  return url
}

export function clearAgentCache() {
  endpoints.clear()
}

// open starts a Run at base: the session, the stream, and the response's
// headers. Waiting for those headers is capped: a server that never
// answers, or that drops the stream first, must not hold the turn open.
const HEADER_WAIT_MS = 30_000
// After at least one tool call, a stream that never closes must not pin the turn.
const TOOL_IDLE_MS = 3_000

function open(base, headers, signal, connect = defaultConnect, headerWaitMs = HEADER_WAIT_MS) {
  return new Promise((resolve) => {
    const u = new URL(base)
    if (signal?.aborted) {
      resolve({ error: { status: 499, message: "the request was cancelled" } })
      return
    }
    let session
    try {
      session = connect(u.origin)
    } catch (e) {
      resolve({ error: { status: 502, message: e?.message ?? String(e) } })
      return
    }
    let done = false
    let timer
    const fail = (e) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        session.destroy()
      } catch {}
      resolve({ error: { status: 502, message: e?.message ?? String(e) } })
    }
    const wait = Number(headerWaitMs)
    timer = setTimeout(() => fail(new Error("Cursor did not answer")), Number.isFinite(wait) && wait > 0 ? wait : HEADER_WAIT_MS)
    const closed = () => fail(new Error("the connection closed"))
    session.on("error", fail)
    session.on("close", closed)
    session.on("goaway", closed)
    const req = session.request({
      ":method": "POST",
      ":path": u.pathname.replace(/\/+$/, "") + "/agent.v1.AgentService/Run",
      ...headers,
    })
    req.on("error", fail)
    req.on("aborted", closed)
    req.on("close", closed)
    req.once("response", (h) => {
      if (done) return
      done = true
      clearTimeout(timer)
      const headersOut = {}
      for (const [k, v] of Object.entries(h ?? {})) headersOut[k] = Array.isArray(v) ? v.join(", ") : String(v ?? "")
      resolve({ session, req, status: Number(h[":status"]), headers: headersOut })
    })
    signal?.addEventListener("abort", () => fail(new Error("the request was cancelled")), { once: true })
  })
}

// runOnce is one Run of the chat on the agent API at base: an async

async function* decode(stream, { send, blobs, tools, close, toolIdleMs = TOOL_IDLE_MS }) {
  let calls = 0
  let ended = false
  let listed = 0
  // wrote: the reply's text alone; a turn of thinking only says nothing
  let wrote = 0
  let usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
  const finish = () => {
    const prompt = usage.input + usage.cacheRead + usage.cacheWrite
    return {
      stop: calls > 0 ? "tool_calls" : "stop",
      usage: {
        prompt_tokens: prompt,
        completion_tokens: usage.output,
        total_tokens: prompt + usage.output,
        prompt_tokens_details: { cached_tokens: usage.cacheRead, cache_write_tokens: usage.cacheWrite },
        ...(usage.reasoning ? { completion_tokens_details: { reasoning_tokens: usage.reasoning } } : {}),
      },
    }
  }
  const settled = () => {
    // Tools are full: cancel this Run. Their results ride the next request.
    if (calls > 0) close?.()
    return finish()
  }
  const closeExec = (id) => send(pb().bytes(5, pb().bytes(1, pb().varint(1, id))).done())
  const iter = stream[Symbol.asyncIterator]()
  let idleTimer
  const moreComing = () => calls > 0 && !(listed > 0 && calls >= listed)
  try {
    while (true) {
      const pending = iter.next().then((v) => ({ v }), (e) => ({ e }))
      let got
      if (moreComing()) {
        got = await Promise.race([
          pending,
          new Promise((resolve) => {
            idleTimer = setTimeout(() => resolve({ idle: true }), toolIdleMs)
          }),
        ])
        clearTimeout(idleTimer)
      } else got = await pending
      if (got.idle) {
        yield settled()
        return
      }
      if (got.e) throw got.e
      if (got.v.done) {
        if (calls > 0) yield settled()
        else yield { error: { status: 502, message: "the reply broke off: EOF" } }
        return
      }
      const f = got.v.value
      if (f.end) {
        const e = failure(200, f.data)
        if (e.status < 200 || e.status > 299) yield { error: e }
        else if (wrote === 0 && calls === 0) yield { error: { status: 502, message: "an empty reply" } }
        else yield await settled()
        return
      }
      for (const m of fields(f.data)) {
        switch (m.num) {
          case 1: // interaction_update
            for (const u of fields(m.data)) {
              const uf = fields(u.data)
              switch (u.num) {
                case 1: {
                  // text
                  const t = pbStr(uf, 1)
                  if (t) {
                    wrote += t.length
                    yield { text: t }
                  }
                  break
                }
                case 4: {
                  // thinking
                  const t = pbStr(uf, 1)
                  if (t) yield { reasoning: t }
                  break
                }
                case 14: // turn ended, with what it used
                  usage = usageOf(uf)
                  ended = true
                  if (calls === 0) {
                    // nothing written and nothing called: an empty reply,
                    // which the client asks again, not a finished turn
                    yield wrote === 0 ? { error: { status: 502, message: "an empty reply" } } : settled()
                    return
                  }
                  // The calls for this turn are already here. Do not wait for the stream to end.
                  yield settled()
                  return
                case 27: // how many tool calls the step makes, sent before them
                  listed = pbNum(uf, 1)
                  if (listed > 0 && calls >= listed) {
                    yield await settled()
                    return
                  }
                  break
              }
            }
            break
          case 2: {
            // exec_server_message: the server asks the client to run something
            const call = exec(m.data, tools, send, closeExec)
            if (call) yield { tool: { index: calls++, ...call } }
            if (listed > 0 && calls >= listed) {
              // every call made: the caller runs them
              yield await settled()
              return
            }
            break
          }
          case 4: {
            // kv_server_message: a blob wanted, or one to keep
            const kv = fields(m.data)
            const id = pbNum(kv, 1)
            for (const k of kv) {
              if (k.num === 2) {
                const want = field(fields(k.data), 1)?.data.toString("hex") ?? ""
                const b = blobs.get(want)
                const res = b ? pb().bytes(1, b) : pb().bytes(2, pb().str(1, "blob not found"))
                send(pb().bytes(3, pb().varint(1, id).bytes(2, res)).done())
              } else if (k.num === 3) {
                // the server's own record of the turn, not needed
                send(pb().bytes(3, pb().varint(1, id).bytes(3, EMPTY)).done())
              }
            }
            break
          }
        }
      }
    }
  } catch (e) {
    if (calls > 0 && /EOF/.test(e?.message ?? "")) {
      yield settled()
      return
    }
    yield { error: { status: 502, message: "the reply broke off: " + (e?.message ?? e) } }
  } finally {
    clearTimeout(idleTimer)
  }
}

// exec answers what the server asks the client to run: a call of the
// caller's tools is returned, the list of them is given, and anything else
// is refused.
function exec(msg, tools, send, closeExec) {
  const es = fields(msg)
  const id = pbNum(es, 1)
  const execID = pbStr(es, 15)
  const answer = (num, res) => {
    send(pb().bytes(2, pb().varint(1, id).str(15, execID).bytes(num, res)).done())
    closeExec(id)
  }
  for (const e of es) {
    switch (e.num) {
      case 11: {
        // mcp_args: a call of the caller's tools
        const a = fields(e.data)
        const args = {}
        for (const kv of a) {
          if (kv.num !== 2) continue
          const ef = fields(kv.data)
          const v = field(ef, 2)
          args[pbStr(ef, 1)] = v ? pbAny(v.data) : null
        }
        const name = pbStr(a, 5) || pbStr(a, 1).replace(/^pi-/, "")
        // an OpenAI model's id is its call's and its item's, a line apart,
        // which no caller would take as an id: the line goes as __
        const cid = pbStr(a, 3).replaceAll("\n", "__") || "call_" + randomBytes(12).toString("hex")
        if (!tools.some((t) => t.name === name)) {
          send(pb().bytes(5, pb().bytes(2, pb().varint(1, id).str(2, "not available"))).done())
          closeExec(id)
          return null
        }
        return { id: cid, name, args: JSON.stringify(args) }
      }
      case 36: {
        // mcp_state_exec_args: the tools there are
        const srv = pb().str(1, NAMESPACE).str(2, NAMESPACE).str(7, "connected")
        for (const t of tools) srv.bytes(5, toolDef(t))
        answer(36, pb().bytes(1, pb().bytes(1, srv)))
        return null
      }
      case 10: // request_context_args
        answer(10, pb().bytes(1, pb().bytes(1, pb().bytes(4, env()))))
        return null
    }
  }
  // a shell, a file read or an edit of Cursor's own: never run
  send(pb().bytes(5, pb().bytes(2, pb().varint(1, id).str(2, "not available"))).done())
  closeExec(id)
  return null
}

const maxOnly = new Set()
const maxRequired = (msg) => /max[ _]mode[ _]required|requires max mode/i.test(String(msg ?? ""))

function cursorHeaders(tok, version, extra) {
  const headers = {
    "content-type": "application/connect+proto",
    "connect-protocol-version": "1",
    authorization: `Bearer ${tok}`,
    "x-cursor-client-version": version,
    "x-cursor-client-type": "cli",
    "x-ghost-mode": "true",
    "x-request-id": randomUUID(),
    "x-cursor-agent-allowed-tools": "mcp_tool_call,get_mcp_tools_tool_call",
  }
  for (const [key, value] of Object.entries(extra ?? {})) {
    const same = Object.keys(headers).filter((k) => k.toLowerCase() === key.toLowerCase())
    if (value === null || value === undefined) {
      for (const k of same) delete headers[k]
      continue
    }
    if (same.length === 0) headers[key] = String(value)
    else for (const k of same) headers[k] = String(value)
  }
  return headers
}

async function runOnce({ tok, base, id, tools, conv, convID, signal, maxMode, params, connect, onResponse, onPayload, headers, headerWaitMs, toolIdleMs }) {
  const cid = convID || randomUUID()
  let modelId = id
  if (onPayload) {
    const replaced = await onPayload({ model: modelId, maxMode: !!maxMode, params, conversationId: cid, tools: tools.map((t) => t.name) })
    if (replaced && typeof replaced === "object" && !Buffer.isBuffer(replaced) && typeof replaced.model === "string" && replaced.model) {
      modelId = replaced.model
    }
  }
  const { first, blobs } = buildRun(conv.msgs, conv.last, tools, modelId, cid, { maxMode, params })
  const o = await open(base, cursorHeaders(tok, await clientVersion(), headers), signal, connect, headerWaitMs)
  if (o.error) return o
  if (onResponse) await onResponse({ status: o.status, headers: o.headers ?? {} })
  const { session, req } = o
  let closed = false
  const send = (msg) => {
    if (!closed && !req.destroyed && req.writable) req.write(frame(msg))
  }
  const heartbeat = setInterval(() => send(pb().bytes(7, EMPTY).done()), 5000)
  heartbeat.unref?.()
  const close = () => {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    try {
      req.close(http2.constants.NGHTTP2_CANCEL)
    } catch {}
    try {
      session.close()
    } catch {}
    setTimeout(() => {
      try {
        session.destroy()
      } catch {}
    }, 1000).unref?.()
  }
  signal?.addEventListener("abort", close, { once: true })
  send(first)
  if (o.status < 200 || o.status > 299) {
    const chunks = []
    try {
      for await (const c of req) chunks.push(c)
    } catch {}
    close()
    return { error: failure(o.status, Buffer.concat(chunks).toString("utf8").slice(0, 1 << 20)) }
  }
  const it = decode(frames(req), { send, blobs, tools, close, toolIdleMs })
  const wrapped = (async function* () {
    try {
      yield* it
    } finally {
      close()
    }
  })()
  const head = await wrapped.next()
  if (head.done) return { error: { status: 502, message: "an empty reply" } }
  if (head.value?.error) {
    await wrapped.return?.()
    return { error: head.value.error }
  }
  return {
    conversationId: cid,
    events: (async function* () {
      try {
        yield head.value
        yield* wrapped
      } finally {
        await wrapped.return?.()
      }
    })(),
  }
}

export function clearMaxOnly() {
  maxOnly.clear()
}

/** One user-visible turn. A regional miss retries once, and only when the agent URL changed. */
export async function runAnswer({
  tok,
  model,
  effort = "",
  fast,
  messages,
  tools = [],
  session = "",
  signal,
  connect,
  resolveAgentURL = agentURL,
  rawModels,
  onResponse,
  onPayload,
  headers,
  headerWaitMs = HEADER_WAIT_MS,
  toolIdleMs = TOOL_IDLE_MS,
}: {
  tok: string
  model?: string
  effort?: string
  fast?: boolean
  messages?: unknown[]
  tools?: { name: string; description?: string; schema?: unknown }[]
  session?: string
  signal?: AbortSignal
  connect?: (origin: string) => unknown
  resolveAgentURL?: (tok: string, fresh: boolean) => Promise<string> | string
  rawModels?: unknown
  onResponse?: (response: { status: number; headers: Record<string, string> }) => unknown
  onPayload?: (payload: unknown) => unknown
  headers?: Record<string, string | null | undefined>
  headerWaitMs?: number
  toolIdleMs?: number
}): Promise<{
  error?: { status?: number; message?: string }
  conversationId?: string
  events?: AsyncIterable<{
    text?: string
    reasoning?: string
    tool?: { id: string; name: string; args: string }
    stop?: string
    usage?: {
      prompt_tokens?: number
      completion_tokens?: number
      prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number }
      completion_tokens_details?: { reasoning_tokens?: number }
    }
    error?: { status?: number; message?: string }
  }>
}> {
  const chat = {
    model,
    messages,
    reasoning_effort: effort,
    ...(fast === true ? { service_tier: "fast" } : fast === false ? { service_tier: "default" } : {}),
    tools: tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description ?? "",
        parameters: t.schema ?? { type: "object", properties: {} },
      },
    })),
  }
  let raw = rawModels
  if (raw === undefined) {
    try {
      raw = await usable(tok)
    } catch {
      raw = []
    }
  }
  const resolved = resolveModel(raw, String(model ?? ""), effort, fast)
  let id = resolved.id
  let params = resolved.params
  let maxMode = resolved.maxMode || maxOnly.has(id)
  const listed = toolsOf(chat)
  const conv = conversation(chat, listed)
  const convID = conversationID(chat, sessionOf({ sessionID: session }))
  let base = await resolveAgentURL(tok, false)
  const once = () => runOnce({ tok, base, id, tools: listed, conv, convID, signal, maxMode, params, connect, onResponse, onPayload, headers, headerWaitMs, toolIdleMs })
  let ran = await once()
  if (ran.error && regional(ran.error.message)) {
    const fresh = await resolveAgentURL(tok, true)
    if (fresh !== base) {
      base = fresh
      ran = await once()
    }
  }
  if (ran.error && !maxMode && maxRequired(ran.error.message)) {
    maxMode = true
    maxOnly.add(id)
    ran = await once()
  }
  return ran
}
