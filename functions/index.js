const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentCreated } = require("firebase-functions/v2/database");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
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
  if (tx.status !== "Pending") {
    throw new HttpsError("failed-precondition", "Only pending transactions can be reviewed.");
  }

  const userRef = db.ref(`secure_users/${tx.userId}`);
  const userSnap = await userRef.get();
  if (!userSnap.exists()) throw new HttpsError("failed-precondition", "User profile not found.");

  // Claim the pending transaction first. If another admin request wins, the
  // second request cannot process the same transaction again.
  const claim = await txRef.transaction((current) => {
    if (!current || current.status !== "Pending") return;
    return {
      ...current,
      status: decision === "approve" ? "Processing" : "Rejected",
      reviewedBy: admin.uid,
      reviewNote: note,
      updatedAt: Date.now()
    };
  });
  if (!claim.committed) {
    throw new HttpsError("aborted", "This transaction has already been reviewed.");
  }

  if (decision === "reject") {
    await writeAudit(admin.uid, "transaction_rejected", id, { userId: tx.userId, note });
    return { ok: true, status: "Rejected" };
  }

  const amount = validAmount(tx.amount);
  const balanceResult = await userRef.transaction((profile) => {
    if (!profile) return;
    const balance = Number(profile.balance || 0);
    if (tx.type === "Deposit") {
      profile.balance = Math.round((balance + amount) * 100) / 100;
    } else if (tx.type === "Withdrawal") {
      if (balance < amount) return;
      profile.balance = Math.round((balance - amount) * 100) / 100;
    } else {
      return;
    }
    profile.updatedAt = Date.now();
    return profile;
  });

  if (!balanceResult.committed) {
    await txRef.update({ status: "Pending", reviewError: "Balance update was not committed", updatedAt: Date.now() });
    throw new HttpsError("failed-precondition", "Balance was not changed; transaction returned to pending review.");
  }

  await txRef.update({ status: "Completed", updatedAt: Date.now() });
  await writeAudit(admin.uid, "transaction_approved", id, { userId: tx.userId, type: tx.type, amount });
  return { ok: true, status: "Completed" };
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
