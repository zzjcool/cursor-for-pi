/**
 * Cursor model picker: AvailableModels filtered by GetUsableModels.
 *
 * Ported from magpie's Cursor provider (MIT):
 * https://github.com/magpie-community/plugins/tree/main/packages/cursor
 * Dashboard usage accounting is intentionally not ported.
 */
// @ts-nocheck
import { createHash } from "node:crypto"
import { API, DEFAULT_CONTEXT, MODELS_KEEP, unary } from "./client.ts"

const LEVEL_RANK = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]
const EFFORT_PARAMS = ["effort", "reasoning_effort", "reasoning"]

// the effort words of Cursor's own ids and the levels they are; extra-high
// before high
const ID_EFFORTS = [["extra-high", "xhigh"], ["xhigh", "xhigh"], ["minimal", "minimal"], ["none", "none"], ["low", "low"], ["medium", "medium"], ["high", "high"], ["max", "max"]]

const cut = (s, suffix) => (s.endsWith(suffix) && s.length > suffix.length ? s.slice(0, -suffix.length) : null)

// splitID is one of Cursor's own ids (a variant's legacySlug, as
// cursor-agent models lists it) taken apart: its family, and the effort
// ("" for none named) it is at. Thinking comes before the effort or after
// it; in the family it goes after, as does fast. The family is the id 0.1.x
// listed a model by.
function splitID(id) {
  let s = id
  let fast = false
  let thinking = false
  let effort = ""
  let b
  if ((b = cut(s, "-fast")) !== null) [s, fast] = [b, true]
  if ((b = cut(s, "-thinking")) !== null) [s, thinking] = [b, true]
  for (const [word, level] of ID_EFFORTS) {
    if ((b = cut(s, "-" + word)) !== null) {
      ;[s, effort] = [b, level]
      break
    }
  }
  if (!thinking && (b = cut(s, "-thinking")) !== null) [s, thinking] = [b, true]
  if (thinking) s += "-thinking"
  if (fast) s += "-fast"
  return [s, effort]
}

// left out of the CLI's picker as it leaves them out (model-service.ts)
const PICKER_SKIP = new Set(["claude-4.5-haiku", "claude-4.5-haiku-thinking", "gemini-2.5-pro", "gemini-2.5-flash", "claude-haiku-4-5"])

const clean = (s) => String(s ?? "").replaceAll("\u200b", "").split(/\s+/).filter(Boolean).join(" ")

// tokensOf is a context value as tokens: "300k" 300000, "1m" 1000000.
function tokensOf(value) {
  const m = /^(\d+(?:\.\d+)?)([km])$/i.exec(String(value ?? "").trim())
  return m ? Math.round(Number(m[1]) * (m[2].toLowerCase() === "m" ? 1_000_000 : 1_000)) : 0
}

// paramDefs is a picker model's parameters: id to the values it takes.
function paramDefs(m) {
  const out = {}
  for (const d of m.parameterDefinitions ?? []) {
    const t = d?.parameterType ?? {}
    const vs = (t.enumParameter ?? t.booleanParameter)?.values ?? []
    if (d?.id) out[d.id] = vs.map((v) => String(v.value))
  }
  return out
}

const valuesOf = (v) => Object.fromEntries((v?.parameterValues ?? []).map((p) => [String(p.id), String(p.value)]))

// defaultVariant is the variant the CLI picks for a model asked for by
// name: its default without Max Mode, else with it, else the first.
const defaultVariant = (m) => {
  const vs = m?.variants ?? []
  return vs.find((v) => v.isDefaultNonMaxConfig) ?? vs.find((v) => v.isDefaultMaxConfig) ?? vs[0]
}

// needsMax is whether a variant is run in Max Mode only, as the CLI reads
// it: a model with no other mode, or a Max Mode variant.
const needsMax = (m, v) => m?.supportsNonMaxMode === false || v?.isMaxMode === true

