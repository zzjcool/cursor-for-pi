import assert from "node:assert/strict"
import { test } from "node:test"
import { createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai"
import { emitCursorEvents } from "../src/pi-stream.ts"

const model = {
  id: "grok-4.7",
  name: "Grok 4.7",
  api: "cursor-run",
  provider: "cursor",
  baseUrl: "https://agentn.global.api5.cursor.sh",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 32_000,
} as Model<"cursor-run">

test("a tool call ends the pi stream with toolUse", async () => {
  const stream = createAssistantMessageEventStream()
  const done = emitCursorEvents(stream, model, (async function* () {
    yield { reasoning: "hmm" }
    yield { text: "hello" }
    yield { tool: { id: "call_test", name: "read", args: JSON.stringify({ path: "a.ts" }) } }
    yield {
      stop: "tool_calls",
      usage: { prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 2, cache_write_tokens: 1 } },
    }
  })())
  const types: string[] = []
  for await (const event of stream) types.push(event.type)
  await done
  const message = await stream.result()
  assert.equal(types[0], "start")
  assert.equal(types.at(-1), "done")
  assert.equal(types.includes("error"), false)
  assert.ok(types.indexOf("text_start") < types.indexOf("toolcall_start"))
  assert.equal(message.stopReason, "toolUse")
  assert.equal(message.content.some((part) => part.type === "thinking" && part.thinking === "hmm"), true)
  assert.equal(message.content.some((part) => part.type === "text" && part.text === "hello"), true)
  const call = message.content.find((part) => part.type === "toolCall")
  assert.equal(call?.type === "toolCall" && call.name, "read")
  assert.deepEqual(call?.type === "toolCall" ? call.arguments : {}, { path: "a.ts" })
  assert.equal(message.usage.input, 7)
  assert.equal(message.usage.cacheRead, 2)
  assert.equal(message.usage.cacheWrite, 1)
  assert.equal(message.usage.output, 4)
})
