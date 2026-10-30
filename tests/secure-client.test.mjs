import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const homePage = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const clientPage = await readFile(new URL("../public/client-dashboard.html", import.meta.url), "utf8");
const adminPage = await readFile(new URL("../public/admin-dashboard.html", import.meta.url), "utf8");
const adminEntry = await readFile(new URL("../public/admin.html", import.meta.url), "utf8");
const registerEntry = await readFile(new URL("../public/register.html", import.meta.url), "utf8");
const apiSource = await readFile(new URL("../supabase/functions/account-api/index.ts", import.meta.url), "utf8");

test("public homepage supports email sign-up, sign-in, and email verification", () => {
  assert.match(homePage, /signUp\(/);
  assert.match(homePage, /signInWithPassword\(/);
  assert.match(homePage, /verifyOtp\(/);
  assert.match(homePage, /homeSignup/);
  assert.match(homePage, /homeSignin/);
  assert.match(homePage, /get\("auth"\)==="signin"/);
});

test("client dashboard requires a valid session and does not reload on SIGNED_IN", () => {
  assert.match(clientPage, /sb\.auth\.getUser\(\)/);
  assert.match(clientPage, /location\.replace\("\.\/\?auth=signin"\)/);
  assert.doesNotMatch(clientPage, /event==="SIGNED_IN"[^;]*location\.reload/);
  assert.match(clientPage, /controller\.abort\(\),15000/);
  assert.match(clientPage, /\/functions\/v1\/account-api/);
});

test("homepage and client dashboard do not call the rejected profile-creation endpoint", () => {
  assert.doesNotMatch(homePage, /api\("\/profile","POST"/);
  assert.doesNotMatch(clientPage, /api\("\/profile","POST"/);
  assert.match(apiSource, /A profile is created automatically at signup/);
});

test("administrator entry always opens the sign-in screen", () => {
  assert.match(adminEntry, /admin-dashboard\.html\?mode=signin/);
  assert.match(adminPage, /Secure administrator sign in/);
  assert.doesNotMatch(adminPage, /sb\.auth\.getSession\(\)\.then\(async function\(r\).*await enter/);
});

test("administrator dashboard stays hidden until the server authorizes the signed-in user", () => {
  assert.match(adminPage, /id="loginPanel"/);
  assert.match(adminPage, /id="app" class="hidden(?:\s|")/);
  assert.match(adminPage, /api\("\/admin\/queue"\)/);
  assert.match(adminPage, /var authorized=await loadQueue\(\);if\(!authorized\)/);
  assert.match(adminPage, /Admin access required/);
  assert.match(adminPage, /setTimeout\(function\(\)\{controller\.abort\(\);\},15000\)/);
});

test("registration shortcut opens the homepage sign-up form", () => {
  assert.match(registerEntry, /\?auth=signup/);
});

test("account API validates bearer tokens and gates administrative actions", () => {
  assert.match(apiSource, /userClient\.auth\.getUser\(token\)/);
  assert.match(apiSource, /if \(!\(await isAdmin\(\)\)\) return json\(\{ error: "Admin access required\." \}, 403\)/);
  assert.match(apiSource, /\/admin\/queue/);
  assert.match(apiSource, /\/admin\/review/);
  assert.match(apiSource, /\/deposit/);
  assert.match(apiSource, /\/withdrawal/);
  assert.match(apiSource, /\/investment/);
  assert.match(apiSource, /minimum deposit is \$20\.00/);
  assert.match(apiSource, /minimum withdrawal is \$50\.00/);
});

test("active website and backend contain no Firebase implementation", () => {
  assert.doesNotMatch(homePage, /firebase|functions\.httpsCallable/i);
  assert.doesNotMatch(clientPage, /firebase|functions\.httpsCallable/i);
  assert.doesNotMatch(adminPage, /firebase|functions\.httpsCallable/i);
  assert.doesNotMatch(apiSource, /firebase|functions\.httpsCallable/i);
});
