import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../functions/index.js", import.meta.url), "utf8");
const clientSource = await readFile(new URL("../frontend/secure-client.js", import.meta.url), "utf8");
const legacyPageSource = await readFile(new URL("../index.html", import.meta.url), "utf8");
const adminReviewPage = await readFile(new URL("../admin-review.html", import.meta.url), "utf8");
const adminUsersPage = await readFile(new URL("../admin-users.html", import.meta.url), "utf8");
const adminLegacyPage = await readFile(new URL("../admin-legacy-review.html", import.meta.url), "utf8");
const adminAuditPage = await readFile(new URL("../admin-audit.html", import.meta.url), "utf8");

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
  const signupStart = clientSource.indexOf("async signUp({ name, email, password, referralCode })");
  const signinStart = clientSource.indexOf("async signIn({ email, password })");
  assert.ok(signupStart >= 0 && signinStart > signupStart, "Expected secure signup and signin methods");
  const signupBody = clientSource.slice(signupStart, signinStart);
  assert.match(signupBody, /sendEmailVerification\(\)/);
  assert.match(signupBody, /await auth\.signOut\(\)/);
  assert.doesNotMatch(signupBody, /createMyProfile|getMyAccountData/);
  assert.match(clientSource, /if \(!auth\.currentUser \|\| !auth\.currentUser\.emailVerified\)/);
  assert.match(clientSource, /await call\("createMyProfile"/);
  assert.doesNotMatch(clientSource, /\.ref\(["']platform_data|\.set\(.*balance/s);
});

test("admin audit log reader is server-authorized, bounded, and field-allowlisted", () => {
  const start = source.indexOf("exports.adminListAuditLogs = onCall(async (request) => {");
  assert.ok(start >= 0, "Missing admin audit log callable");
  const end = source.indexOf("\n});", start);
  assert.ok(end > start, "Could not isolate admin audit log callable");
  const body = source.slice(start, end + 4);
  assert.match(body, /requireAdmin\(request\)/);
  assert.match(body, /Math\.min\(100, Math\.max\(1,/);
  for (const field of ["actorUid:", "action:", "transactionId:", "detail:", "createdAt:"]) {
    assert.ok(body.includes(field), `Expected audit field ${field}`);
  }
  assert.doesNotMatch(body, /password|authToken|paymentCredentials/i);
});

test("secure client exposes the protected admin audit log callable", () => {
  assert.match(clientSource, /async listAdminAuditLogs\(\{ limit \} = \{\}\)/);
  assert.match(clientSource, /call\("adminListAuditLogs", \{ limit \}\)/);
});

test("transaction review uses a tokenized expiring lease and idempotency marker", () => {
  const start = source.indexOf("exports.reviewTransaction = onCall(async (request) => {");
  assert.ok(start >= 0);
  const end = source.indexOf("\n});", start);
  const body = source.slice(start, end + 4);
  assert.ok(body.includes("const claimToken = randomUUID()"));
  assert.ok(body.includes("processingToken: claimToken"));
  assert.ok(body.includes("processingAt: now"));
  assert.ok(body.includes("const leaseMs = 5 * 60 * 1000"));
  assert.ok(body.includes("current.processingToken !== claimToken"));
  assert.ok(body.includes("profile.processedTransactions[id] === true"));
  assert.ok(body.includes('status: "Completed"'));
});

test("withdrawal approval rechecks the current balance inside the profile transaction", () => {
  const start = source.indexOf("exports.reviewTransaction = onCall(async (request) => {");
  const end = source.indexOf("\n});", start);
  const body = source.slice(start, end + 4);
  assert.ok(body.includes('else if (claimedTx.type === "Withdrawal")'));
  assert.ok(body.includes("if (balance < amount) return"));
  assert.ok(body.includes("profile.processedTransactions[id] = true"));
});

test("business rules enforce transaction minimums and existing investment plan rates", () => {
  assert.match(source, /const MIN_DEPOSIT = 20/);
  assert.match(source, /const MIN_INVESTMENT = 50/);
  assert.match(source, /const MIN_WITHDRAWAL = 50/);
  assert.match(source, /"Starter Plan": \{ rate: 10, min: 50, max: 500 \}/);
  assert.match(source, /"Basic Plan": \{ rate: 20, min: 501, max: 2000 \}/);
  assert.match(source, /"Premium Plan": \{ rate: 30, min: 2001, max: 5000 \}/);
  assert.match(source, /"VIP Plan": \{ rate: 40, min: 5001, max: 100000 \}/);
  assert.match(source, /const REFERRAL_REWARD = 5/);
  assert.match(source, /exports\.processScheduledInvestmentProfits = onSchedule\("every 15 minutes"/);
});

test("admin balance editing requires server-side admin access, a reason, and an audit record", () => {
  const start = source.indexOf("exports.adminSetAccountBalances = onCall(async (request) => {");
  assert.ok(start >= 0, "Missing admin balance editor");
  const end = source.indexOf("\n});", start);
  const body = source.slice(start, end + 4);
  assert.match(body, /requireAdmin\(request\)/);
  assert.match(body, /Customer UID and adjustment reason are required/);
  assert.match(body, /admin_balance_adjustment/);
  assert.match(body, /before, after: values/);
});

test("investment activation uses server-owned rates and prevents a second active plan", () => {
  const start = source.indexOf("exports.activateInvestmentPlan = onCall(async (request) => {");
  assert.ok(start >= 0, "Missing investment activation callable");
  const end = source.indexOf("\n});", start);
  const body = source.slice(start, end + 4);
  assert.match(body, /INVESTMENT_PLANS\[planName\]/);
  assert.match(body, /current\.activeInvestment && current\.activeInvestment\.status === "Active"/);
  assert.match(body, /balance - amount/);
});

test("referral reward is fixed at $5 and idempotently recorded per referred UID", () => {
  const start = source.indexOf("exports.createMyProfile = onCall(async (request) => {");
  const end = source.indexOf("\n});", start);
  const body = source.slice(start, end + 4);
  assert.match(body, /secure_referral_codes/);
  assert.match(body, /referralRewardedUids/);
  assert.match(body, /REFERRAL_REWARD/);
  assert.match(body, /verified_registration/);
});

test("admin customer directory supports bounded cursor pagination", () => {
  const start = source.indexOf("exports.adminListUsers = onCall(async (request) => {");
  const end = source.indexOf("\n});", start);
  const body = source.slice(start, end + 4);
  assert.match(body, /cursorCreatedAt/);
  assert.match(body, /cursorUid/);
  assert.match(body, /endAt\(cursorCreatedAt, cursorUid\)/);
  assert.match(body, /nextCursor: next/);
  assert.match(body, /hasMore/);
});

test("investment maturity returns principal plus accumulated profit exactly once", () => {
  const start = source.indexOf("exports.processScheduledInvestmentProfits = onSchedule(\"every 15 minutes\", async () => {");
  const end = source.indexOf("\n});", start);
  const body = source.slice(start, end + 4);
  assert.match(body, /balance \+ profitBalance \+ Number\(inv\.principal \|\| 0\)/);
  assert.match(body, /inv\.principalReturned = true/);
  assert.match(body, /inv\.status = "Completed"/);
  assert.match(body, /creditedDays < 7/);
});


test("account deletion releases a phone only after auth deletion and blocks unresolved financial activity", () => {
  const start = source.indexOf("exports.deleteMyAccount = onCall(async (request) => {");
  assert.ok(start >= 0, "Missing secure account deletion callable");
  const end = source.indexOf("\n});", start);
  const body = source.slice(start, end + 4);
  assert.match(body, /Number\(profile\.balance \|\| 0\) !== 0/);
  assert.match(body, /Number\(profile\.profit \|\| 0\) !== 0/);
  assert.match(body, /activeInvestment && profile\.activeInvestment\.status === "Active"/);
  assert.match(body, /status === "Pending" \|\| status === "Processing"/);
  assert.ok(body.indexOf("await getAuth().deleteUser(actor.uid)") < body.indexOf('updates["secure_phone_numbers/" + phoneKey] = null'));
  assert.match(body, /account_deleted/);
});

test("new account registrations record hashed IP reuse as a review signal, not an automatic block", () => {
  assert.match(source, /request\.rawRequest\?\.ip/);
  assert.match(source, /secure_ip_signals/);
  assert.match(source, /createHash\("sha256"\)\.update\(ip\)/);
  assert.match(source, /registration_ip_reused/);
  assert.match(source, /flag_for_review_not_auto_block/);
  assert.match(source, /if \(created\) \{\s*await writeAudit\(actor\.uid, "secure_profile_created"[\s\S]*?await recordRegistrationIp\(request, actor\.uid\)/);
});

test("secure profile creation requires a verified phone claim and unique phone registry", () => {
  const start = source.indexOf("exports.createMyProfile = onCall(async (request) => {");
  const end = source.indexOf("\n});", start);
  const body = source.slice(start, end + 4);
  assert.match(body, /request\.auth\.token\.phone_number/);
  assert.match(body, /secure_phone_numbers/);
  assert.match(body, /createHash\("sha256"\)/);
  assert.match(body, /already linked to another GRASH FX account/);
});

test("legacy landing page links to the separate secure portal without wiring secure auth into legacy data flows", () => {
  assert.match(legacyPageSource, /href="\.\/secure-auth\.html"/);
  assert.match(legacyPageSource, /Open Secure Account Portal/);
  assert.match(legacyPageSource, /Do not assume legacy balances or account history have transferred/);
  assert.match(legacyPageSource, /Secure backend client is initialized but not yet used by legacy login\/data flows/);
  assert.doesNotMatch(legacyPageSource, /secure\.signIn\(|secure\.signUp\(|secure\.getMyAccountData\(/);
});

test("secure administrator pages link to the other admin tools", () => {
  const pages = [
    ["admin-review.html", adminReviewPage],
    ["admin-users.html", adminUsersPage],
    ["admin-legacy-review.html", adminLegacyPage],
    ["admin-audit.html", adminAuditPage]
  ];
  for (const [pageName, source] of pages) {
    for (const [targetName] of pages) {
      if (targetName === pageName) continue;
      assert.ok(source.includes('href="./' + targetName + '"'),
        pageName + " should link to " + targetName);
    }
  }
});

test("pending withdrawals reserve funds atomically and prevent double-commitment", () => {
  const requestStart = source.indexOf("exports.requestTransaction = onCall(async (request) => {");
  const requestEnd = source.indexOf("\n});", requestStart);
  const requestBody = source.slice(requestStart, requestEnd + 4);
  assert.match(requestBody, /withdrawalReservations/);
  assert.match(requestBody, /Object\.values\(reservations\)\.reduce/);
  assert.match(requestBody, /available < amount/);
  assert.match(requestBody, /Insufficient available balance after pending withdrawal reservations/);

  const approvalStart = source.indexOf("exports.reviewTransaction = onCall(async (request) => {");
  const approvalEnd = source.indexOf("\n});", approvalStart);
  const approvalBody = source.slice(approvalStart, approvalEnd + 4);
  assert.match(approvalBody, /delete reservations\[id\]/, "approval/rejection must release a withdrawal reservation");
  assert.match(approvalBody, /profile\.balance = Math\.round\(\(balance - amount\) \* 100\) \/ 100/);

  const investmentStart = source.indexOf("exports.activateInvestmentPlan = onCall(async (request) => {");
  const investmentEnd = source.indexOf("\n});", investmentStart);
  const investmentBody = source.slice(investmentStart, investmentEnd + 4);
  assert.match(investmentBody, /reservedWithdrawals/);
  assert.match(investmentBody, /availableBalance/);

  const adminBalanceStart = source.indexOf("exports.adminSetAccountBalances = onCall(async (request) => {");
  const adminBalanceEnd = source.indexOf("\n});", adminBalanceStart);
  const adminBalanceBody = source.slice(adminBalanceStart, adminBalanceEnd + 4);
  assert.match(adminBalanceBody, /reservedBalanceConflict/);
  assert.match(adminBalanceBody, /values\.balance < reserved/);
  assert.match(adminBalanceBody, /Balance cannot be set below funds reserved for pending withdrawals/);

  const deletionStart = source.indexOf("exports.deleteMyAccount = onCall(async (request) => {");
  const deletionEnd = source.indexOf("\n});", deletionStart);
  const deletionBody = source.slice(deletionStart, deletionEnd + 4);
  assert.match(deletionBody, /Object\.keys\(profile\.withdrawalReservations \|\| \{\}\)\.length > 0/);
  assert.match(deletionBody, /Release all reserved withdrawal funds before deleting this account/);
});

test("withdrawal reservation recovery releases only missing or terminal transactions", () => {
  const start = source.indexOf("exports.reconcileWithdrawalReservations = onSchedule(");
  assert.ok(start >= 0, "Missing scheduled withdrawal reservation reconciler");
  const end = source.indexOf("\n});", start);
  assert.ok(end > start, "Could not isolate withdrawal reservation reconciler");
  const body = source.slice(start, end + 4);
  assert.match(body, /secure_transactions/);
  assert.match(body, /Completed.*Rejected.*Cancelled/);
  assert.match(body, /orphaned_reservation/);
  assert.match(body, /terminal_transaction/);
  assert.match(body, /15 \* 60 \* 1000/);
  assert.match(source, /\[id\]: \{ amount, createdAt: Date\.now\(\) \}/);
  assert.match(source, /typeof value === "object" \? value\.amount : value/);
});
