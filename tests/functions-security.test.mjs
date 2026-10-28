import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../functions/index.js", import.meta.url), "utf8");
const clientSource = await readFile(new URL("../frontend/secure-client.js", import.meta.url), "utf8");

test("backend requires Firebase authentication and verified email", () => {
  assert.match(source, /function requireUser\(request\)/);
  assert.match(source, /if \(!auth \|\| !auth\.uid\)/);
  assert.match(source, /auth\.token\.email_verified !== true/);
  assert.match(source, /function requireAdmin\(request\)/);
  assert.match(source, /user\.email !== ADMIN_EMAIL/);
});

test("administrator access is enforced inside server callables", () => {
  for (const endpoint of [
    "reviewTransaction",
    "adminGetUserProfile",
    "adminListTransactions",
    "adminListUsers"
  ]) {
    const start = source.indexOf(`exports.${endpoint} = onCall(async (request) => {`);
    assert.notEqual(start, -1, `Missing callable: ${endpoint}`);
    const body = source.slice(start, source.indexOf("\n});", start) + 4);
    assert.match(body, /requireAdmin\(request\)/, `${endpoint} must enforce admin authorization`);
  }
});

test("profile creation never accepts client-supplied balance, role, or admin flags", () => {
  const start = source.indexOf("exports.createMyProfile = onCall(async (request) => {");
  const end = source.indexOf("\n});", start) + 4;
  const body = source.slice(start, end);
  assert.match(body, /balance: 0/);
  assert.match(body, /role: "user"/);
  assert.doesNotMatch(body, /request\.data\?\.(balance|role|isAdmin|admin)/);
});

test("transaction request limits amount and only accepts supported transaction types", () => {
  assert.match(source, /const MAX_REQUEST_AMOUNT = 100000/);
  assert.match(source, /new Set\(\["Deposit", "Withdrawal"\]\)/);
  assert.match(source, /amount > MAX_REQUEST_AMOUNT/);
});

test("admin list endpoints are bounded and return explicit field allowlists", () => {
  assert.match(source, /Math\.min\(100, Math\.max\(1, Number\.parseInt\(request\.data\?\.limit, 10\) \|\| 50\)\)/);
  const directoryStart = source.indexOf("exports.adminListUsers = onCall(async (request) => {");
  assert.ok(directoryStart >= 0, "Missing admin customer directory endpoint");
  const directoryEnd = source.indexOf("\n});", directoryStart);
  assert.ok(directoryEnd > directoryStart, "Could not isolate admin customer directory endpoint");
  const directoryBody = source.slice(directoryStart, directoryEnd + 4);
  for (const field of ["uid:", "email:", "displayName:", "balance:", "profit:", "referralBonus:", "role:", "isBlocked:", "createdAt:"]) {
    assert.ok(directoryBody.includes(field), `Expected safe directory field ${field}`);
  }
  assert.doesNotMatch(directoryBody, /processedTransactions|authToken|paymentCredentials/);
});

test("legacy account inspection is verified-user-only and never migrates untrusted financial fields", () => {
  const start = source.indexOf("exports.inspectLegacyAccount = onCall(async (request) => {");
  assert.ok(start >= 0, "Missing read-only legacy inspection endpoint");
  const end = source.indexOf("\n});", start);
  assert.ok(end > start, "Could not isolate legacy inspection endpoint");
  const body = source.slice(start, end + 4);
  assert.match(body, /requireUser\(request\)/);
  assert.match(body, /platform_data\/users/);
  assert.match(body, /status = "ambiguous"/);
  assert.match(body, /status = "blocked"/);
  assert.match(body, /migrationCompleted: false/);
  assert.doesNotMatch(body, /secure_users\/\$\{actor\.uid\}.*\.set|balance:\s*Number|password\s*:/s);
  assert.doesNotMatch(body, /return\s*\{[^}]*balance\s*:/s);
});

test("secure frontend keeps signup unverified until email verification and never reads legacy data", () => {
  const signupStart = clientSource.indexOf("async signUp({ name, email, password })");
  const signinStart = clientSource.indexOf("async signIn({ email, password })");
  assert.ok(signupStart >= 0 && signinStart > signupStart, "Expected secure signup and signin methods");
  const signupBody = clientSource.slice(signupStart, signinStart);
  assert.match(signupBody, /sendEmailVerification\(\)/);
  assert.match(signupBody, /await auth\.signOut\(\)/);
  assert.doesNotMatch(signupBody, /createMyProfile|getMyAccountData/);
  assert.match(clientSource, /if \(!auth\.currentUser \|\| !auth\.currentUser\.emailVerified\)/);
  assert.match(clientSource, /await call\("createMyProfile"/);
  assert.doesNotMatch(clientSource, /localStorage|\.ref\(["']platform_data|\.set\(.*balance/s);
});
