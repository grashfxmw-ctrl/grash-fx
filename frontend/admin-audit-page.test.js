"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const html=fs.readFileSync(path.join(__dirname,"..","admin-audit.html"),"utf8");
test("admin audit page uses protected audit endpoint and offers bounded row limits",()=>{
 assert.match(html,/secure\.listAdminAuditLogs/);
 assert.match(html,/value="100"/);
 assert.match(html,/value="50"/);
});
test("admin audit page is read-only and does not access legacy database or browser identity",()=>{
 assert.match(html,/does not edit or delete logs/i);
 assert.doesNotMatch(html,/firebase-database-compat\.js/);
 assert.doesNotMatch(html,/platform_data|localStorage|\.set\(.*balance/s);
});
test("admin audit page renders log fields as text rather than HTML",()=>{
 assert.match(html,/td\.textContent=value/);
 assert.match(html,/Administrator access/i);
});
test("admin audit page inline JavaScript parses",()=>{
 const matches=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
 assert.ok(matches.length);
 assert.doesNotThrow(()=>new vm.Script(matches[matches.length-1][1]));
});
