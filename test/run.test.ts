import assert from "node:assert/strict"
import http2 from "node:http2"
import { test } from "node:test"
import { field, fields, frame, pb, pbNum, pbStr, pbValue } from "../src/codec.ts"
import { agentURL, clearAgentCache, clearMaxOnly, conversationID, runAnswer } from "../src/run.ts"

const TOKEN = "t".repeat(24)
const CANCEL = http2.constants.NGHTTP2_CANCEL

function textFrame(text: string) {
  return frame(pb().bytes(1, pb().bytes(1, pb().str(1, text))).done())
}
function thinkingFrame(text: string) {
  return frame(pb().bytes(1, pb().bytes(4, pb().str(1, text))).done())
}
function listedFrame(count: number) {
  return frame(pb().bytes(1, pb().bytes(27, pb().varint(1, count))).done())
}
function mcpFrame(name: string, args: Record<string, string>, callId = "call_test") {
  const body = pb().str(5, name).str(3, callId)
  for (const [key, value] of Object.entries(args)) body.bytes(2, pb().str(1, key).bytes(2, pbValue(value)))
  return frame(pb().bytes(2, pb().varint(1, 7).bytes(11, body)).done())
}
function nativeFrame(command: string) {
  return frame(pb().bytes(2, pb().varint(1, 9).bytes(2, pb().str(1, command))).done())
}
function turnEndedFrame() {
  return frame(pb().bytes(1, pb().bytes(14, pb().varint(1, 12).varint(2, 3))).done())
}
function endFrame() {
  const msg = Buffer.from("{}")
  const head = Buffer.alloc(5)
  head[0] = 2
  head.writeUInt32BE(msg.length, 1)
  return Buffer.concat([head, msg])
}

interface Scene {
  status?: number
  chunks?: Buffer[]
  /** Keep the stream open after the chunks, as a server that does not hang up. */
  hold?: boolean
}

function install(scenes: Scene[]) {
  const calls: { origin: string; writes: Buffer[]; closes: unknown[]; sessionClosed: boolean; headers?: Record<string, unknown> }[] = []
  let n = 0
  const connect = (origin: string) => {
    const scene = scenes[Math.min(n, scenes.length - 1)] ?? {}
    n += 1
    const rec: { origin: string; writes: Buffer[]; closes: unknown[]; sessionClosed: boolean; headers?: Record<string, unknown> } = {
      origin,
      writes: [],
      closes: [],
      sessionClosed: false,
    }
    calls.push(rec)
    const req = {
      destroyed: false,
      writable: true,
      write(buf: Uint8Array) {
        rec.writes.push(Buffer.from(buf))
      },
      close(code: unknown) {
        rec.closes.push(code)
        this.writable = false
      },
      on() {
        return this
      },
      once(event: string, cb: (headers: Record<string, unknown>) => void) {
        if (event === "response") queueMicrotask(() => cb({ ":status": scene.status ?? 200 }))
        return this
      },
      async *[Symbol.asyncIterator]() {
        for (const chunk of scene.chunks ?? []) yield chunk
        if (scene.hold) await new Promise(() => {})
      },
    }
    return {
      request(headers: Record<string, unknown>) {
        rec.headers = headers
        return req
      },
      on() {
        return this
      },
      close() {
        rec.sessionClosed = true
      },
      destroy() {},
    }
  }
  return { connect, calls }
}

const readTool = {
  name: "read",
  description: "Read a file",
  schema: { type: "object", properties: { path: { type: "string" } } },
}

async function ask(opts: Record<string, unknown>) {
  clearMaxOnly()
  const ran = await runAnswer({
    tok: TOKEN,
    model: "grok-4.7",
    messages: [{ role: "user", content: "hi" }],
    tools: [readTool],
    session: "sess-1",
    rawModels: [],
    resolveAgentURL: async () => "https://agent.example",
    ...opts,
  })
  if (ran.error || !ran.events) return { error: ran.error, events: [] as Record<string, unknown>[] }
  const events: Record<string, unknown>[] = []
  for await (const event of ran.events) events.push(event)
  return { error: undefined, events }
}

