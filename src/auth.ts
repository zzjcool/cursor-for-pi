/**
 * Cursor credentials for Pi.
 *
 * Login and the four lookup levels follow pi-cursor (MIT):
 * https://github.com/Rahularya01/pi-cursor
 * Browser sign-in is the deep-control PKCE flow, polled at api2.cursor.sh.
 * Tokens are never written to logs.
 */
import { execFile, spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai"
import { readStoredCredential } from "@earendil-works/pi-coding-agent"
import { API, clientVersion } from "./client.ts"

const LOGIN_URL = "https://cursor.com/loginDeepControl"
const POLL_URL = `${API}/auth/poll`
const EXCHANGE_URL = `${API}/auth/exchange_user_api_key`

export type AuthSource = "environment" | "pi-oauth" | "keychain" | "ide-state"

export interface ResolvedAuth {
  token: string
  source: AuthSource
}

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function plausible(token: string): boolean {
  return token.length >= 20 && !/\s/.test(token) && !token.startsWith("$")
}

/** A token with no exp is kept. One whose exp has passed is not. */
function current(token: string): boolean {
  if (!plausible(token)) return false
  const exp = jwtExpiryMs(token)
  return exp === 0 || exp > Date.now()
}

function jwtExpiryMs(token: string): number {
  const parts = token.split(".")
  if (parts.length !== 3) return 0
  try {
    const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as { exp?: unknown }
    return typeof payload.exp === "number" && payload.exp > 0 ? payload.exp * 1000 : 0
  } catch {
    return 0
  }
}

/** Refresh a few minutes early. Fall back to an hour when the token has no exp. */
export function expiresAt(token: string): number {
  const exp = jwtExpiryMs(token)
  if (!exp) return Date.now() + 60 * 60 * 1000
  return Math.max(exp - 5 * 60 * 1000, Date.now() + 60 * 1000)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Cursor sign-in cancelled"))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        reject(new Error("Cursor sign-in cancelled"))
      },
      { once: true },
    )
  })
}

function openBrowser(url: string) {
  try {
    const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open"
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url]
    const child = spawn(command, args, { stdio: "ignore", detached: true })
    child.on("error", () => {})
    child.unref()
  } catch {
    // The URL is already on screen via onAuth.
  }
}

function securityPassword(service: string): Promise<string> {
  if (process.platform !== "darwin") return Promise.resolve("")
  return new Promise((resolve) => {
    execFile(
      "security",
      ["find-generic-password", "-s", service, "-a", "cursor-user", "-w"],
      { timeout: 2000 },
      (err, stdout) => resolve(err ? "" : String(stdout ?? "").trim()),
    )
  })
}

function ideDbPath(): string {
  const home = homedir()
  if (process.platform === "darwin") return join(home, "Library/Application Support/Cursor/User/globalStorage/state.vscdb")
  if (process.platform === "win32") {
    return join(process.env.APPDATA || join(home, "AppData", "Roaming"), "Cursor", "User", "globalStorage", "state.vscdb")
  }
  const config = process.env.XDG_CONFIG_HOME || join(home, ".config")
  return join(config, "Cursor", "User", "globalStorage", "state.vscdb")
}

async function ideToken(): Promise<string> {
  const path = ideDbPath()
  if (!existsSync(path)) return ""
  try {
    const mod = (await import("node:sqlite")) as {
      DatabaseSync: new (filename: string, options: { readOnly: boolean }) => {
        prepare(sql: string): { get(key: string): { value?: unknown } | undefined }
        close(): void
      }
    }
    const db = new mod.DatabaseSync(path, { readOnly: true })
    try {
      const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get("cursorAuth/accessToken")
      return trimmed(row?.value)
    } finally {
      db.close()
    }
  } catch {
    return ""
  }
}

export interface CredentialLookup {
  stored?: () => string
  keychain?: () => Promise<string> | string
  ide?: () => Promise<string> | string
}

function storedToken(): string {
  try {
    const cred = readStoredCredential("cursor")
    if (cred?.type === "oauth") return trimmed(cred.access)
  } catch {
    // Pi's auth store isn't available to this process.
  }
  return ""
}

