const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getDatabase } = require("firebase-admin/database");
const { randomUUID, createHash } = require("node:crypto");

initializeApp();

const db = getDatabase();
const ADMIN_EMAIL = "grashfxmw@gmail.com";
const MAX_REQUEST_AMOUNT = 100000;
const ALLOWED_TYPES = new Set(["Deposit", "Withdrawal"]);
const MIN_DEPOSIT = 20;
const MIN_INVESTMENT = 50;
const MIN_WITHDRAWAL = 50;
const REFERRAL_REWARD = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
const INVESTMENT_PLANS = Object.freeze({
  "Starter Plan": { rate: 10, min: 50, max: 500 },
  "Basic Plan": { rate: 20, min: 501, max: 2000 },
  "Premium Plan": { rate: 30, min: 2001, max: 5000 },
  "VIP Plan": { rate: 40, min: 5001, max: 100000 }
});

/**
 * Require a verified Firebase Auth identity. Admin authorization is checked
 * against a server-verified token and the allowlisted email; the browser's
 * localStorage and the old client-side PIN are never trusted.
 */
function requireUser(request) {
  const auth = request.auth;
  if (!auth || !auth.uid) {
    throw new HttpsError("unauthenticated", "Please sign in first.");
  }
  if (auth.token.email_verified !== true) {
    throw new HttpsError("permission-denied", "Verify your email before continuing.");
  }
  return { uid: auth.uid, email: String(auth.token.email || "").toLowerCase() };
}

function requireAdmin(request) {
  const user = requireUser(request);
  if (user.email !== ADMIN_EMAIL) {
    throw new HttpsError("permission-denied", "Administrator access required.");
  }
  return user;
}

function validAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_REQUEST_AMOUNT) {
    throw new HttpsError("invalid-argument", "Amount must be greater than zero and within the allowed limit.");
  }
  return Math.round(amount * 100) / 100;
}

function getRequestIp(request) {
  // Use the platform-provided client IP only; do not trust a caller-supplied
  // X-Forwarded-For header. IP is a risk signal, not a unique identity.
  const ip = String(request.rawRequest?.ip || "").trim();
  return ip && ip.length <= 64 ? ip : null;
}

async function recordRegistrationIp(request, uid) {
  const ip = getRequestIp(request);
  if (!ip) return;
  const ipKey = createHash("sha256").update(ip).digest("hex");
  const signalRef = db.ref("secure_ip_signals/" + ipKey);
  let reusedByOtherUid = false;
  await signalRef.transaction((current) => {
    const previous = current && typeof current === "object" ? current : {};
    const priorUids = previous.recentUids && typeof previous.recentUids === "object" ? previous.recentUids : {};
    reusedByOtherUid = Object.keys(priorUids).some((knownUid) => knownUid !== uid);
    const recentUids = { ...priorUids, [uid]: Date.now() };
    const retained = Object.entries(recentUids)
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .slice(0, 10);
    return { recentUids: Object.fromEntries(retained), lastSeenAt: Date.now() };
  });
  if (reusedByOtherUid) {
    await writeAudit(uid, "registration_ip_reused", null, {
      signal: "hashed_ip_seen_with_another_uid",
      policy: "flag_for_review_not_auto_block"
    });
  }
}

async function writeAudit(actorUid, action, transactionId, detail = {}) {
  const auditRef = db.ref("secure_audit").push();
  await auditRef.set({
    actorUid,
    action,
    transactionId: transactionId || null,
    detail,
    createdAt: Date.now()
  });
}

/**
 * Creates a profile only for the authenticated UID. Never accept a balance,
 * profit, role, referral bonus, or admin flag from the client.
 */