function written(calls: { writes: Buffer[] }[]) {
  return Buffer.concat(calls.flatMap((call) => call.writes))
}

function conversationOnWire(buf: Buffer) {
  const rr = field(fields(buf.subarray(5)), 1)
  return pbStr(fields(rr?.data ?? Buffer.alloc(0)), 5)
}

function maxModeOn(buf: Buffer) {
  const rr = field(fields(buf.subarray(5)), 1)
  const details = field(fields(rr?.data ?? Buffer.alloc(0)), 3)
  return pbNum(fields(details?.data ?? Buffer.alloc(0)), 7)
}

test("conversation id follows the session and the first user message", () => {
  const chat = (content: string, extra?: Record<string, unknown>) => ({
    messages: [
      { role: "system", content: "ignored" },
      { role: "user", content, ...extra },
    ],
  })
  const first = conversationID(chat("hello"), "sess-1")
  const same = conversationID(chat("hello", { timestamp: 1 }), "sess-1")
  const changed = conversationID(chat("hello!"), "sess-1")
  assert.equal(first, same)
  assert.notEqual(first, changed)
  assert.equal(conversationID(chat("hello"), ""), "")
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})

test("text, thinking, and one tool call cancel the run", async () => {
  const fake = install([
    {
      chunks: [thinkingFrame("hmm"), textFrame("hello"), listedFrame(1), mcpFrame("read", { path: "a.ts" })],
    },
  ])
  let status = 0
  const ran = await ask({ connect: fake.connect, onResponse: (response: { status: number }) => (status = response.status) })
  assert.equal(status, 200)
  const tool = ran.events.find((event) => event.tool)?.tool as { id?: string; name?: string; args?: string } | undefined
  assert.equal(ran.events.some((event) => event.reasoning === "hmm"), true)
  assert.equal(ran.events.some((event) => event.text === "hello"), true)
  assert.equal(tool?.id, "call_test")
  assert.equal(tool?.name, "read")
  assert.equal(tool?.args, JSON.stringify({ path: "a.ts" }))
  assert.equal(ran.events.at(-1)?.stop, "tool_calls")
  assert.equal(fake.calls.length, 1)
  assert.ok(fake.calls[0]?.closes.includes(CANCEL))
  assert.equal(fake.calls[0]?.sessionClosed, true)
  const body = written(fake.calls).toString("utf8")
  assert.equal(body.includes("tool-result"), false)
  assert.equal(body.includes("not available"), false)
  assert.equal(fake.calls[0]?.writes.length, 1)
})

test("a later turn keeps history in the request and does not write the new tool result back", async () => {
  const writes: Buffer[] = []
  const closes: unknown[] = []
  let sessionClosed = false
  const connect = () => {
    const req = {
      destroyed: false,
      writable: true,
      write(buf: Uint8Array) {
        writes.push(Buffer.from(buf))
      },
      close(code: unknown) {
        closes.push(code)
        this.writable = false
      },
      on() {
        return this
      },
      once(event: string, cb: (headers: Record<string, unknown>) => void) {
        if (event === "response") queueMicrotask(() => cb({ ":status": 200 }))
        return this
      },
      async *[Symbol.asyncIterator]() {
        const first = writes[0] ?? Buffer.alloc(0)
        const hashes: Buffer[] = []
        for (let i = 0; i + 34 <= first.length; i++) {
          if (first[i] !== 0x0a || first[i + 1] !== 0x20) continue
          hashes.push(first.subarray(i + 2, i + 34))
          i += 33
        }
        for (const [n, hash] of hashes.entries()) {
          yield frame(pb().bytes(4, pb().varint(1, n + 1).bytes(2, pb().bytes(1, hash))).done())
        }
        yield listedFrame(1)
        yield mcpFrame("read", { path: "b.ts" }, "call_next")
      },
    }
    return {
      request() {
        return req
      },
      on() {
        return this
      },
      close() {
        sessionClosed = true
      },
      destroy() {},
    }
  }
  const ran = await ask({
    connect,
    messages: [
      { role: "user", content: "look" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_prev", type: "function", function: { name: "read", arguments: "{\"path\":\"a.ts\"}" } }],
      },
      { role: "tool", tool_call_id: "call_prev", content: "alpha contents" },
      { role: "user", content: "again" },
    ],
  })
  const blobs = Buffer.concat(writes.slice(1)).toString("utf8")
  assert.match(blobs, /alpha contents/)
  assert.match(blobs, /tool-result/)
  assert.equal(blobs.includes("call_next"), false)
  assert.equal(ran.events.some((event) => (event.tool as { id?: string } | undefined)?.id === "call_next"), true)
  assert.ok(closes.includes(CANCEL))
  assert.equal(sessionClosed, true)
})

