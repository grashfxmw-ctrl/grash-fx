import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const [home, login, register, client, admin, adminEntry, api] = await Promise.all([
  read("index.html"),
  read("login.html"),
  read("register.html"),
  read("client-dashboard.html"),
  read("admin-dashboard.html"),
  read("admin.html"),
  read("supabase/functions/account-api/index.ts"),
]);

test("deployed homepage is public and links to the real registration and sign-in pages", () => {
  assert.match(home, /href=["'](?:\.\/)?register\.html["']/);
  assert.match(home, /href=["'](?:\.\/)?login\.html["']/);
  assert.match(home, /Starter Plan/);
  assert.match(home, /Basic Plan/);
  assert.match(home, /Premium Plan/);
  assert.match(home, /VIP Plan/);
  assert.doesNotMatch(home, /firebase|functions\.httpsCallable/i);
});

test("client sign-in supports both email and phone with password", () => {
  assert.match(login, /Email address or phone number/i);
  assert.match(login, /signInWithPassword\(/);
  assert.match(login, /\/phone-login/);
  assert.match(login, /client-dashboard\.html/);
  assert.doesNotMatch(login, /firebase|functions\.httpsCallable/i);
});

test("registration uses Supabase Auth and retains phone, email verification and referral fields", () => {
  assert.match(register, /signUp\(/);
  assert.match(register, /type=["']email["']/);
  assert.match(register, /type=["']tel["']/);
  assert.match(register, /emailRedirectTo/);
  assert.match(register, /referralCode/);
  assert.match(register, /confirmPassword/);
  assert.doesNotMatch(register, /firebase|functions\.httpsCallable/i);
});

test("client dashboard requires a session and uses the production account API", () => {
  assert.match(client, /sb\.auth\.getSession\(\)/);
  assert.match(client, /location\.replace\(["']\.\/login\.html["']\)/);
  assert.match(client, /\/functions\/v1\/account-api/);
  assert.match(client, /api\(["']\/investment["']\s*,\s*["']POST["']/);
  assert.match(client, /sb\.auth\.signOut\(/);
  assert.doesNotMatch(client, /firebase|functions\.httpsCallable/i);
});

test("administrator entry is separate and the admin dashboard checks server authorization", () => {
  assert.match(adminEntry, /admin-dashboard\.html\?mode=signin/);
  assert.match(admin, /id=["']loginPanel["']/);
  assert.match(admin, /grashfx-admin-auth-v1/);
  assert.match(admin, /Admin access required/);
  assert.match(admin, /\/admin\/queue/);
  assert.doesNotMatch(admin, /firebase|functions\.httpsCallable/i);
});

test("account API keeps both login methods and enforces money request minimums", () => {
  assert.match(api, /\/phone-login/);
  assert.match(api, /signInWithPassword\(/);
  assert.match(api, /minimum deposit is \$20\.00/);
  assert.match(api, /minimum withdrawal is \$50\.00/);
  assert.match(api, /\/investment/);
  assert.match(api, /\/admin\/review/);
  assert.doesNotMatch(api, /firebase|functions\.httpsCallable/i);
});

test("investment plan display keeps the configured public rates, minimums and seven-day term", () => {
  assert.match(home, /10% daily/);
  assert.match(home, /20% daily/);
  assert.match(home, /30% daily/);
  assert.match(home, /40% daily/);
  assert.match(home, /7-day term · Minimum \$50/);
  assert.match(home, /7-day term · Minimum \$500/);
  assert.match(home, /7-day term · Minimum \$1,000/);
  assert.match(home, /7-day term · Minimum \$5,000/);
});

test("registration checks hashed IP reuse and flags shared networks for administrator review", () => {
  assert.match(register, /registration-ip-check/);
  assert.match(register, /review_required/);
  assert.match(api, /registration_ip_checks/);
  assert.match(api, /matched_prior_registration/);
  assert.match(api, /admin\/registration-ip-review/);
  assert.match(api, /registration_ip_flags/);
  assert.match(admin, /Registration IP review/);
  assert.match(admin, /data-registration-review/);
});