exports.createMyProfile = onCall(async (request) => {
  const actor = requireUser(request);
  const displayName = String(request.data?.displayName || "").trim().slice(0, 80);
  const referralCode = String(request.data?.referralCode || "").trim().toUpperCase().slice(0, 32);
  const phoneNumber = String(request.auth.token.phone_number || "").trim();
  if (!displayName) throw new HttpsError("invalid-argument", "A display name is required.");
  if (!/^\+[1-9]\d{7,14}$/.test(phoneNumber)) {
    throw new HttpsError("failed-precondition", "Verify a mobile phone number before opening a GRASH FX account.");
  }
  const profileRef = db.ref("secure_users/" + actor.uid);
  let profileSnap = await profileRef.get();
  const existingProfile = profileSnap.val() || {};
  if (existingProfile.phoneNumber && existingProfile.phoneNumber !== phoneNumber) {
    throw new HttpsError("failed-precondition", "This account is already registered with a different verified phone number. Contact support.");
  }
  const phoneKey = createHash("sha256").update(phoneNumber).digest("hex");
  const phoneRef = db.ref("secure_phone_numbers/" + phoneKey);
  const phoneClaim = await phoneRef.transaction((current) => {
    if (current === null || current === actor.uid) return actor.uid;
    return;
  });
  if (!phoneClaim.committed || String(phoneClaim.snapshot.val()) !== actor.uid) {
    throw new HttpsError("already-exists", "This verified phone number is already linked to another GRASH FX account.");
  }
  let created = false;
  if (!profileSnap.exists()) {
    let referrerUid = null;
    if (referralCode) {
      const referrerSnap = await db.ref("secure_referral_codes/" + referralCode).get();
      if (referrerSnap.exists() && String(referrerSnap.val()) !== actor.uid) referrerUid = String(referrerSnap.val());
    }
    const generatedReferralCode = "G" + actor.uid.replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 31);
    const now = Date.now();
    const profile = { uid: actor.uid, email: actor.email, displayName, phoneNumber, balance: 0, profit: 0, totalProfitEarned: 0, referralBonus: 0, referralCode: generatedReferralCode, referredByUid: referrerUid, referralRewardProcessed: !referrerUid, role: "user", createdAt: now, updatedAt: now };
    const result = await profileRef.transaction((current) => current === null ? profile : undefined);
    created = result.committed;
    profileSnap = result.snapshot;
    if (created) await db.ref("secure_referral_codes/" + generatedReferralCode).set(actor.uid);
  }
  if (!profileSnap.exists()) throw new HttpsError("aborted", "Could not create your profile. Please try again.");
  if (!profileSnap.val()?.phoneNumber) {
    await profileRef.update({ phoneNumber, updatedAt: Date.now() });
  }
  const profile = profileSnap.val() || {};
  const referrerUid = String(profile.referredByUid || "");
  if (referrerUid && profile.referralRewardProcessed !== true && referrerUid !== actor.uid) {
    const referrerRef = db.ref("secure_users/" + referrerUid);
    const rewardResult = await referrerRef.transaction((current) => {
      if (!current) return;
      const rewarded = current.referralRewardedUids || {};
      if (rewarded[actor.uid]) return current;
      return { ...current, balance: Math.round((Number(current.balance || 0) + REFERRAL_REWARD) * 100) / 100, referralBonus: Math.round((Number(current.referralBonus || 0) + REFERRAL_REWARD) * 100) / 100, referralRewardedUids: { ...rewarded, [actor.uid]: true }, updatedAt: Date.now() };
    });
    if (rewardResult.snapshot.exists()) {
      await profileRef.update({ referralRewardProcessed: true, updatedAt: Date.now() });
      await writeAudit(actor.uid, "referral_reward_credited", null, { referrerUid, referredUid: actor.uid, amount: REFERRAL_REWARD, trigger: "verified_registration" });
    }
  }
  if (created) {
    await writeAudit(actor.uid, "secure_profile_created", null, { referralApplied: Boolean(referrerUid) });
    await recordRegistrationIp(request, actor.uid);
  }
  return { ok: true, created, referralCode: profile.referralCode || null };
});

/**
 * Records a deposit/withdrawal request as pending. It does not move money.
 * A future UI migration must call this function instead of writing balances.
 */
