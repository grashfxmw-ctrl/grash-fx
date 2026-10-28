"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const html=fs.readFileSync(path.join(__dirname,"..","admin-legacy-review.html"),"utf8");
test("legacy review page uses protected stage and retrieve methods",()=>{
 assert.match(html,/secure\.stageLegacyMigration/);
 assert.match(html,/secure\.getLegacyMigration/);
 assert.match(html,/Staged review record/);
});
test("legacy snapshots are clearly unverified and no balance migration is exposed",()=>{
 assert.match(html,/unverified snapshots only/i);
 assert.match(html,/cannot credit funds/i);
 assert.doesNotMatch(html,/approveMigration|creditBalance|migrateBalance|finalizeMigration/);
 assert.doesNotMatch(html,/firebase-database-compat\.js/);
 assert.doesNotMatch(html,/localStorage/);
});
test("legacy review page requires an email and warns about reconciliation",()=>{
 assert.match(html,/type="email"/);
 assert.match(html,/trusted transaction\/payment evidence/i);
 assert.match(html,/No legacy values are credited/i);
});
test("legacy review inline JavaScript parses",()=>{
 const matches=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
 assert.ok(matches.length);
 assert.doesNotThrow(()=>new vm.Script(matches[matches.length-1][1]));
});
