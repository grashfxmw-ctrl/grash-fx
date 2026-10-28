"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const html=fs.readFileSync(path.join(__dirname,"..","admin-review.html"),"utf8");
test("admin review page calls protected queue and review methods",()=>{
 assert.match(html,/secure\.listAdminTransactions/);
 assert.match(html,/secure\.reviewTransaction/);
 assert.match(html,/Approve/);assert.match(html,/Reject/);
});
test("admin review page does not load legacy shared database",()=>{
 assert.doesNotMatch(html,/firebase-database-compat\.js/);
 assert.doesNotMatch(html,/platform_data/);assert.doesNotMatch(html,/localStorage/);
});
test("admin page warns to verify payments before approval and relies on backend authorization",()=>{
 assert.match(html,/independently confirming payment/i);
 assert.match(html,/backend independently checks administrator permissions/i);
});
test("admin page inline JavaScript parses",()=>{
 const match=html.match(/<script>([\s\S]*?)<\/script>/);assert.ok(match);
 assert.doesNotThrow(()=>new vm.Script(match[1]));
});