exports.requestTransaction = onCall(async (request) => {
  const actor = requireUser(request);
  const type = String(request.data?.type || "");
  if (!ALLOWED_TYPES.has(type)) {
    throw new HttpsError("invalid-argument", "Unsupported transaction type.");
  }
  const amount = validAmount(request.data?.amount);
  const method = String(request.data?.method || "").trim().slice(0, 80);
  if (!method) {
    throw new HttpsError("invalid-argument", "A payment method is required.");
  }

  const profileSnap = await db.ref(`secure_users/${actor.uid}`).get();
  if (!profileSnap.exists()) {
    throw new HttpsError("failed-precondition", "Create your account profile first.");
  }
  const profile = profileSnap.val();
  if (profile.isBlocked === true) {
    throw new HttpsError("permission-denied", "This account is restricted.");
  }

  if (type === "Deposit" && amount < MIN_DEPOSIT) {
    throw new HttpsError("failed-precondition", "Minimum deposit is $20.00.");
  }
  if (type === "Withdrawal" && amount < MIN_WITHDRAWAL) {
    throw new HttpsError("failed-precondition", "Minimum withdrawal is $50.00.");
  }
  const id = randomUUID();
  // Reserve withdrawal funds atomically so multiple pending requests cannot
  // each pass a stale balance check and collectively exceed the balance.
  if (type === "Withdrawal") {
    const reservation = await db.ref(`secure_users/${actor.uid}`).transaction((current) => {
      if (!current || current.isBlocked === true) return;
      const reservations = current.withdrawalReservations || {};
      const reserved = Object.values(reservations).reduce((sum, value) => {
        const n = Number(value);
        return sum + (Number.isFinite(n) && n > 0 ? n : 0);
      }, 0);
      const available = Math.round((Number(current.balance || 0) - reserved) * 100) / 100;
      if (available < amount) return;
      current.withdrawalReservations = { ...reservations, [id]: amount };
      current.updatedAt = Date.now();
      return current;
    });
    if (!reservation.committed) {
      throw new HttpsError("failed-precondition", "Insufficient available balance after pending withdrawal reservations.");
    }
  }

  const record = {
    id,
    userId: actor.uid,
    type,
    amount,
    method,
    status: "Pending",
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  try {
    await db.ref(`secure_transactions/${id}`).set(record);
  } catch (error) {
    if (type === "Withdrawal") {
      await db.ref(`secure_users/${actor.uid}`).transaction((current) => {
        if (!current?.withdrawalReservations?.[id]) return current;
        const reservations = { ...current.withdrawalReservations };
        delete reservations[id];
        current.withdrawalReservations = reservations;
        current.updatedAt = Date.now();
        return current;
      });
    }
    throw error;
  }
  await writeAudit(actor.uid, "transaction_requested", id, { type, amount });
  return { ok: true, transactionId: id, status: "Pending" };
});

/**
 * Admin-only, one-way review of a pending transaction. A transaction-level
 * lock prevents repeat approvals from crediting/debiting the balance twice.
 * This initial endpoint deliberately does not implement referral rewards or
 * scheduled returns until their rules are confirmed and separately tested.
 */
exports.reviewTransaction = onCall(async (request) => {
  const admin = requireAdmin(request);
  const id = String(request.data?.transactionId || "").trim();
  const decision = String(request.data?.decision || "");
  const note = String(request.data?.note || "").trim().slice(0, 500);
  if (!id || !["approve", "reject"].includes(decision)) {
    throw new HttpsError("invalid-argument", "Provide a transaction ID and approve/reject decision.");
  }

  const txRef = db.ref(`secure_transactions/${id}`);
  const initial = await txRef.get();
  if (!initial.exists()) throw new HttpsError("not-found", "Transaction not found.");
  const tx = initial.val();
  if (decision === "approve" && tx.type === "Deposit" && validAmount(tx.amount) < MIN_DEPOSIT) {
    throw new HttpsError("failed-precondition", "Minimum deposit is $20.00.");
  }
  if (decision === "approve" && tx.type === "Withdrawal" && validAmount(tx.amount) < MIN_WITHDRAWAL) {
    throw new HttpsError("failed-precondition", "Minimum withdrawal is $50.00.");
  }
  if (!["Pending", "Processing"].includes(tx.status)) {
    throw new HttpsError("failed-precondition", "Transaction is not in a reviewable state.");
  }
  if (decision === "reject") {
    const rejected = await txRef.transaction((current) => {
      if (!current || current.status !== "Pending") return;
      return { ...current, status: "Rejected", reviewedBy: admin.uid, reviewNote: note, updatedAt: Date.now() };
    });
    if (!rejected.committed) throw new HttpsError("aborted", "This transaction is already being processed or finalized.");
    if (tx.type === "Withdrawal") {
      await db.ref(`secure_users/${tx.userId}`).transaction((profile) => {
        if (!profile?.withdrawalReservations?.[id]) return profile;
        const reservations = { ...profile.withdrawalReservations };
        delete reservations[id];
        profile.withdrawalReservations = reservations;
        profile.updatedAt = Date.now();
        return profile;
      });
    }
    await writeAudit(admin.uid, "transaction_rejected", id, { userId: tx.userId, note });
    return { ok: true, status: "Rejected" };
  }

  // Only one reviewer may own a processing lease at a time. A short lease
  // permits recovery after a crashed invocation without concurrent workers
  // both claiming the same transaction.
  const claimToken = randomUUID();
  const now = Date.now();
  const leaseMs = 5 * 60 * 1000;
  const claim = await txRef.transaction((current) => {
    if (!current) return;
    if (current.status === "Pending") {
      return { ...current, status: "Processing", processingToken: claimToken, processingAt: now,
        reviewedBy: admin.uid, reviewNote: note, updatedAt: now };
    }
    if (current.status === "Processing" && Number(current.processingAt || 0) < now - leaseMs) {
      return { ...current, status: "Processing", processingToken: claimToken, processingAt: now,
        reviewedBy: admin.uid, reviewNote: note, updatedAt: now };
    }
    return;
  });
  if (!claim.committed) {
    throw new HttpsError("aborted", "Another reviewer is processing this transaction. Refresh and retry later.");
  }

  const claimedTx = claim.snapshot.val();
  const amount = validAmount(claimedTx.amount);
  const userRef = db.ref(`secure_users/${claimedTx.userId}`);
  const balanceResult = await userRef.transaction((profile) => {
    if (!profile || profile.isBlocked === true) return;
    profile.processedTransactions = profile.processedTransactions || {};
    if (profile.processedTransactions[id] === true) {
      if (claimedTx.type === "Withdrawal" && profile.withdrawalReservations?.[id]) {
        const reservations = { ...profile.withdrawalReservations };
        delete reservations[id];
        profile.withdrawalReservations = reservations;
        profile.updatedAt = Date.now();
        return profile;
      }
      return profile;
    }
    const balance = Number(profile.balance || 0);
    if (claimedTx.type === "Deposit") {
      profile.balance = Math.round((balance + amount) * 100) / 100;
    } else if (claimedTx.type === "Withdrawal") {
      if (balance < amount) return;
      profile.balance = Math.round((balance - amount) * 100) / 100;
      const reservations = { ...(profile.withdrawalReservations || {}) };
      delete reservations[id];
      profile.withdrawalReservations = reservations;
    } else {
      return;
    }
    profile.processedTransactions[id] = true;
    profile.updatedAt = Date.now();
    return profile;
  });

  if (!balanceResult.committed) {
    await txRef.transaction((current) => {
      if (!current || current.status !== "Processing" || current.processingToken !== claimToken) return;
      return { ...current, status: "Pending", processingToken: null, processingAt: null,
        reviewError: "Balance update was not committed", updatedAt: Date.now() };
    });
    throw new HttpsError("failed-precondition", "Balance was not changed; transaction returned to pending review.");
  }

  const updatedProfile = balanceResult.snapshot.val();
  if (updatedProfile?.processedTransactions?.[id] !== true) {
    throw new HttpsError("failed-precondition", "Balance mutation was not recorded; transaction remains available for recovery.");
  }

  const finalized = await txRef.transaction((current) => {
    if (!current || current.status !== "Processing" || current.processingToken !== claimToken) return;
    return { ...current, status: "Completed", processingToken: null, processingAt: null,
      reviewError: null, updatedAt: Date.now() };
  });
  if (!finalized.committed) {
    // Do not reverse a balance that already has an idempotency marker. A later
    // recovery claim can observe the marker and safely finalize the transaction.
    throw new HttpsError("aborted", "Balance was recorded, but final status needs recovery. Do not approve it again manually.");
  }

  await writeAudit(admin.uid, "transaction_approved", id, { userId: claimedTx.userId, type: claimedTx.type, amount });
  return { ok: true, status: "Completed" };
});

/**
 * Returns the signed-in user's own profile and transaction history. The
 * Admin SDK reads the protected paths, but the callable returns only this
 * caller's records and explicitly selected fields.
 */
/**
 * Deletes a secure account only when it has no money or unresolved activity.
 * Historical transaction/audit records remain for reconciliation. The phone
 * reservation is released only after Firebase Auth account deletion succeeds.
 */
exports.deleteMyAccount = onCall(async (request) => {
  const actor = requireUser(request);
  const profileRef = db.ref("secure_users/" + actor.uid);
  const profileSnap = await profileRef.get();
  if (!profileSnap.exists()) {
    throw new HttpsError("not-found", "Secure account profile not found.");
  }
  const profile = profileSnap.val() || {};
  if (Number(profile.balance || 0) !== 0 ||
      Number(profile.profit || 0) !== 0 ||
      Number(profile.referralBonus || 0) !== 0 ||
      Number(profile.totalProfitEarned || 0) !== 0) {
    throw new HttpsError("failed-precondition", "Settle all balances and recorded profits with support before deleting this account.");
  }
  if (profile.activeInvestment && profile.activeInvestment.status === "Active") {
    throw new HttpsError("failed-precondition", "An active investment must be resolved before account deletion.");
  }
  const transactions = await db.ref("secure_transactions")
    .orderByChild("userId").equalTo(actor.uid).get();
  let unresolvedTransaction = false;
  transactions.forEach((child) => {
    const status = String(child.val()?.status || "");
    if (status === "Pending" || status === "Processing") unresolvedTransaction = true;
  });
  if (unresolvedTransaction) {
    throw new HttpsError("failed-precondition", "Resolve pending transactions before deleting this account.");
  }

  const phoneNumber = String(profile.phoneNumber || "").trim();
  const phoneKey = phoneNumber ? createHash("sha256").update(phoneNumber).digest("hex") : "";
  const phoneRef = phoneKey ? db.ref("secure_phone_numbers/" + phoneKey) : null;
  if (phoneRef) {
    const phoneSnap = await phoneRef.get();
    if (phoneSnap.exists() && String(phoneSnap.val()) !== actor.uid) {
      throw new HttpsError("failed-precondition", "Phone reservation ownership could not be confirmed. Contact support.");
    }
  }
  await writeAudit(actor.uid, "account_deletion_requested", null, { phoneReservationPresent: Boolean(phoneRef) });
  await getAuth().deleteUser(actor.uid);

  const updates = {};
  updates["secure_users/" + actor.uid] = null;
  if (phoneRef) updates["secure_phone_numbers/" + phoneKey] = null;
  if (profile.referralCode) {
    const referralRef = db.ref("secure_referral_codes/" + String(profile.referralCode));
    const referralSnap = await referralRef.get();
    if (String(referralSnap.val() || "") === actor.uid) {
      updates["secure_referral_codes/" + String(profile.referralCode)] = null;
    }
  }
  await db.ref().update(updates);
  await writeAudit(actor.uid, "account_deleted", null, { phoneReservationReleased: Boolean(phoneRef) });
  return { ok: true, deleted: true };
});

exports.getMyAccountData = onCall(async (request) => {
  const actor = requireUser(request);
  const profileSnap = await db.ref(`secure_users/${actor.uid}`).get();
  if (!profileSnap.exists()) {
    throw new HttpsError("failed-precondition", "Create your account profile first.");
  }

  const p = profileSnap.val();
  const txSnap = await db.ref("secure_transactions")
    .orderByChild("userId")
    .equalTo(actor.uid)
    .limitToLast(100)
    .get();
  const transactions = [];
  txSnap.forEach((child) => {
    const tx = child.val() || {};
    transactions.push({
      id: String(tx.id || child.key),
      type: tx.type || "",
      amount: Number(tx.amount || 0),
      method: tx.method || "",
      status: tx.status || "Pending",
      createdAt: tx.createdAt || null,
      updatedAt: tx.updatedAt || null
    });
  });
  transactions.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));

  return {
    profile: {
      uid: p.uid,
      email: p.email,
      displayName: p.displayName,
      balance: Number(p.balance || 0),
      profit: Number(p.profit || 0),
      referralBonus: Number(p.referralBonus || 0),
      totalProfitEarned: Number(p.totalProfitEarned || 0),
      referralCode: p.referralCode || null,
      activeInvestment: p.activeInvestment || null,
      role: p.role || "user",
      isBlocked: p.isBlocked === true,
      createdAt: p.createdAt || null,
      updatedAt: p.updatedAt || null
    },
    transactions
  };
});

