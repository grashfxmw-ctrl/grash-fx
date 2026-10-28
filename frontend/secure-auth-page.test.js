"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const pagePath = path.join(__dirname, "..", "secure-auth.html");
const html = fs.readFileSync(pagePath, "utf8");

test("secure auth page uses Firebase Auth and the secure client", () => {
  assert.match(html, /firebase-auth-compat\.js/);
  assert.match(html, /firebase-functions-compat\.js/);
  assert.match(html, /frontend\/secure-client\.js/);
  assert.match(html, /secure\.signUp/);
  assert.match(html, /secure\.signIn/);
  assert.match(html, /secure\.signOut/);
});

test("secure auth page does not load or write the legacy shared database", () => {
  assert.doesNotMatch(html, /firebase-database-compat\.js/);
  assert.doesNotMatch(html, /platform_data/);
  assert.doesNotMatch(html, /localStorage/);
  assert.doesNotMatch(html, /db\.ref\(/);
});

test("secure auth page includes email verification and reset-password flows", () => {
  assert.match(html, /emailVerified/);
  assert.match(html, /sendPasswordResetEmail/);
  assert.match(html, /send your email and verify/i);
});