// effortsOf is the efforts a model takes, as pi's levels, each with the
// value Cursor's parameter has for it (extra-high is xhigh).
function effortsOf(defs) {
  const pid = EFFORT_PARAMS.find((p) => defs[p]?.length)
  // thinking alone, on or off: high and none
  if (!pid && defs.thinking?.includes("true") && defs.thinking.includes("false")) return { pid: "thinking", levels: { none: "false", high: "true" } }
  if (!pid) return { pid: "", levels: {} }
  const levels = {}
  for (const v of defs[pid]) {
    const l = v === "extra-high" ? "xhigh" : v
    if (LEVEL_RANK.includes(l)) levels[l] = v
  }
  return { pid, levels }
}

// served is a picker model's variants the account is served. With the
// usable list at hand (the ids cursor-agent models shows), a variant whose
// own id isn't in it is one the account hasn't got (Sonnet 4.6 at any effort
// but medium, say). A model the usable list has nothing of is the picker's
// alone (GLM-5.3), and is kept whole.
function served(m, ids) {
  const vs = m.variants ?? []
  if (!ids) return vs
  const got = vs.filter((v) => !v.legacySlug || ids.has(v.legacySlug))
  return got.some((v) => v.legacySlug) ? got : vs
}

// modelsOf is the picker's models as offered: one entry for each context
// size a model has, or one with Cursor's limit when it has none. A model
// served in part is offered at the sizes and efforts it is served at.
function modelsOf(picker, ids) {
  const out = []
  const used = new Set()
  for (const m of picker) {
    if (!m?.name || m.isHidden || m.isChatOnly || m.onlySupportsCmdK || m.supportsAgent === false || PICKER_SKIP.has(m.name)) continue
    const defs = paramDefs(m)
    const variants = served(m, ids)
    const partial = variants.length < (m.variants ?? []).length
    const has = (pid, value) => !partial || !variants.some((v) => pid in valuesOf(v)) || variants.some((v) => valuesOf(v)[pid] === value)
    const def = defaultVariant({ variants })
    const { pid, levels: all } = effortsOf(defs)
    const levels = Object.fromEntries(Object.entries(all).filter(([, value]) => has(pid, value)))
    const base = { run: m.name, title: clean(m.clientDisplayName || m.name), pid, levels, fast: !!defs.fast?.length, variants, def, partial, model: m }
    const contexts = (defs.context ?? []).filter((c) => has("context", c))
    if (contexts.length) {
      for (const c of contexts) {
        const id = m.name + "@" + c
        if (used.has(id)) continue
        used.add(id)
        out.push({ ...base, id, name: base.title + " @ " + c, context: tokensOf(c) || DEFAULT_CONTEXT, size: c, offersFast: fastAt(variants, c) })
      }
    } else if (!used.has(m.name)) {
      used.add(m.name)
      const limit = needsMax(m, def) ? m.contextTokenLimitForMaxMode || m.contextTokenLimit : m.contextTokenLimit
      out.push({ ...base, id: m.name === "default" ? "auto" : m.name, name: base.title, context: limit > 0 ? limit : DEFAULT_CONTEXT, size: "", offersFast: fastAt(variants, "") })
    }
  }
  return out
}

// fastAt is whether Cursor has a fast variant the account is served at
// the context size (any, for a model without sizes): what magpie offers
// fast for, which 0.1.x said with a -fast model of its own.
const fastAt = (variants, size) =>
  variants.some((v) => {
    const have = valuesOf(v)
    return have.fast === "true" && (!size || have.context === undefined || have.context === size)
  })

// nearest is the variant of vs most like the parameters wanted, one at
// their context size before any other.
function nearest(vs, want) {
  let best
  let most = -1
  for (const v of vs) {
    const have = valuesOf(v)
    const n = Object.keys(want).filter((k) => have[k] === want[k]).length + (have.context === want.context ? 100 : 0)
    if (n > most) [best, most] = [v, n]
  }
  return best
}