/**
 * Admin queue for pending and interrupted transaction reviews. This is
 * bounded and returns only the fields required for the review screen.
 */
exports.adminListTransactions = onCall(async (request) => {
  const admin = requireAdmin(request);
  const limit = Math.min(100, Math.max(1, Number.parseInt(request.data?.limit, 10) || 50));
  const statuses = ["Pending", "Processing"];
  const results = [];

  for (const status of statuses) {
    const snap = await db.ref("secure_transactions")
      .orderByChild("status")
      .equalTo(status)
      .limitToLast(limit)
      .get();
    snap.forEach((child) => {
      const tx = child.val() || {};
      results.push({
        id: String(tx.id || child.key),
        userId: String(tx.userId || ""),
        type: String(tx.type || ""),
        amount: Number(tx.amount || 0),
        method: String(tx.method || ""),
        status: String(tx.status || status),
        createdAt: tx.createdAt || null,
        updatedAt: tx.updatedAt || null
      });
    });
  }

  results.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  await writeAudit(admin.uid, "admin_transaction_queue_viewed", null, { count: results.length });
  return { transactions: results.slice(0, limit) };
});

/**
 * Admin can inspect a single user's safe public profile fields. This is
 * intentionally narrow; do not expose a global all-users endpoint.
 */
/**
 * Admin-only balance editor. Each supplied field is set to an absolute USD
 * amount; a reason and before/after values are recorded in the audit log.
 */
