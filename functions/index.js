const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");
const { randomUUID } = require("node:crypto");

initializeApp();

const db = getDatabase();
const ADMIN_EMAIL = "grashfxmw@gmail.com";
const MAX_REQUEST_AMOUNT = 100000;
const ALLOWED_TYPES = new Set(["Deposit", "Withdrawal"]);

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
  if (!displayName) {
    throw new HttpsError("invalid-argument", "A display name is required.");
  }

  const profileRef = db.ref(`secure_users/${actor.uid}`);
  const result = await profileRef.transaction((current) => {
    if (current !== null) return;
    return {
      uid: actor.uid,
      email: actor.email,
      displayName,
      balance: 0,
      profit: 0,
      referralBonus: 0,
      role: "user",
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
  });

  if (!result.committed && !result.snapshot.exists()) {
    throw new HttpsError("aborted", "Could not create your profile. Please try again.");
  }
  return { ok: true, created: result.committed };
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

  if (type === "Withdrawal" && Number(profile.balance || 0) < amount) {
    throw new HttpsError("failed-precondition", "Insufficient available balance.");
  }

  const id = randomUUID();
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
  await db.ref(`secure_transactions/${id}`).set(record);
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
  const txSnap = await txRef.get();
  if (!txSnap.exists()) throw new HttpsError("not-found", "Transaction not found.");
  const tx = txSnap.val();
  if (tx.status === "Completed" || tx.status === "Rejected") {
    throw new HttpsError("failed-precondition", "This transaction has already been finalized.");
  }
  if (!["Pending", "Processing"].includes(tx.status)) {
    throw new HttpsError("failed-precondition", "Transaction is not in a reviewable state.");
  }

  const userRef = db.ref(`secure_users/${tx.userId}`);
  const userSnap = await userRef.get();
  if (!userSnap.exists()) throw new HttpsError("failed-precondition", "User profile not found.");

  // A Processing transaction can be retried after a function interruption.
  // The profile's server-written processedTransactions marker makes the
  // balance mutation idempotent across retries and concurrent admin calls.
  if (decision === "reject") {
    const claim = await txRef.transaction((current) => {
      if (!current || current.status !== "Pending") return;
      return { ...current, status: "Rejected", reviewedBy: admin.uid, reviewNote: note, updatedAt: Date.now() };
    });
    if (!claim.committed) throw new HttpsError("aborted", "This transaction is already being processed or finalized.");
    await writeAudit(admin.uid, "transaction_rejected", id, { userId: tx.userId, note });
    return { ok: true, status: "Rejected" };
  }

  const claim = await txRef.transaction((current) => {
    if (!current || !["Pending", "Processing"].includes(current.status)) return;
    return { ...current, status: "Processing", reviewedBy: admin.uid, reviewNote: note, updatedAt: Date.now() };
  });
  if (!claim.committed) {
    throw new HttpsError("aborted", "This transaction has already been finalized.");
  }

  const amount = validAmount(tx.amount);
  const balanceResult = await userRef.transaction((profile) => {
    if (!profile) return;
    profile.processedTransactions = profile.processedTransactions || {};
    if (profile.processedTransactions[id] === true) return profile;
    const balance = Number(profile.balance || 0);
    if (tx.type === "Deposit") {
      profile.balance = Math.round((balance + amount) * 100) / 100;
    } else if (tx.type === "Withdrawal") {
      if (balance < amount) return;
      profile.balance = Math.round((balance - amount) * 100) / 100;
    } else {
      return;
    }
    profile.processedTransactions[id] = true;
    profile.updatedAt = Date.now();
    return profile;
  });

  if (!balanceResult.committed) {
    await txRef.update({ status: "Pending", reviewError: "Balance update was not committed", updatedAt: Date.now() });
    throw new HttpsError("failed-precondition", "Balance was not changed; transaction returned to pending review.");
  }

  const updatedProfile = balanceResult.snapshot.val();
  if (updatedProfile?.processedTransactions?.[id] !== true) {
    throw new HttpsError("failed-precondition", "Balance mutation was not recorded; transaction remains available for recovery.");
  }

  await txRef.update({ status: "Completed", reviewError: null, updatedAt: Date.now() });
  await writeAudit(admin.uid, "transaction_approved", id, { userId: tx.userId, type: tx.type, amount });
  return { ok: true, status: "Completed" };
});

/**
 * Returns the signed-in user's own profile and transaction history. The
 * Admin SDK reads the protected paths, but the callable returns only this
 * caller's records and explicitly selected fields.
 */
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
  const snap = await db.ref("secure_users")
    .orderByChild("createdAt")
    .limitToLast(limit)
    .get();
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
  users.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  await writeAudit(admin.uid, "admin_user_directory_viewed", null, { count: users.length });
  return { users };
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