test("native shell is refused and not turned into a tool call", async () => {
  const fake = install([{ chunks: [textFrame("no"), nativeFrame("node -e process.exit(1)"), endFrame()] }])
  const ran = await ask({ connect: fake.connect, tools: [readTool] })
  assert.equal(ran.events.some((event) => event.tool), false)
  assert.equal(ran.events.at(-1)?.stop, "stop")
  assert.match(written(fake.calls).toString("utf8"), /not available/)
  assert.ok(fake.calls[0]?.closes.includes(CANCEL))
})

test("a region error retries only when the agent url changes", async () => {
  const denied = { status: 403, chunks: [Buffer.from(JSON.stringify({ message: "not served in this region" }))] }
  const ok = { chunks: [textFrame("moved"), endFrame()] }
  const same = install([denied, ok])
  const sameResult = await ask({ connect: same.connect, resolveAgentURL: async () => "https://agent.example" })
  assert.equal(same.calls.length, 1)
  assert.match(String(sameResult.error?.message ?? ""), /region/i)

  const fresh: boolean[] = []
  const moved = install([denied, ok])
  const movedResult = await ask({
    connect: moved.connect,
    resolveAgentURL: async (_tok: string, isFresh: boolean) => {
      fresh.push(isFresh)
      return isFresh ? "https://agent-eu.example" : "https://agent.example"
    },
  })
  assert.deepEqual(fresh, [false, true])
  assert.deepEqual(
    moved.calls.map((call) => call.origin),
    ["https://agent.example", "https://agent-eu.example"],
  )
  assert.equal(movedResult.events.at(-1)?.stop, "stop")
  assert.equal(movedResult.events.some((event) => event.text === "moved"), true)
})

test("max mode required retries the same run once", async () => {
  const fake = install([
    { status: 400, chunks: [Buffer.from(JSON.stringify({ message: "max mode required" }))] },
    { chunks: [textFrame("max"), endFrame()] },
  ])
  const ran = await ask({ connect: fake.connect, resolveAgentURL: async () => "https://agent.example" })
  assert.equal(fake.calls.length, 2)
  assert.equal(ran.events.some((event) => event.text === "max"), true)
})

test("a stream that closes before response headers fails", async () => {
  const connect = () => {
    const sessionHandlers: Record<string, Array<() => void>> = {}
    const session = {
      request() {
        return {
          destroyed: false,
          writable: true,
          write() {},
          close() {},
          on() {
            return this
          },
          once() {
            return this
          },
          async *[Symbol.asyncIterator]() {},
        }
      },
      on(event: string, cb: () => void) {
        ;(sessionHandlers[event] ??= []).push(cb)
        return this
      },
      close() {},
      destroy() {},
    }
    queueMicrotask(() => {
      for (const cb of sessionHandlers.close ?? []) cb()
    })
    return session
  }
  const ran = await ask({ connect, headerWaitMs: 5_000 })
  assert.match(String(ran.error?.message ?? ""), /connection closed/)
  assert.equal(ran.events.length, 0)
})

test("missing response headers fail when the wait ends", async () => {
  const connect = () => ({
    request() {
      return {
        destroyed: false,
        writable: true,
        write() {},
        close() {},
        on() {
          return this
        },
        once() {
          return this
        },
        async *[Symbol.asyncIterator]() {},
      }
    },
    on() {
      return this
    },
    close() {},
    destroy() {},
  })
  const ran = await ask({ connect, headerWaitMs: 40 })
  assert.match(String(ran.error?.message ?? ""), /did not answer/)
  assert.equal(ran.events.length, 0)
})