/**
 * Activate an existing seven-day plan using available main-account funds.
 * Rates and amount ranges are fixed on the server, never trusted from UI.
 */
exports.activateInvestmentPlan = onCall(async (request) => {
  const actor = requireUser(request);
  const planName = String(request.data?.planName || "").trim();
  const plan = INVESTMENT_PLANS[planName];
  const amount = validAmount(request.data?.amount);
  if (!plan) throw new HttpsError("invalid-argument", "Select a valid investment plan.");
  if (amount < MIN_INVESTMENT || amount < plan.min || amount > plan.max) {
    throw new HttpsError("failed-precondition", "Investment amount is outside the selected plan range.");
  }
  const profileRef = db.ref("secure_users/" + actor.uid);
  let activation = null;
  const result = await profileRef.transaction((current) => {
    if (!current || current.isBlocked === true) return;
    if (current.activeInvestment && current.activeInvestment.status === "Active") return;
    const balance = Math.round(Number(current.balance || 0) * 100) / 100;
    const reservedWithdrawals = Object.values(current.withdrawalReservations || {}).reduce((sum, value) => {
      const n = Number(value);
      return sum + (Number.isFinite(n) && n > 0 ? n : 0);
    }, 0);
    const availableBalance = Math.round((balance - reservedWithdrawals) * 100) / 100;
    if (availableBalance < amount) return;
    const now = Date.now();
    activation = { id: randomUUID(), planName, principal: amount, dailyRate: plan.rate, durationDays: 7, startAt: now, lastProfitAt: now, creditedDays: 0, accumulatedProfit: 0, status: "Active" };
    return { ...current, balance: Math.round((balance - amount) * 100) / 100, activeInvestment: activation, updatedAt: now };
  });
  if (!result.committed) {
    const latest = result.snapshot.val();
    if (!latest) throw new HttpsError("failed-precondition", "Secure account profile not found.");
    if (latest.isBlocked === true) throw new HttpsError("permission-denied", "This account is restricted.");
    if (latest.activeInvestment && latest.activeInvestment.status === "Active") throw new HttpsError("failed-precondition", "An investment plan is already active.");
    throw new HttpsError("failed-precondition", "Insufficient available balance after pending withdrawal reservations.");
  }
  await writeAudit(actor.uid, "investment_plan_activated", activation.id, { planName, principal: amount, dailyRate: plan.rate, durationDays: 7 });
  return { ok: true, investment: activation };
});

