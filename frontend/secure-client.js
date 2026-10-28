/**
 * GRASH FX secure frontend adapter. Keep isolated until the existing UI is migrated.
 *
 * This module deliberately does not read/write legacy platform_data, localStorage
 * identity records, balances, or transaction arrays. Wire it into the UI only as
 * part of the complete frontend cutover documented in SECURITY_MIGRATION.md.
 *
 * Requires Firebase compat App, Auth, and Functions SDKs to be loaded by the page.
 */
(function (global) {
  "use strict";

  function createGrashSecureClient(firebase) {
    if (!firebase || typeof firebase.auth !== "function" ||
        typeof firebase.functions !== "function") {
      throw new Error("Firebase Auth and Functions SDKs must be loaded first.");
    }

    const auth = firebase.auth();
    const functions = firebase.functions();
    let phoneVerificationId = null;

    const call = (name, payload) => functions.httpsCallable(name)(payload || {})
      .then((result) => result.data);

    async function requireVerifiedUser() {
      const user = auth.currentUser;
      if (!user) throw new Error("Please sign in first.");
      await user.reload();
      if (!auth.currentUser || !auth.currentUser.emailVerified) {
        throw new Error("Verify your email, then sign in again.");
      }
      return auth.currentUser;
    }

    return Object.freeze({
      onAuthStateChanged(callback) {
        return auth.onAuthStateChanged(callback);
      },

      async signUp({ name, email, password, referralCode }) {
        const displayName = String(name || "").trim();
        const normalizedEmail = String(email || "").trim().toLowerCase();
        if (!displayName) throw new Error("Enter your name.");
        if (!normalizedEmail) throw new Error("Enter your email address.");
        if (String(password || "").length < 8) {
          throw new Error("Use a password with at least 8 characters.");
        }

        const credential = await auth.createUserWithEmailAndPassword(
          normalizedEmail,
          String(password)
        );
        if (displayName) {
          await credential.user.updateProfile({ displayName });
        }
        await credential.user.sendEmailVerification();
        // Retain only a referral code (not identity data) for this browser session.
        if (typeof sessionStorage !== "undefined") {
          const code = String(referralCode || "").trim().toUpperCase();
          if (code) sessionStorage.setItem("grash_pending_referral_code", code.slice(0, 32));
        }
        // Profile creation is intentionally deferred until email is verified.
        await auth.signOut();
        return { ok: true, verificationRequired: true };
      },

      async signIn({ email, password }) {
        const credential = await auth.signInWithEmailAndPassword(
          String(email || "").trim().toLowerCase(),
          String(password || "")
        );
        await credential.user.reload();
        if (!auth.currentUser || !auth.currentUser.emailVerified) {
          await auth.signOut();
          return { ok: false, verificationRequired: true };
        }

        // Never silently create a zero-balance secure profile for a legacy
        // customer. A matching legacy record must go through reconciliation.
        const legacy = await call("inspectLegacyAccount");
        if (legacy.status !== "no_match") {
          await auth.signOut();
          return {
            ok: false,
            legacyReviewRequired: true,
            legacyStatus: legacy.status,
            message: legacy.message
          };
        }

        if (!credential.user.phoneNumber) {
          return { ok: false, phoneVerificationRequired: true };
        }
        const referralCode = typeof sessionStorage !== "undefined"
          ? sessionStorage.getItem("grash_pending_referral_code") || ""
          : "";
        await call("createMyProfile", {
          displayName: credential.user.displayName || "GRASH FX Investor",
          referralCode
        });
        if (typeof sessionStorage !== "undefined") sessionStorage.removeItem("grash_pending_referral_code");
        const account = await call("getMyAccountData");
        if (account.profile.isBlocked) {
          await auth.signOut();
          throw new Error("This account is restricted. Contact support.");
        }
        return { ok: true, account };
      },

      async sendPhoneVerification({ phoneNumber, recaptchaVerifier }) {
        await requireVerifiedUser();
        const normalized = String(phoneNumber || "").trim();
        if (!/^\+[1-9]\d{7,14}$/.test(normalized)) {
          throw new Error("Enter your phone number in international format, e.g. +265XXXXXXXXX.");
        }
        if (!recaptchaVerifier) throw new Error("Phone verification security check is not ready. Refresh and try again.");
        const provider = new firebase.auth.PhoneAuthProvider();
        phoneVerificationId = await provider.verifyPhoneNumber(normalized, recaptchaVerifier);
        return { ok: true };
      },

      async completePhoneVerification({ code, displayName }) {
        const user = await requireVerifiedUser();
        if (!phoneVerificationId) throw new Error("Request a verification code first.");
        const normalizedCode = String(code || "").trim();
        if (!/^\\d{6}$/.test(normalizedCode)) throw new Error("Enter the six-digit SMS code.");
        const credential = firebase.auth.PhoneAuthProvider.credential(phoneVerificationId, normalizedCode);
        await user.linkWithCredential(credential);
        await user.reload();
        await user.getIdToken(true);
        if (!auth.currentUser || !auth.currentUser.phoneNumber) throw new Error("Phone verification did not complete.");
        phoneVerificationId = null;
        const referralCode = typeof sessionStorage !== "undefined"
          ? sessionStorage.getItem("grash_pending_referral_code") || ""
          : "";
        await call("createMyProfile", { displayName: displayName || user.displayName || "GRASH FX Investor", referralCode });
        if (typeof sessionStorage !== "undefined") sessionStorage.removeItem("grash_pending_referral_code");
        const account = await call("getMyAccountData");
        if (account.profile.isBlocked) {
          await auth.signOut();
          throw new Error("This account is restricted. Contact support.");
        }
        return { ok: true, account };
      },

      async signOut() {
        await auth.signOut();
      },

      async inspectLegacyAccount() {
        await requireVerifiedUser();
        return call("inspectLegacyAccount");
      },

      async stageLegacyMigration(email) {
        await requireVerifiedUser();
        return call("adminStageLegacyMigration", { email });
      },

      async getLegacyMigration(migrationId) {
        await requireVerifiedUser();
        return call("adminGetLegacyMigration", { migrationId });
      },

      async loadAccount() {
        await requireVerifiedUser();
        return call("getMyAccountData");
      },

      async activateInvestmentPlan({ planName, amount }) {
        await requireVerifiedUser();
        return call("activateInvestmentPlan", { planName, amount });
      },

      async adminSetAccountBalances({ uid, balance, profit, referralBonus, reason }) {
        await requireVerifiedUser();
        return call("adminSetAccountBalances", { uid, balance, profit, referralBonus, reason });
      },

      async requestDeposit({ amount, method }) {
        await requireVerifiedUser();
        return call("requestTransaction", { type: "Deposit", amount, method });
      },

      async requestWithdrawal({ amount, method }) {
        await requireVerifiedUser();
        return call("requestTransaction", { type: "Withdrawal", amount, method });
      },

      async reviewTransaction({ transactionId, decision, note }) {
        await requireVerifiedUser();
        return call("reviewTransaction", { transactionId, decision, note });
      },

      async listAdminTransactions({ limit } = {}) {
        await requireVerifiedUser();
        return call("adminListTransactions", { limit });
      },

      async listAdminUsers({ limit, cursorCreatedAt, cursorUid } = {}) {
        await requireVerifiedUser();
        return call("adminListUsers", { limit, cursorCreatedAt, cursorUid });
      },

      async getAdminUserProfile(uid) {
        await requireVerifiedUser();
        return call("adminGetUserProfile", { uid });
      },

      async listAdminAuditLogs({ limit } = {}) {
        await requireVerifiedUser();
        return call("adminListAuditLogs", { limit });
      }
    });
  }

  global.createGrashSecureClient = createGrashSecureClient;
})(typeof window !== "undefined" ? window : globalThis);