// pick is the variant a request runs as: the model's context size, the
// effort asked for (else the default's) and fast as asked, matched against
// Cursor's variants. With no variant that matches, the parameters go as
// they are, from the default's; of a model served in part, as the nearest
// variant the account has. seed is the variant an id of Cursor's own named
// (request), in the default's place.
function pick(entry, effort, fast, seed) {
  const def = entry.def
  const want = { ...valuesOf(seed ?? def) }
  if (entry.size) want.context = entry.size
  if (effort === "off") effort = "none"
  if (entry.pid && entry.pid !== "thinking" && effort === "none" && !("none" in entry.levels) && "thinking" in want) {
    // a Claude asked not to think: thinking off at its default effort
    want.thinking = "false"
  } else if (entry.pid) {
    const at = effort ? fitEffort(effort, Object.keys(entry.levels)) : ""
    if (at && entry.levels[at]) want[entry.pid] = entry.levels[at]
    // a variant named says for itself whether it thinks
    if (!seed && entry.pid !== "thinking" && "thinking" in want && at) want.thinking = "true"
  }
  // fast only when asked: it costs more
  if (entry.fast) want.fast = fast ? "true" : "false"
  const same = (v) => {
    const have = valuesOf(v)
    return Object.keys({ ...have, ...want }).every((k) => have[k] === undefined || want[k] === undefined || have[k] === want[k])
  }
  const v = entry.variants.find(same) ?? (seed ? branch(entry, want) : undefined) ?? (entry.partial ? nearest(entry.variants, want) : undefined)
  const params = Object.entries(v ? { ...want, ...valuesOf(v) } : want).map(([id, value]) => ({ id, value }))
  // no variant: Max Mode when the size is more than Cursor allows outside it
  const maxMode = v ? needsMax(entry.model, v) : needsMax(entry.model, def) || tokensOf(entry.size) > (entry.model.contextTokenLimit || Infinity)
  // the agent API takes the variant's own id (its legacySlug, as
  // cursor-agent models lists it: claude-opus-5-5-high), not the picker's
  // model name; the default's when no variant matched
  const id = v?.legacySlug || def?.legacySlug || entry.run
  return { id, params, maxMode }
}

// branch is, for an id of Cursor's own asked at an effort no variant has
// with the rest of its parameters (claude-opus-5-low at xhigh: Opus 5
// without thinking stops at high), the variant with those parameters at the
// nearest effort it has, not the default's id with parameters that
// contradict it (claude-opus-5-thinking-high with thinking=false). Where
// the default differs from what is asked in the effort alone, the effort
// goes as asked, as for a listed model.
function branch(entry, want) {
  if (!entry.pid || entry.pid === "thinking") return undefined
  const def = valuesOf(entry.def)
  if (Object.keys(want).every((k) => k === entry.pid || k === "context" || def[k] === undefined || def[k] === want[k])) return undefined
  const vs = entry.variants.filter((v) => {
    const have = valuesOf(v)
    return entry.pid in have && Object.keys(want).every((k) => k === entry.pid || have[k] === undefined || have[k] === want[k])
  })
  const level = (x) => (x === "extra-high" ? "xhigh" : x)
  const at = fitEffort(level(want[entry.pid]), vs.map((v) => level(valuesOf(v)[entry.pid])))
  return at ? vs.find((v) => level(valuesOf(v)[entry.pid]) === at) : undefined
}

// fitEffort is the nearest effort a model has to the one asked for; max
// for ultra, and none only when asked.
function fitEffort(want, levels) {
  if (want === "ultra") want = "max"
  if (!levels.length || levels.includes(want)) return want
  const at = LEVEL_RANK.indexOf(want)
  if (at < 0) return ""
  let best = ""
  let dist = LEVEL_RANK.length
  for (const l of levels) {
    const i = LEVEL_RANK.indexOf(l)
    if (i < 0 || l === "none") continue
    const d = Math.abs(i - at)
    if (d < dist || (d === dist && i > at)) [best, dist] = [l, d]
  }
  return best
}

