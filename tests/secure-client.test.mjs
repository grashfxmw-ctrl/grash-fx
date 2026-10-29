import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const authPage = await readFile(new URL("../public/supabase-auth.html", import.meta.url), "utf8");
const adminPage = await readFile(new URL("../public/admin-dashboard.html", import.meta.url), "utf8");
const apiSource = await readFile(new URL("../supabase/functions/account-api/index.ts", import.meta.url), "utf8");

test("client portal points to the active Supabase project and account API", () => {
  assert.match(authPage, /https:\/\/vsearqlfvrhkckyndwtv\.supabase\.co/);
  assert.match(authPage, /\/functions\/v1\/account-api/);
  assert.match(authPage, /signUp\(/);
  assert.match(authPage, /signInWithPassword\(/);
  assert.match(authPage, /verifyOtp\(/);
  assert.match(authPage, /callApi\("\/history"\)/);
});

test("administrator portal calls protected Supabase endpoints", () => {
  assert.match(adminPage, /\/functions\/v1\/account-api/);
  assert.match(adminPage, /\/admin\/queue/);
  assert.match(adminPage, /\/admin\/review/);
  assert.match(adminPage, /\/admin\/profile-review/);
});

test("account API validates bearer tokens and gates administrative actions", () => {
  assert.match(apiSource, /authClient\.auth\.getUser\(token\)/);
  assert.match(apiSource, /if \(!isAdmin\) return json\(\{ error: "Admin access required\." \}, 403\)/);
  assert.match(apiSource, /\/admin\/queue/);
  assert.match(apiSource, /\/deposit/);
  assert.match(apiSource, /\/withdrawal/);
  assert.match(apiSource, /\/investment/);
});

test("legacy platform files are not dependencies of the current test suite", async () => {
  assert.doesNotMatch(authPage, /firebase|functions\.httpsCallable/i);
  assert.doesNotMatch(adminPage, /firebase|functions\.httpsCallable/i);
  assert.doesNotMatch(apiSource, /firebase|functions\.httpsCallable/i);
});
