/**
 * Cursor Run events as a Pi assistant stream.
 *
 * Tool calls stop the Run. Pi executes them and the next request carries the
 * results. This file does not write a tool result back to the open stream.
 */
import {
  calculateCost,
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
} from "@earendil-works/pi-ai"
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Model,
  SimpleStreamOptions,
  StopReason,
  TextContent,
  ThinkingContent,
  ToolCall,
  TranscriptContext,
  Usage,
} from "@earendil-works/pi-ai"
import { resolveAccessToken } from "./auth.ts"
import { runAnswer } from "./run.ts"

type RunTool = { id: string; name: string; args: string }
type RunUsage = {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}
type RunEvent = {
  text?: string
  reasoning?: string
  tool?: RunTool
  stop?: string
  usage?: RunUsage
  error?: { status?: number; message?: string }
}

function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

function blank(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: zeroUsage(),
    stopReason: "pending",
    timestamp: Date.now(),
  }
}

function normalizeError(message: string): string {
  const text = message || "Cursor request failed"
  if (/rate limit|too many requests|usage limit/i.test(text)) return text
  if (/context[_ ]length[_ ]exceeded|too many tokens|prompt (?:is )?too long|exceeds the context window|input is too long/i.test(text)) {
    return /context[_ ]length[_ ]exceeded/i.test(text) ? text : `context_length_exceeded: ${text}`
  }
  return text
}

function toolArguments(raw: string): ToolCall["arguments"] {
  try {
    const value = JSON.parse(raw || "{}") as unknown
    if (value && typeof value === "object" && !Array.isArray(value)) return value as ToolCall["arguments"]
  } catch {
    // The model handed back arguments that are not a JSON object.
  }
  return {}
}

function toChat(messages: TranscriptContext["messages"], system: string) {
  const out: Record<string, unknown>[] = []
  if (system) out.push({ role: "system", content: system })
  for (const message of messages) {
    if (message.role === "system") continue
    if (message.role === "user") {
      if (typeof message.content === "string") {
        out.push({ role: "user", content: message.content })
        continue
      }
      const parts: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = []
      for (const part of message.content) {
        if (part.type === "text" && part.text) parts.push({ type: "text", text: part.text })
        else if (part.type === "image") {
          const data = part.data.startsWith("data:") ? part.data : `data:${part.mimeType};base64,${part.data}`
          parts.push({ type: "image_url", image_url: { url: data } })
        }
      }
      if (parts.length) out.push({ role: "user", content: parts })
      continue
    }
    if (message.role === "assistant") {
      const text = message.content.filter((part): part is TextContent => part.type === "text").map((part) => part.text).join("")
      const toolCalls = message.content.filter((part): part is ToolCall => part.type === "toolCall").map((part) => ({
        id: part.id,
        type: "function",
        function: { name: part.name, arguments: JSON.stringify(part.arguments ?? {}) },
      }))
      if (!text && toolCalls.length === 0) continue
      out.push({ role: "assistant", content: text, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) })
      continue
    }
    if (message.role === "toolResult") {
      const text = message.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("")
      out.push({ role: "tool", tool_call_id: message.toolCallId, content: text })
    }
  }
  return out
}

