import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const html = await readFile(new URL("../secure-preview.html", import.meta.url), "utf8");

test("secure preview inline JavaScript parses", () => {
  const inlineScripts = [...html.matchAll(/<script(?:\\s[^>]*)?>([\\s\\S]*?)<\\/script>/gi)]
    .map((match) => match[1].trim())
    .filter(Boolean);
  assert.ok(inlineScripts.length > 0, "expected an inline application script");
  for (const script of inlineScripts) new vm.Script(script);
});

test("secure preview includes auth, transaction request, and account history UI", () => {
  for (const id of ["loginForm", "signupForm", "transactionForm", "history", "balance"]) {
    assert.match(html, new RegExp('id="' + id + '"'));
  }
  assert.match(html, /createGrashSecureClient/);
  assert.match(html, /requestDeposit/);
  assert.match(html, /requestWithdrawal/);
  assert.match(html, /getMyAccountData|loadAccount/);
});

test("secure preview does not write legacy shared platform data", () => {
  assert.doesNotMatch(html, /ref\\(['"]platform_data['"]\\)\\.set/);
  assert.doesNotMatch(html, /localStorage\\.setItem/);
  assert.match(html, /Staging only/);
});