/** CURSOR_ACCESS_TOKEN, then Pi OAuth, then the macOS keychain, then Cursor IDE state. */
export async function resolveAccessToken(opts?: {
  apiKey?: string
  env?: Record<string, string | undefined>
  lookup?: CredentialLookup
}): Promise<ResolvedAuth | undefined> {
  const envToken = trimmed(opts?.env?.CURSOR_ACCESS_TOKEN ?? process.env.CURSOR_ACCESS_TOKEN)
  if (plausible(envToken)) return { token: envToken, source: "environment" }
  const apiKey = trimmed(opts?.apiKey)
  if (plausible(apiKey)) return { token: apiKey, source: "pi-oauth" }
  const stored = opts?.lookup?.stored ? opts.lookup.stored() : storedToken()
  if (current(stored)) return { token: stored, source: "pi-oauth" }
  const keychain = opts?.lookup?.keychain ? await opts.lookup.keychain() : await securityPassword("cursor-access-token")
  if (current(keychain)) return { token: keychain, source: "keychain" }
  const ide = opts?.lookup?.ide ? await opts.lookup.ide() : await ideToken()
  if (current(ide)) return { token: ide, source: "ide-state" }
  return undefined
}

export async function login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const verifierBytes = new Uint8Array(32)
  crypto.getRandomValues(verifierBytes)
  const verifier = Buffer.from(verifierBytes).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  const uuid = randomUUID()
  const params = new URLSearchParams({ challenge, uuid, mode: "login", redirectTarget: "cli" })
  const url = `${LOGIN_URL}?${params.toString()}`
  callbacks.onAuth({
    url,
    instructions: "Sign in to Cursor in the browser. This finishes once the page confirms it.",
  })
  openBrowser(url)
  const headers = {
    "Content-Type": "application/json",
    "x-cursor-client-version": await clientVersion(),
    "x-cursor-client-type": "cli",
  }
  let errors = 0
  for (let attempt = 0; attempt < 150; attempt++) {
    const wait = Math.min(1000 * 1.2 ** attempt, 10_000)
    await sleep(wait, callbacks.signal)
    if (attempt > 0 && attempt % 8 === 0) callbacks.onProgress?.("Still waiting for the Cursor sign-in.")
    let res: Response
    try {
      const signals = [AbortSignal.timeout(15_000)]
      if (callbacks.signal) signals.push(callbacks.signal)
      res = await fetch(`${POLL_URL}?uuid=${encodeURIComponent(uuid)}&verifier=${encodeURIComponent(verifier)}`, {
        headers,
        signal: AbortSignal.any(signals),
      })
    } catch {
      if (callbacks.signal?.aborted) throw new Error("Cursor sign-in cancelled")
      if (++errors >= 3) throw new Error("Couldn't reach Cursor to finish sign-in")
      continue
    }
    if (res.status === 404) {
      errors = 0
      continue
    }
    if (!res.ok) {
      if (res.status === 403 || ++errors >= 3) {
        throw new Error(res.status === 403 ? "Cursor refused the sign-in (403)" : `Cursor sign-in failed (HTTP ${res.status})`)
      }
      continue
    }
    const body = (await res.json().catch(() => null)) as { accessToken?: unknown; refreshToken?: unknown } | null
    const access = trimmed(body?.accessToken)
    if (!access) throw new Error("Cursor sent back no access token")
    const refresh = trimmed(body?.refreshToken)
    return { access, refresh, expires: expiresAt(access) }
  }
  throw new Error("Cursor sign-in timed out")
}

export async function refresh(credentials: OAuthCredentials, signal?: AbortSignal): Promise<OAuthCredentials> {
  const res = await fetch(EXCHANGE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credentials.access}`,
      "Content-Type": "application/json",
      "connect-protocol-version": "1",
      "x-cursor-client-type": "cli",
      "x-cursor-client-version": await clientVersion(),
    },
    body: "{}",
    signal,
  })
  if (!res.ok) throw new Error(`Cursor sign-in could not be refreshed (HTTP ${res.status})`)
  const body = (await res.json().catch(() => null)) as { accessToken?: unknown; refreshToken?: unknown; access?: unknown; refresh?: unknown } | null
  const access = trimmed(body?.accessToken) || trimmed(body?.access) || credentials.access
  const nextRefresh = trimmed(body?.refreshToken) || trimmed(body?.refresh) || credentials.refresh
  return { access, refresh: nextRefresh, expires: expiresAt(access) }
}