test("conversation id is the same value that is sent", async () => {
  const golden = conversationID({ messages: [{ role: "user", content: "hello" }] }, "sess-1")
  assert.equal(golden, "0cecbb78-d302-4668-92b6-ed08ea256b22")
  const fake = install([
    { chunks: [textFrame("a"), endFrame()] },
    { chunks: [textFrame("b"), endFrame()] },
    { chunks: [textFrame("c"), endFrame()] },
    { chunks: [textFrame("d"), endFrame()] },
  ])
  const same = { connect: fake.connect, messages: [{ role: "user", content: "hello" }] }
  await ask({ ...same, session: "sess-1" })
  await ask({ ...same, session: "sess-1" })
  await ask({ ...same, session: "sess-2" })
  await ask({ ...same, session: "" })
  const ids = fake.calls.map((call) => conversationOnWire(call.writes[0] ?? Buffer.alloc(0)))
  assert.equal(ids[0], golden)
  assert.equal(ids[1], golden)
  assert.notEqual(ids[2], golden)
  assert.notEqual(ids[3], ids[0])
  assert.match(ids[3] ?? "", /^[0-9a-f]{8}-/)
})

test("a counted tool call cancels the run while the server stays open", async () => {
  const fake = install([{ chunks: [listedFrame(1), mcpFrame("read", { path: "a.ts" })], hold: true }])
  const ran = await Promise.race([
    ask({ connect: fake.connect, toolIdleMs: 10_000 }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("hung")), 400)),
  ])
  assert.equal(ran.events.at(-1)?.stop, "tool_calls")
  assert.ok(fake.calls[0]?.closes.includes(CANCEL))
})

test("turn ended after a tool call cancels the run", async () => {
  const fake = install([{ chunks: [mcpFrame("read", { path: "a.ts" }), turnEndedFrame()], hold: true }])
  const ran = await Promise.race([
    ask({ connect: fake.connect, toolIdleMs: 10_000 }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("hung")), 400)),
  ])
  assert.equal(ran.events.at(-1)?.stop, "tool_calls")
  assert.ok(fake.calls[0]?.closes.includes(CANCEL))
})

test("a quiet stream after a tool call still ends the run", async () => {
  const fake = install([{ chunks: [mcpFrame("read", { path: "a.ts" })], hold: true }])
  const ran = await ask({ connect: fake.connect, toolIdleMs: 40 })
  assert.equal(ran.events.at(-1)?.stop, "tool_calls")
  assert.ok(fake.calls[0]?.closes.includes(CANCEL))
})

test("a quiet stream after only some of the listed calls still ends the run", async () => {
  const fake = install([{ chunks: [listedFrame(2), mcpFrame("read", { path: "a.ts" })], hold: true }])
  const ran = await ask({ connect: fake.connect, toolIdleMs: 40 })
  assert.equal(ran.events.filter((event) => event.tool).length, 1)
  assert.equal(ran.events.at(-1)?.stop, "tool_calls")
  assert.ok(fake.calls[0]?.closes.includes(CANCEL))
})

test("an unknown tool name is refused", async () => {
  const fake = install([{ chunks: [mcpFrame("not-registered", { path: "a.ts" }), endFrame()] }])
  const ran = await ask({ connect: fake.connect })
  assert.equal(ran.events.some((event) => event.tool), false)
  assert.match(written(fake.calls).toString("utf8"), /not available/)
})