function applyUsage(message: AssistantMessage, model: Model<Api>, usage: RunUsage | undefined) {
  const cacheRead = usage?.prompt_tokens_details?.cached_tokens ?? 0
  const cacheWrite = usage?.prompt_tokens_details?.cache_write_tokens ?? 0
  const prompt = usage?.prompt_tokens ?? 0
  const output = usage?.completion_tokens ?? 0
  const input = Math.max(prompt - cacheRead - cacheWrite, 0)
  const reasoning = usage?.completion_tokens_details?.reasoning_tokens
  message.usage = {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    ...(typeof reasoning === "number" ? { reasoning } : {}),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
  calculateCost(model, message.usage)
}

/** Map one Run's decoded events onto a Pi assistant stream. `start` is emitted here. */
export async function emitCursorEvents(
  stream: AssistantMessageEventStream,
  model: Model<Api>,
  events: AsyncIterable<RunEvent>,
  options?: SimpleStreamOptions,
): Promise<void> {
  const message = blank(model)
  if (options?.reasoning) message.thinkingLevel = options.reasoning
  let finished = false
  let open: { kind: "text" | "thinking"; index: number } | null = null

  const push = (event: AssistantMessageEvent) => {
    if (finished) return
    if (event.type === "done" || event.type === "error") finished = true
    stream.push(event)
  }
  const endOpen = () => {
    if (!open) return
    const block = message.content[open.index]
    if (block?.type === "text") push({ type: "text_end", contentIndex: open.index, content: block.text, partial: message })
    if (block?.type === "thinking") {
      push({ type: "thinking_end", contentIndex: open.index, content: block.thinking, partial: message })
    }
    open = null
  }
  const fail = (reason: Extract<StopReason, "error" | "aborted">, text: string) => {
    if (finished) return
    endOpen()
    message.stopReason = reason
    message.errorMessage = text
    push({ type: "error", reason, error: message })
  }

  push({ type: "start", partial: message })
  try {
    let sawTool = false
    for await (const event of events) {
      await options?.onProviderStreamEvent?.(event, model)
      if (options?.signal?.aborted) {
        fail("aborted", "the request was cancelled")
        return
      }
      if (event.error) {
        const aborted = options?.signal?.aborted || /cancelled/i.test(String(event.error.message ?? ""))
        fail(aborted ? "aborted" : "error", aborted ? "the request was cancelled" : normalizeError(String(event.error.message ?? "")))
        return
      }
      if (event.text) {
        if (open?.kind === "thinking") endOpen()
        if (!open) {
          message.content.push({ type: "text", text: "" })
          open = { kind: "text", index: message.content.length - 1 }
          push({ type: "text_start", contentIndex: open.index, partial: message })
        }
        const block = message.content[open.index] as TextContent
        block.text += event.text
        push({ type: "text_delta", contentIndex: open.index, delta: event.text, partial: message })
      }
      if (event.reasoning) {
        if (open?.kind === "text") endOpen()
        if (!open) {
          message.content.push({ type: "thinking", thinking: "" })
          open = { kind: "thinking", index: message.content.length - 1 }
          push({ type: "thinking_start", contentIndex: open.index, partial: message })
        }
        const block = message.content[open.index] as ThinkingContent
        block.thinking += event.reasoning
        push({ type: "thinking_delta", contentIndex: open.index, delta: event.reasoning, partial: message })
      }
      if (event.tool) {
        endOpen()
        sawTool = true
        const call: ToolCall = {
          type: "toolCall",
          id: event.tool.id,
          name: event.tool.name,
          arguments: toolArguments(event.tool.args),
        }
        message.content.push(call)
        const index = message.content.length - 1
        push({ type: "toolcall_start", contentIndex: index, partial: message })
        push({ type: "toolcall_delta", contentIndex: index, delta: JSON.stringify(call.arguments), partial: message })
        push({ type: "toolcall_end", contentIndex: index, toolCall: call, partial: message })
      }
      if (event.stop) {
        endOpen()
        applyUsage(message, model, event.usage)
        const reason: Extract<StopReason, "stop" | "toolUse"> = sawTool || event.stop === "tool_calls" ? "toolUse" : "stop"
        message.stopReason = reason
        push({ type: "done", reason, message })
        return
      }
    }
    endOpen()
    message.stopReason = sawTool ? "toolUse" : "stop"
    push({ type: "done", reason: message.stopReason, message })
  } catch (err) {
    const aborted = options?.signal?.aborted === true
    fail(aborted ? "aborted" : "error", aborted ? "the request was cancelled" : normalizeError(err instanceof Error ? err.message : String(err)))
  }
}

export function streamCursor(
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream()
  void pump(stream, model, context, options)
  return stream
}

async function pump(
  stream: AssistantMessageEventStream,
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
) {
  const message = blank(model)
  const fail = (reason: Extract<StopReason, "error" | "aborted">, text: string) => {
    message.stopReason = reason
    message.errorMessage = text
    stream.push({ type: "error", reason, error: message })
  }
  try {
    if (options?.signal?.aborted) {
      fail("aborted", "the request was cancelled")
      return
    }
    const auth = await resolveAccessToken({ apiKey: options?.apiKey, env: options?.env })
    if (!auth) {
      fail("error", "Cursor isn't signed in. Run /login cursor or set CURSOR_ACCESS_TOKEN.")
      return
    }
    const piTools = options?.toolChoice === "none" ? [] : getCurrentTools(context.messages)
    const system = getCurrentSystemPrompt(context.messages)
    const ran = await runAnswer({
      tok: auth.token,
      model: model.id,
      effort: options?.reasoning ?? "",
      messages: toChat(context.messages, system),
      tools: piTools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        schema: tool.parameters ?? { type: "object", properties: {} },
      })),
      session: options?.sessionId ?? "",
      signal: options?.signal,
      headers: options?.headers,
      onPayload: options?.onPayload ? (payload: unknown) => options.onPayload?.(payload, model) : undefined,
      onResponse: (response: { status: number; headers: Record<string, string> }) =>
        options?.onResponse?.({ status: response.status, headers: response.headers }, model),
    })
    if (ran.error) {
      const aborted = options?.signal?.aborted || /cancelled/i.test(String(ran.error.message ?? ""))
      fail(aborted ? "aborted" : "error", aborted ? "the request was cancelled" : normalizeError(String(ran.error.message ?? "")))
      return
    }
    await emitCursorEvents(stream, model, ran.events as AsyncIterable<RunEvent>, options)
  } catch (err) {
    const aborted = options?.signal?.aborted === true
    fail(aborted ? "aborted" : "error", aborted ? "the request was cancelled" : normalizeError(err instanceof Error ? err.message : String(err)))
  }
}
