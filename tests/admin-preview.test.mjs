import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const html = await readFile(new URL("../admin-preview.html", import.meta.url), "utf8");

test("admin preview inline JavaScript parses", () => {
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1].trim())
    .filter(Boolean);
  assert.ok(scripts.length > 0, "expected an inline application script");
  for (const script of scripts) new vm.Script(script);
});

test("admin preview uses secure queue and review adapter actions", () => {
  assert.match(html, /listAdminTransactions/);
  assert.match(html, /listAdminUsers/);
  assert.match(html, /Customer directory/);
  assert.match(html, /adminListUsers/);
  assert.match(html, /reviewTransaction/);
  assert.match(html, /transactionId:tx\.id,decision,note/);
  assert.match(html, /Processing/);
  assert.match(html, /Verify this email/);
  assert.match(html, /window\.confirm/);
  assert.match(html, /Administrator access required|Authorization is enforced by the callable endpoint/);
});

test("admin preview is locked to isolated staging config and does not touch legacy data", () => {
  assert.match(html, /REPLACE_WITH_STAGING_API_KEY/);
  assert.match(html, /REPLACE_WITH_STAGING_PROJECT/);
  assert.match(html, /Staging only/);
  assert.match(html, /startsWith\("REPLACE_WITH_"\)/);
  assert.doesNotMatch(html, /grashfx\.firebaseapp\.com/);
  assert.doesNotMatch(html, /ref\(['"]platform_data['"]\)\.set/);
  assert.doesNotMatch(html, /localStorage\.setItem/);
});