/**
 * Scheduled processor credits elapsed 24-hour cycles exactly once, up to seven.
 * On the seventh cycle, accumulated profit and the original principal are
 * transferred to the main balance exactly once.
 */
exports.processScheduledInvestmentProfits = onSchedule("every 15 minutes", async () => {
  const usersSnap = await db.ref("secure_users").get();
  const now = Date.now();
  const tasks = [];
  usersSnap.forEach((child) => {
    const uid = child.key;
    tasks.push((async () => {
      let cyclesCredited = 0;
      let creditedTotal = 0;
      let matured = false;
      const profileRef = db.ref("secure_users/" + uid);
      const result = await profileRef.transaction((current) => {
        cyclesCredited = 0; creditedTotal = 0; matured = false;
        if (!current || !current.activeInvestment || current.activeInvestment.status !== "Active") return;
        const inv = { ...current.activeInvestment };
        let lastProfitAt = Number(inv.lastProfitAt || inv.startAt || now);
        let creditedDays = Number(inv.creditedDays || 0);
        let profitBalance = Math.round(Number(current.profit || 0) * 100) / 100;
        let lifetimeProfit = Math.round(Number(current.totalProfitEarned || 0) * 100) / 100;
        let balance = Math.round(Number(current.balance || 0) * 100) / 100;
        while (creditedDays < 7 && now - lastProfitAt >= DAY_MS) {
          const payout = Math.round(Number(inv.principal) * (Number(inv.dailyRate) / 100) * 100) / 100;
          profitBalance = Math.round((profitBalance + payout) * 100) / 100;
          lifetimeProfit = Math.round((lifetimeProfit + payout) * 100) / 100;
          inv.accumulatedProfit = Math.round((Number(inv.accumulatedProfit || 0) + payout) * 100) / 100;
          lastProfitAt += DAY_MS; creditedDays += 1; cyclesCredited += 1;
          creditedTotal = Math.round((creditedTotal + payout) * 100) / 100;
        }
        if (!cyclesCredited) return;
        inv.lastProfitAt = lastProfitAt; inv.creditedDays = creditedDays;
        if (creditedDays >= 7) {
          balance = Math.round((balance + profitBalance + Number(inv.principal || 0)) * 100) / 100;
          inv.principalReturned = true; inv.principalReturnedAt = now;
          profitBalance = 0; inv.status = "Completed"; inv.completedAt = now; matured = true;
        }
        inv.updatedAt = now;
        return { ...current, balance, profit: profitBalance, totalProfitEarned: lifetimeProfit, activeInvestment: inv, updatedAt: now };
      });
      if (result.committed && cyclesCredited) {
        await writeAudit("system:investment-scheduler", matured ? "investment_matured" : "investment_profit_credited", result.snapshot.val()?.activeInvestment?.id, { uid, cyclesCredited, creditedTotal, principalReturned: matured ? Number(result.snapshot.val()?.activeInvestment?.principal || 0) : 0, matured });
      }
    })().catch((error) => console.error("Investment profit processing failed for user", uid, error)));
  });
  await Promise.all(tasks);
});
exports.adminSetAccountBalances = onCall(async (request) => {
  const admin = requireAdmin(request);
  const uid = String(request.data?.uid || "").trim();
  const reason = String(request.data?.reason || "").trim().slice(0, 500);
  if (uid && !/^[A-Za-z0-9_-]{1,128}$/.test(uid)) {
    throw new HttpsError("invalid-argument", "Customer UID format is invalid.");
  }
  if (!uid || !reason) throw new HttpsError("invalid-argument", "Customer UID and adjustment reason are required.");
  const fields = ["balance", "profit", "referralBonus"];
  const supplied = fields.filter((field) => Object.prototype.hasOwnProperty.call(request.data || {}, field));
  if (!supplied.length) throw new HttpsError("invalid-argument", "Provide at least one balance field to update.");
  const values = {};
  for (const field of supplied) {
    const amount = Number(request.data[field]);
    if (!Number.isFinite(amount) || amount < 0 || amount > 100000000) {
      throw new HttpsError("invalid-argument", field + " must be between 0 and 100,000,000.");
    }
    values[field] = Math.round(amount * 100) / 100;
  }
  const profileRef = db.ref("secure_users/" + uid);
  let before = null;
  const result = await profileRef.transaction((current) => {
    if (!current) return;
    before = {};
    for (const field of supplied) before[field] = Math.round(Number(current[field] || 0) * 100) / 100;
    const next = { ...current, updatedAt: Date.now() };
    for (const field of supplied) next[field] = values[field];
    return next;
  });
  if (!result.committed) throw new HttpsError("not-found", "Customer account not found or no change was committed.");
  await writeAudit(admin.uid, "admin_balance_adjustment", null, { uid, reason, before, after: values });
  return { ok: true, uid, before, after: values };
});
exports.adminGetUserProfile = onCall(async (request) => {
  requireAdmin(request);
  const uid = String(request.data?.uid || "").trim();
  if (!uid) throw new HttpsError("invalid-argument", "User UID is required.");
  const snap = await db.ref(`secure_users/${uid}`).get();
  if (!snap.exists()) throw new HttpsError("not-found", "User not found.");
  const p = snap.val();
  return {
    uid: p.uid,
    email: p.email,
    displayName: p.displayName,
    balance: Number(p.balance || 0),
    profit: Number(p.profit || 0),
    referralBonus: Number(p.referralBonus || 0),
    totalProfitEarned: Number(p.totalProfitEarned || 0),
    referralCode: p.referralCode || null,
    activeInvestment: p.activeInvestment || null,
    role: p.role || "user",
    isBlocked: p.isBlocked === true,
    createdAt: p.createdAt || null
  };
});

