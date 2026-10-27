import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../functions/index.js", import.meta.url), "utf8");

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
  const directoryEnd = source.indexOf("\\n});", directoryStart) + 4;
  const directoryBody = source.slice(directoryStart, directoryEnd);
  assert.ok(directoryStart >= 0, "Missing admin customer directory endpoint");
  assert.doesNotMatch(directoryBody, /processedTransactions|authToken|paymentCredentials/);
});
