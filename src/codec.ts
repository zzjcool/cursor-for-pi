/**
 * Hand-written protobuf and Connect framing for Cursor AgentService/Run.
 *
 * Ported from magpie's Cursor provider (MIT):
 * https://github.com/magpie-community/plugins/tree/main/packages/cursor
 * which itself was ported from magpie's Go client (internal/provider/cursor*.go).
 */
// @ts-nocheck
import { STATUS_CODES } from "node:http"
import { gunzipSync } from "node:zlib"

export const EMPTY = Buffer.alloc(0)

const statusText = (s) =>
  ({ 413: "Request Entity Too Large", 414: "Request URI Too Long", 416: "Requested Range Not Satisfiable", 418: "I'm a teapot", 509: "" })[s] ?? STATUS_CODES[s] ?? ""

export class PB {
  parts = []
  push(b) {
    this.parts.push(b)
    return this
  }
  uv(v) {
    const out = []
    while (v >= 0x80) {
      out.push((v % 128) | 0x80)
      v = Math.floor(v / 128)
    }
    out.push(v)
    return this.push(Uint8Array.from(out))
  }
  tag(num, wire) {
    return this.uv(num * 8 + wire)
  }
  varint(num, v) {
    return this.tag(num, 0).uv(v)
  }
  bytes(num, v) {
    const b = v instanceof PB ? v.done() : v ?? EMPTY
    return this.tag(num, 2).uv(b.length).push(b)
  }
  str(num, s) {
    return this.bytes(num, Buffer.from(s, "utf8"))
  }
  double(num, v) {
    const b = Buffer.alloc(8)
    b.writeDoubleLE(v)
    return this.tag(num, 1).push(b)
  }
  done() {
    return Buffer.concat(this.parts)
  }
}
export const pb = () => new PB()

// fields reads a message's fields; a malformed tail is dropped.
export function fields(b) {
  b = Buffer.isBuffer(b) ? b : Buffer.from(b ?? EMPTY)
  const out = []
  let i = 0
  const uv = () => {
    let v = 0
    let m = 1
    while (i < b.length) {
      const c = b[i++]
      v += (c & 0x7f) * m
      if (c < 0x80) return v
      m *= 128
    }
    return -1
  }
  while (i < b.length) {
    const key = uv()
    if (key < 0) break
    const f = { num: Math.floor(key / 8), wire: key % 8, n: 0, data: EMPTY }
    switch (f.wire) {
      case 0: {
        const v = uv()
        if (v < 0) return out
        f.n = v
        break
      }
      case 1:
        if (i + 8 > b.length) return out
        f.data = b.subarray(i, i + 8)
        f.n = Number(b.readBigUInt64LE(i))
        i += 8
        break
      case 2: {
        const l = uv()
        if (l < 0 || i + l > b.length) return out
        f.data = b.subarray(i, i + l)
        i += l
        break
      }
      case 5:
        if (i + 4 > b.length) return out
        f.n = b.readUInt32LE(i)
        i += 4
        break
      default:
        return out
    }
    out.push(f)
  }
  return out
}

export const field = (fs, num) => fs.find((f) => f.num === num)
export const pbStr = (fs, num) => field(fs, num)?.data.toString("utf8") ?? ""
export const pbNum = (fs, num) => field(fs, num)?.n ?? 0

// pbValue is a google.protobuf.Value.
export function pbValue(v) {
  if (v === null || v === undefined) return pb().varint(1, 0)
  if (typeof v === "number") return pb().double(2, v)
  if (typeof v === "string") return pb().str(3, v)
  if (typeof v === "boolean") return pb().varint(4, v ? 1 : 0)
  if (Array.isArray(v)) {
    const l = pb()
    for (const e of v) l.bytes(1, pbValue(e))
    return pb().bytes(6, l)
  }
  if (typeof v === "object") {
    const st = pb()
    for (const k of Object.keys(v).sort()) st.bytes(1, pb().str(1, k).bytes(2, pbValue(v[k])))
    return pb().bytes(5, st)
  }
  return pb().varint(1, 0)
}