/**
 * Bounded administrator directory for the secure customer preview. Returns
 * only the fields needed for customer support; never returns auth tokens,
 * payment credentials, or processed transaction markers.
 */
exports.adminListUsers = onCall(async (request) => {
  const admin = requireAdmin(request);
  const limit = Math.min(100, Math.max(1, Number.parseInt(request.data?.limit, 10) || 50));
  const cursorCreatedAt = Number(request.data?.cursorCreatedAt);
  const cursorUid = String(request.data?.cursorUid || "").trim();
  let query = db.ref("secure_users").orderByChild("createdAt");
  const hasCursor = Number.isFinite(cursorCreatedAt) && cursorCreatedAt > 0 && /^[A-Za-z0-9_-]{1,128}$/.test(cursorUid);
  if (hasCursor) query = query.endAt(cursorCreatedAt, cursorUid);
  const snap = await query.limitToLast(limit + (hasCursor ? 2 : 1)).get();
  const users = [];
  snap.forEach((child) => {
    const p = child.val() || {};
    users.push({
      uid: String(p.uid || child.key),
      email: String(p.email || ""),
      displayName: String(p.displayName || ""),
      balance: Number(p.balance || 0),
      profit: Number(p.profit || 0),
      referralBonus: Number(p.referralBonus || 0),
      role: String(p.role || "user"),
      isBlocked: p.isBlocked === true,
      createdAt: p.createdAt || null
    });
  });
  users.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0) || b.uid.localeCompare(a.uid));
  let page = hasCursor ? users.filter((u) => !(Number(u.createdAt) === cursorCreatedAt && u.uid === cursorUid)) : users;
  const hasMore = page.length > limit;
  page = page.slice(0, limit);
  const next = hasMore && page.length ? { createdAt: Number(page[page.length - 1].createdAt || 0), uid: page[page.length - 1].uid } : null;
  await writeAudit(admin.uid, "admin_user_directory_viewed", null, { count: page.length, hasMore });
  return { users: page, hasMore, nextCursor: next };
});



/**
 * Read-only legacy-account matching for the migration cutover.
 *
 * This endpoint deliberately does NOT copy balances, profit, role, referral
 * rewards, passwords, or investment-plan values. The legacy platform_data tree
 * was maintained by the browser app and its integrity/rules have not yet been
 * independently verified. A unique email match is therefore only a review
 * candidate, never authority to credit an account.
 */
exports.inspectLegacyAccount = onCall(async (request) => {
  const actor = requireUser(request);
  if (!actor.email) {
    throw new HttpsError("failed-precondition", "Your verified account has no email address.");
  }

  const legacySnap = await db.ref("platform_data/users").get();
  const raw = legacySnap.val();
  const legacyUsers = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" ? Object.values(raw) : [];
  const matches = legacyUsers.filter((entry) =>
    entry && typeof entry === "object" &&
    String(entry.email || "").trim().toLowerCase() === actor.email
  );

  let status;
  if (matches.length === 0) {
    status = "no_match";
  } else if (matches.length > 1) {
    status = "ambiguous";
  } else if (matches[0].isBlocked === true) {
    status = "blocked";
  } else {
    status = "review_required";
  }

  await writeAudit(actor.uid, "legacy_account_inspected", null, {
    status,
    matchCount: matches.length
  });

  // Do not return the legacy record, password, balance, or any other
  // client-maintained financial/accounting fields.
  return {
    status,
    matchCount: matches.length,
    migrationCompleted: false,
    message: status === "review_required"
      ? "A matching legacy record was found. Financial values require server-side reconciliation before migration."
      : status === "no_match"
        ? "No legacy account matched this verified email."
        : status === "ambiguous"
          ? "Multiple legacy records matched this email. Support review is required."
          : "This legacy account is restricted. Contact support."
  };
});


/**
 * Stage a legacy account for an administrator's financial reconciliation.
 * This is the first migration operation: it preserves reviewable business
 * fields without trusting them as authoritative or crediting a new profile.
 * Passwords and authentication secrets are never copied.
 */