// usable is the account's list, kept a while, by token: Cursor's picker,
// less the variants the usable list (AgentService/GetUsableModels, what
// cursor-agent models shows) says the account hasn't got. A picker Cursor
// can't give is a failure: magpie keeps the list it had. A usable list it
// can't give leaves the picker as it is.
const lists = new Map()
export async function usable(tok, force = false) {
  const h = createHash("sha256").update(tok).digest("hex")
  const had = lists.get(h)
  if (!force && had && Date.now() - had.at < MODELS_KEEP) return had.raw
  const [j, ids] = await Promise.all([
    unary(API, "aiserver.v1.AiService/AvailableModels", tok, { useModelParameters: true, doNotUseMarkdown: true }, 30_000),
    unary(API, "agent.v1.AgentService/GetUsableModels", tok, {}, 8_000).then(
      (u) => {
        const ids = new Set((u?.models ?? []).flatMap((m) => [m.modelId, m.displayModelId]).filter(Boolean))
        return ids.size ? ids : null
      },
      () => null,
    ),
  ])
  const raw = modelsOf(Array.isArray(j?.models) ? j.models : [], ids)
  if (!raw.length) throw new Error("Cursor listed no models")
  lists.set(h, { at: Date.now(), raw })
  return raw
}

// named is the model and variant an id the list doesn't have stands for,
// when it is one of Cursor's own, as the CLI reads one and as 0.1.x listed
// them, so a model picked before the list changed still runs: a variant's
// own id (claude-opus-5-5-high) is that variant; a family of them, the id
// 0.1.x listed (claude-opus-5-5, claude-opus-5-5-fast, cursor-grok-4.6,
// or with an effort the account lacks), is the family's variant nearest
// the default, fast when the family is and at the id's effort; the picker's
// name for a model, or a legacy slug of it, is its default. Each at the
// variant's context size, the default's when the id doesn't say.
function named(raw, id) {
  const models = raw.filter((e, i) => raw.findIndex((x) => x.model === e.model) === i)
  const at = (e, v) => raw.find((x) => x.model === e.model && x.size === (valuesOf(v).context ?? "")) ?? e
  const as = (e, vs, effort) => {
    const seed = nearest(vs, valuesOf(e.def))
    return { entry: at(e, seed), seed, effort, fast: valuesOf(seed).fast === "true" }
  }
  for (const e of models) {
    const vs = e.variants.filter((v) => v.legacySlug === id)
    if (vs.length) return as(e, vs, "")
  }
  const [family, effort] = splitID(id)
  for (const e of models) {
    const vs = e.variants.filter((v) => v.legacySlug && splitID(v.legacySlug)[0] === family)
    if (vs.length) return as(e, vs, effort)
  }
  for (const e of models) {
    const m = e.model
    if ([m.name, ...(m.legacySlugs ?? []), ...(m.idAliases ?? [])].includes(id)) return { entry: at(e, e.def), seed: undefined, effort: "", fast: false }
  }
  return null
}

// request is how a chat's model is asked of Cursor: the variant's own id,
// its parameters and its mode. An id the list doesn't have that is one of
// Cursor's own goes as the variant it names, at the effort asked for, fast
// when it says so or the request does; any other goes as it is named.
export function request(raw, model, effort, fast) {
  const entry = raw.find((m) => m.id === model)
  if (entry) return pick(entry, effort, fast)
  const old = named(raw, model)
  if (old) return pick(old.entry, effort || old.effort, fast || old.fast, old.seed)
  return { id: model === "auto" ? "default" : model, params: [], maxMode: false }
}

const PI_LEVELS = [["off", "none"], ["minimal", "minimal"], ["low", "low"], ["medium", "medium"], ["high", "high"], ["xhigh", "xhigh"], ["max", "max"]]

function thinkingLevelMap(levels) {
  if (!levels || !Object.keys(levels).length) return undefined
  const map = {}
  for (const [pi, cur] of PI_LEVELS) {
    if (Object.prototype.hasOwnProperty.call(levels, cur)) map[pi] = levels[cur]
    else if (pi !== "off") map[pi] = null
  }
  return map
}

/** Pi chat-model configs. Cost stays zero: a subscription bill is not a token price. */
export function piModelConfigs(raw) {
  return raw.map((m) => {
    const thinking = thinkingLevelMap(m.levels)
    return {
      id: m.id,
      name: m.name,
      api: "cursor-run",
      reasoning: !!thinking,
      ...(thinking ? { thinkingLevelMap: thinking } : {}),
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.context || DEFAULT_CONTEXT,
      maxTokens: 32_000,
    }
  })
}
