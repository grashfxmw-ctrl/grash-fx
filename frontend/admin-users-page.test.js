"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const html=fs.readFileSync(path.join(__dirname,"..","admin-users.html"),"utf8");
test("admin customer page uses protected directory and profile methods",()=>{
 assert.match(html,/secure\.listAdminUsers/);
 assert.match(html,/secure\.getAdminUserProfile/);
 assert.match(html,/View profile/);
});
test("admin customer page remains read-only and avoids legacy storage",()=>{
 assert.match(html,/read-only/i);
 assert.doesNotMatch(html,/firebase-database-compat\.js/);
 assert.doesNotMatch(html,/platform_data/);
 assert.doesNotMatch(html,/localStorage/);
 assert.doesNotMatch(html,/updateBalance|blockUser|unblockUser/);
});
test("admin customer page relies on backend authorization",()=>{
 assert.match(html,/backend checks permissions/i);
 assert.match(html,/Administrator access is enforced by Firebase callable functions/i);
});
test("admin customer page inline JavaScript parses",()=>{
 const matches=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
 assert.ok(matches.length);
 assert.doesNotThrow(()=>new vm.Script(matches[matches.length-1][1]));
});
