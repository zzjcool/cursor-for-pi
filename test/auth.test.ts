import assert from "node:assert/strict"
import { test } from "node:test"
import { expiresAt, resolveAccessToken } from "../src/auth.ts"

test("jwt expiry is used a few minutes early", () => {
  const exp = Math.floor(Date.now() / 1000) + 3600
  const body = Buffer.from(JSON.stringify({ exp })).toString("base64url")
  const at = expiresAt(`aaa.${body}.bbb`)
  assert.ok(at < exp * 1000)
  assert.ok(at > Date.now())
})

test("a token without exp stays valid for about an hour", () => {
  const at = expiresAt("not-a-jwt-token-value-here")
  assert.ok(at > Date.now() + 50 * 60 * 1000)
  assert.ok(at < Date.now() + 70 * 60 * 1000)
})

function jwt(exp: number) {
  const body = Buffer.from(JSON.stringify({ exp })).toString("base64url")
  return `eyJhbGciOiJub25lIn0.${body}.sig`
}

test("an expired keychain token does not hide a live ide token", async () => {
  const auth = await resolveAccessToken({
    env: { CURSOR_ACCESS_TOKEN: "" },
    lookup: {
      stored: () => "",
      keychain: async () => jwt(Math.floor(Date.now() / 1000) - 60),
      ide: async () => jwt(Math.floor(Date.now() / 1000) + 3600),
    },
  })
  assert.equal(auth?.source, "ide-state")
})

test("a live keychain token is used before the ide", async () => {
  const auth = await resolveAccessToken({
    env: { CURSOR_ACCESS_TOKEN: "" },
    lookup: {
      stored: () => jwt(Math.floor(Date.now() / 1000) - 60),
      keychain: async () => jwt(Math.floor(Date.now() / 1000) + 3600),
      ide: async () => jwt(Math.floor(Date.now() / 1000) + 7200),
    },
  })
  assert.equal(auth?.source, "keychain")
})