// pbAny reads a google.protobuf.Value.
export function pbAny(b) {
  for (const f of fields(b)) {
    switch (f.num) {
      case 1:
        return null
      case 2:
        return f.data.length === 8 ? f.data.readDoubleLE(0) : 0
      case 3:
        return f.data.toString("utf8")
      case 4:
        return f.n !== 0
      case 5: {
        const m = {}
        for (const e of fields(f.data)) {
          if (e.num !== 1) continue
          const kv = fields(e.data)
          const v = field(kv, 2)
          m[pbStr(kv, 1)] = v ? pbAny(v.data) : null
        }
        return m
      }
      case 6:
        return fields(f.data).filter((e) => e.num === 1).map((e) => pbAny(e.data))
    }
  }
  return null
}

// frame wraps a message as one frame of a Connect stream.
export function frame(msg) {
  const head = Buffer.alloc(5)
  head.writeUInt32BE(msg.length, 1)
  return Buffer.concat([head, msg])
}

// frames reads a Connect stream's frames: a message, or the stream's end
// with its JSON.
export async function* frames(body) {
  let buf = EMPTY
  for await (const chunk of body) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk)
    while (buf.length >= 5) {
      const n = buf.readUInt32BE(1)
      if (n > 64 << 20) throw new Error("a malformed stream")
      if (buf.length < 5 + n) break
      const flags = buf[0]
      let data = buf.subarray(5, 5 + n)
      buf = buf.subarray(5 + n)
      if (flags & 1) data = gunzipSync(data)
      yield { end: (flags & 2) !== 0, data }
    }
  }
  if (buf.length) throw new Error("unexpected EOF")
}

// ---- failures -----------------------------------------------------------------------

export const regional = (msg) => msg.toLowerCase().includes("region")

// failure is the status and message for Cursor's Connect error, whose
// details say it best: {"code", "message", "details": [{"debug": {"error",
// "details": {"title", "detail"}}}]}, or the same under "error" at a
// stream's end.
export function failure(status, text) {
  let e
  try {
    e = JSON.parse(typeof text === "string" ? text : Buffer.from(text).toString("utf8"))
  } catch {
    return statusOf(status, "", String(text ?? "").trim())
  }
  const f = e?.error && typeof e.error === "object" ? e.error : e ?? {}
  let msg = f.message ?? ""
  for (const d of f.details ?? []) {
    const t = `${d?.debug?.details?.title ?? ""}: ${d?.debug?.details?.detail ?? ""}`.trim()
    if (t !== ":") msg = t.replace(/^[:\s]+|[:\s]+$/g, "")
  }
  if (!msg || msg === "Error") msg = f.code ?? ""
  if (!f.code && status >= 200 && status < 300) return { status, message: msg } // a stream that ended well
  return statusOf(status, f.code ?? "", msg)
}

// statusOf is the status and words for Cursor's error of this code and
// message. A region the team isn't served in says so, not to sign in.
export function statusOf(status, code, msg) {
  msg ||= statusText(status)
  const low = msg.toLowerCase()
  // magpie names the provider before the message itself
  const out = (status, message) => ({ status, message })
  if (regional(msg)) return out(403, msg + " — Cursor serves your team only in some regions and turned this request away; signing in again won't change that")
  if (code === "permission_denied") return out(403, msg)
  if (code === "unauthenticated" || status === 401 || low.includes("expired"))
    return out(401, msg + " — sign in to Cursor again with /login cursor")
  if (code === "resource_exhausted" || low.includes("quota") || low.includes("rate limit") || low.includes("usage limit"))
    return out(429, "usage limit reached: " + msg)
  if (low.includes("too long") || low.includes("context length") || low.includes("too many tokens"))
    return out(400, "input is too long for the model's context: " + msg)
  if (code === "invalid_argument") return out(400, msg)
  if (code === "unavailable") return out(503, msg)
  if (code) return out(502, msg)
  return out(status, msg)
}

// ---- the conversation -------------------------------------------------------------
