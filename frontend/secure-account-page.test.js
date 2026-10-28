"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const html=fs.readFileSync(path.join(__dirname,"..","secure-account.html"),"utf8");

test("secure dashboard uses the verified secure client and transaction callables",()=>{
  assert.match(html,/frontend\/secure-client\.js/);
  assert.match(html,/secure\.loadAccount/);
  assert.match(html,/secure\.requestDeposit/);
  assert.match(html,/secure\.requestWithdrawal/);
  assert.match(html,/onAuthStateChanged/);
});
test("dashboard does not read legacy shared data or browser identity storage",()=>{
  assert.doesNotMatch(html,/firebase-database-compat\.js/);
  assert.doesNotMatch(html,/platform_data/);
  assert.doesNotMatch(html,/localStorage/);
  assert.doesNotMatch(html,/db\.ref\(/);
});
test("dashboard explains transaction requests are pending and do not move money immediately",()=>{
  assert.match(html,/pending request for administrator review/i);
  assert.match(html,/does not initiate a payment or immediately change your balance/i);
});
test("dashboard inline application JavaScript parses",()=>{
  const match=html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match,"inline application script exists");
  assert.doesNotThrow(()=>new vm.Script(match[1]));
});

test("dashboard includes server-authoritative investment plans and business minimums",()=>{
  assert.match(html,/secure\.activateInvestmentPlan/);
  assert.match(html,/Starter Plan/);
  assert.match(html,/10% per 24h/);
  assert.match(html,/20% per 24h/);
  assert.match(html,/30% per 24h/);
  assert.match(html,/40% per 24h/);
  assert.match(html,/minimum deposit \$20/i);
  assert.match(html,/minimum withdrawal \$50/i);
  assert.match(html,/No deposit or withdrawal fees/i);
  assert.match(html,/after day seven/i);
});
test("dashboard displays referral link and lifetime profit fields",()=>{
  assert.match(html,/referralCode/);
  assert.match(html,/searchParams\.set\("ref",code\)/);
  assert.match(html,/totalProfitEarned/);
});
