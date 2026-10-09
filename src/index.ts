/**
 * Pi extension: provider id `cursor`.
 *
 * Login follows pi-cursor (MIT): https://github.com/Rahularya01/pi-cursor
 * Each turn opens its own HTTP/2 Run and tears it down. This does not register
 * a parked bridge, a checkpoint, or a run journal.
 */
import type { RefreshModelsContext } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent"
import { login, refresh, resolveAccessToken } from "./auth.ts"
import { AGENT, clientVersion } from "./client.ts"
import { piModelConfigs, usable } from "./models.ts"
import { streamCursor } from "./pi-stream.ts"

let models: ProviderModelConfig[] = []

async function refreshModels(ctx: RefreshModelsContext): Promise<ProviderModelConfig[]> {
  if (ctx.signal.aborted || !ctx.allowNetwork) return models
  const fromCred =
    ctx.credential?.type === "oauth" ? ctx.credential.access : ctx.credential?.type === "api_key" ? ctx.credential.key : undefined
  const auth = await resolveAccessToken({ apiKey: fromCred })
  if (!auth) return models
  try {
    models = piModelConfigs(await usable(auth.token, ctx.force === true)) as ProviderModelConfig[]
    return models
  } catch {
    return models
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerProvider("cursor", {
    name: "Cursor",
    baseUrl: AGENT,
    apiKey: "$CURSOR_ACCESS_TOKEN",
    api: "cursor-run",
    models,
    oauth: {
      name: "Cursor",
      isSubscription: true,
      login,
      refreshToken: (credentials, signal) => refresh(credentials, signal),
      getApiKey: (credentials) => credentials.access,
    },
    refreshModels,
    streamSimple: streamCursor,
  })

  pi.registerCommand("cursor.doctor", {
    description: "Show which Cursor credential would be used, without printing the token",
    handler: async (args, ctx) => {
      const extra = args.trim() ? " This command does not take arguments." : ""
      const auth = await resolveAccessToken()
      const version = await clientVersion()
      if (!auth) {
        ctx.ui.notify(`Cursor is not signed in (${version}). Run /login cursor or set CURSOR_ACCESS_TOKEN.${extra}`, "warning")
        return
      }
      ctx.ui.notify(`Cursor auth source: ${auth.source}. Client ${version}. Token not shown.${extra}`, "info")
    },
  })
}