exports.adminStageLegacyMigration = onCall(async (request) => {
  const admin = requireAdmin(request);
  const email = String(request.data?.email || "").trim().toLowerCase();
  if (!email || !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) {
    throw new HttpsError("invalid-argument", "Enter a valid legacy customer email.");
  }

  const legacySnap = await db.ref("platform_data/users").get();
  const raw = legacySnap.val();
  const legacyUsers = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" ? Object.values(raw) : [];
  const matches = legacyUsers.filter((entry) =>
    entry && typeof entry === "object" &&
    String(entry.email || "").trim().toLowerCase() === email
  );

  if (matches.length === 0) {
    throw new HttpsError("not-found", "No legacy customer matches that email.");
  }
  if (matches.length !== 1) {
    throw new HttpsError("failed-precondition", "Multiple legacy records match. Resolve duplicates manually before staging.");
  }

  const legacy = matches[0];
  if (legacy.isBlocked === true) {
    throw new HttpsError("failed-precondition", "This legacy account is blocked and requires a separate support review.");
  }

  const migrationId = Buffer.from(email).toString("base64url");
  const stageRef = db.ref(`migration_review/${migrationId}`);
  const existing = await stageRef.get();
  if (existing.exists()) {
    const saved = existing.val();
    await writeAudit(admin.uid, "legacy_migration_stage_reopened", null, { migrationId });
    return {
      ok: true,
      alreadyStaged: true,
      migrationId,
      status: saved.status || "needs_reconciliation",
      message: "This account is already staged. Existing review data was not overwritten."
    };
  }

  const now = Date.now();
  const staged = {
    migrationId,
    legacyId: String(legacy.id || ""),
    email,
    displayName: String(legacy.name || "").trim().slice(0, 100),
    // These values are snapshots for comparison only; none are credited.
    legacySnapshot: {
      balance: Number.isFinite(Number(legacy.balance)) ? Number(legacy.balance) : null,
      profit: Number.isFinite(Number(legacy.profit)) ? Number(legacy.profit) : null,
      referralBonus: Number.isFinite(Number(legacy.refBonus)) ? Number(legacy.refBonus) : null,
      referredBy: legacy.referredBy ? String(legacy.referredBy).slice(0, 120) : null,
      referralCode: legacy.referralCode ? String(legacy.referralCode).slice(0, 40) : null,
      activePlan: legacy.activePlan ? String(legacy.activePlan).slice(0, 80) : "None",
      planAmount: Number.isFinite(Number(legacy.planAmount)) ? Number(legacy.planAmount) : null,
      planRate: Number.isFinite(Number(legacy.planRate)) ? Number(legacy.planRate) : null,
      planStartTime: legacy.planStartTime || null,
      lastProfitTime: legacy.lastProfitTime || null,
      isBlocked: legacy.isBlocked === true,
      warningMsg: String(legacy.warningMsg || "").slice(0, 500)
    },
    status: "needs_reconciliation",
    balanceVerified: false,
    profitVerified: false,
    planVerified: false,
    referralVerified: false,
    stagedBy: admin.uid,
    stagedAt: now,
    updatedAt: now
  };

  await stageRef.set(staged);
  await writeAudit(admin.uid, "legacy_migration_staged", null, {
    migrationId,
    legacyId: staged.legacyId,
    status: staged.status
  });

  return {
    ok: true,
    alreadyStaged: false,
    migrationId,
    status: staged.status,
    message: "Legacy account staged for review. No secure profile or balance was changed."
  };
});

/**
 * Return the staged migration record to an administrator for reconciliation.
 * Financial values remain explicitly marked unverified until a separate,
 * audited approval operation is implemented.
 */
exports.adminGetLegacyMigration = onCall(async (request) => {
  const admin = requireAdmin(request);
  const migrationId = String(request.data?.migrationId || "").trim();
  if (!migrationId || migrationId.length > 256) {
    throw new HttpsError("invalid-argument", "A valid migration ID is required.");
  }
  const snap = await db.ref(`migration_review/${migrationId}`).get();
  if (!snap.exists()) throw new HttpsError("not-found", "Migration review record not found.");
  const record = snap.val();
  await writeAudit(admin.uid, "legacy_migration_review_opened", null, { migrationId });
  return record;
});

/**
 * Bounded administrator audit viewer. Returns only operational audit fields
 * and never exposes arbitrary database paths or raw customer credentials.
 */
exports.adminListAuditLogs = onCall(async (request) => {
  const admin = requireAdmin(request);
  const limit = Math.min(100, Math.max(1, Number.parseInt(request.data?.limit, 10) || 50));
  const snap = await db.ref("secure_audit").limitToLast(limit).get();
  const entries = [];
  snap.forEach((child) => {
    const item = child.val() || {};
    entries.push({
      id: String(child.key || ""),
      actorUid: String(item.actorUid || ""),
      action: String(item.action || ""),
      transactionId: item.transactionId ? String(item.transactionId) : null,
      detail: item.detail && typeof item.detail === "object" ? item.detail : {},
      createdAt: Number(item.createdAt || 0)
    });
  });
  entries.sort((a, b) => b.createdAt - a.createdAt);
  await writeAudit(admin.uid, "admin_audit_log_viewed", null, { count: entries.length });
  return { entries };
});