test("request headers match the cursor cli", async () => {
  const fake = install([
    { chunks: [textFrame("a"), endFrame()] },
    { chunks: [textFrame("b"), endFrame()] },
  ])
  await ask({ connect: fake.connect })
  await ask({ connect: fake.connect })
  const headers = fake.calls[0]?.headers ?? {}
  assert.equal(headers[":path"], "/agent.v1.AgentService/Run")
  assert.equal(headers[":method"], "POST")
  assert.equal(headers["content-type"], "application/connect+proto")
  assert.equal(headers["connect-protocol-version"], "1")
  assert.equal(headers["x-cursor-client-type"], "cli")
  assert.equal(headers["x-ghost-mode"], "true")
  assert.equal(headers["x-cursor-agent-allowed-tools"], "mcp_tool_call,get_mcp_tools_tool_call")
  assert.match(String(headers["x-cursor-client-version"]), /^cli-/)
  assert.match(String(headers.authorization), /^Bearer /)
  assert.notEqual(headers["x-request-id"], fake.calls[1]?.headers?.["x-request-id"])
})

test("heartbeat is one empty field every five seconds and stops when the run closes", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] })
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const writes: Buffer[] = []
  const connect = () => ({
    request() {
      return {
        destroyed: false,
        writable: true,
        write(buf: Uint8Array) {
          writes.push(Buffer.from(buf))
        },
        close() {
          this.writable = false
        },
        on() {
          return this
        },
        once(event: string, cb: (headers: Record<string, unknown>) => void) {
          if (event === "response") queueMicrotask(() => cb({ ":status": 200 }))
          return this
        },
        async *[Symbol.asyncIterator]() {
          await gate
          yield textFrame("ok")
          yield endFrame()
        },
      }
    },
    on() {
      return this
    },
    close() {},
    destroy() {},
  })
  const pending = ask({ connect, toolIdleMs: 60_000 })
  const beat = frame(pb().bytes(7, Buffer.alloc(0)).done())
  await new Promise<void>((resolve, reject) => {
    const start = Date.now()
    const look = () => {
      if (writes.length > 0) resolve()
      else if (Date.now() - start > 2_000) reject(new Error("the request was not sent"))
      else setTimeout(look, 5)
    }
    look()
  })
  t.mock.timers.tick(5_000)
  assert.equal(writes.filter((buf) => buf.equals(beat)).length, 1)
  const atBeat = writes.length
  release()
  await pending
  t.mock.timers.tick(10_000)
  assert.equal(writes.length, atBeat)
  assert.equal(writes.filter((buf) => buf.equals(beat)).length, 1)
})

test("max mode retry sets max mode on the second request", async () => {
  const fake = install([
    { status: 400, chunks: [Buffer.from(JSON.stringify({ message: "max mode required" }))] },
    { chunks: [textFrame("max"), endFrame()] },
  ])
  await ask({ connect: fake.connect })
  assert.equal(maxModeOn(fake.calls[0]?.writes[0] ?? Buffer.alloc(0)), 0)
  assert.equal(maxModeOn(fake.calls[1]?.writes[0] ?? Buffer.alloc(0)), 1)
})

test("a failed agent url refresh keeps the regional address", async () => {
  clearAgentCache()
  const original = globalThis.fetch
  let fail = false
  globalThis.fetch = (async () => {
    if (fail) return new Response("no", { status: 500 })
    return new Response(JSON.stringify({ agentUrlConfig: { agentUrl: "https://eu.example/" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch
  try {
    assert.equal(await agentURL(TOKEN, false), "https://eu.example")
    fail = true
    assert.equal(await agentURL(TOKEN, true), "https://eu.example")
    assert.equal(await agentURL(TOKEN, false), "https://eu.example")
  } finally {
    globalThis.fetch = original
    clearAgentCache()
  }
})

test("stopping after the first event still cancels the run", async () => {
  const fake = install([{ chunks: [textFrame("hi")], hold: true }])
  clearMaxOnly()
  const ran = await runAnswer({
    tok: TOKEN,
    model: "grok-4.7",
    messages: [{ role: "user", content: "hi" }],
    tools: [readTool],
    session: "sess-1",
    rawModels: [],
    resolveAgentURL: async () => "https://agent.example",
    connect: fake.connect,
    toolIdleMs: 10_000,
  })
  const iter = ran.events?.[Symbol.asyncIterator]()
  assert.ok(iter)
  const first = await iter.next()
  assert.equal(first.value?.text, "hi")
  await iter.return?.()
  assert.ok(fake.calls[0]?.closes.includes(CANCEL))
})
