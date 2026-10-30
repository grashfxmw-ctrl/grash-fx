import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const accountPage = await readFile(new URL("../public/account.html", import.meta.url), "utf8");
const adminPage = await readFile(new URL("../public/admin-dashboard.html", import.meta.url), "utf8");
const apiSource = await readFile(new URL("../supabase/functions/account-api/index.ts", import.meta.url), "utf8");

test("client account page points to the active Supabase project and account API", () => {
  assert.match(accountPage, /https:\/\/vwghcjkgzeausfxqphmf\.supabase\.co/);
  assert.match(accountPage, /\/functions\/v1\/account-api/);
  assert.match(accountPage, /signUp\(/);
  assert.match(accountPage, /signInWithPassword\(/);
  assert.match(accountPage, /Invalid email or password\./);
  assert.match(accountPage, /await client\.auth\.signOut\(\)/);
  assert.match(accountPage, /verifyOtp\(/);
  assert.match(accountPage, /callApi\("\/history"\)/);
  assert.match(accountPage, /setTimeout\(\(\) => controller\.abort\(\), 15000\)/);
  assert.match(accountPage, /loadReferrals\(\);/);
  assert.match(accountPage, /if\(data\.profile\.status==="active"\) loadHistory\(\);/);
  assert.doesNotMatch(accountPage, /callApi\("\/profile","POST"/);
  assert.match(accountPage, /server took too long to respond/i);
});

test("administrator portal calls protected Supabase endpoints", () => {
  assert.match(adminPage, /\/functions\/v1\/account-api/);
  assert.match(adminPage, /\/admin\/queue/);
  assert.match(adminPage, /\/admin\/review/);
  assert.match(adminPage, /\/admin\/profile-review/);
  assert.match(adminPage, /Verifying administrator permissions/);
  assert.match(adminPage, /if\(!loaded\) throw new Error/);
  assert.doesNotMatch(adminPage, /setLoggedIn\(true\);await loadQueue\(\)/);
});

test("administrator entry remains sign-in first and dashboard is hidden until verified", async () => {
  const adminEntry = await readFile(new URL("../public/admin.html", import.meta.url), "utf8");
  const homePage = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(adminEntry, /admin-dashboard\.html\?mode=signin/);
  assert.match(homePage, /\.\/admin\.html/);
  assert.match(adminPage, /<section id="loginPanel"/);
  assert.match(adminPage, /<section id="dashboard" class="hidden">/);
  assert.match(adminPage, /if\(data\.session\) await client\.auth\.signOut\(\)/);
});

test("account API validates bearer tokens and gates administrative actions", () => {
  assert.match(apiSource, /userClient\.auth\.getUser\(token\)/);
  assert.match(apiSource, /if \(!\(await isAdmin\(\)\)\) return json\(\{ error: "Admin access required\." \}, 403\)/);
  assert.match(apiSource, /\/admin\/queue/);
  assert.match(apiSource, /\/deposit/);
  assert.match(apiSource, /\/withdrawal/);
  assert.match(apiSource, /\/investment/);
  assert.match(apiSource, /minimum deposit is \$20\.00/);
  assert.match(apiSource, /minimum withdrawal is \$50\.00/);
});

test("legacy platform files are not dependencies of the current test suite", async () => {
  assert.doesNotMatch(accountPage, /firebase|functions\.httpsCallable/i);
  assert.doesNotMatch(adminPage, /firebase|functions\.httpsCallable/i);
  assert.doesNotMatch(apiSource, /firebase|functions\.httpsCallable/i);
});
