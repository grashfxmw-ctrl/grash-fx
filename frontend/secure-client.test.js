"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.join(__dirname, "secure-client.js"),
  "utf8"
);

function createHarness({ emailVerified = true, legacyStatus = "no_match", blocked = false, phoneNumber = "+265991234567" } = {}) {
  const calls = [];
  const user = {
    uid: "test-uid",
    email: "customer@example.com",
    emailVerified,
    phoneNumber,
    displayName: "Test Customer",
    async reload() {},
    async updateProfile() {},
    async sendEmailVerification() {}
  };
  const auth = {
    currentUser: null,
    async createUserWithEmailAndPassword() {
      this.currentUser = user;
      return { user };
    },
    async signInWithEmailAndPassword() {
      this.currentUser = user;
      return { user };
    },
    async signOut() {
      this.currentUser = null;
    },
    onAuthStateChanged() {}
  };
  const account = {
    profile: {
      uid: "test-uid",
      email: user.email,
      displayName: user.displayName,
      balance: 0,
      profit: 0,
      referralBonus: 0,
      role: "user",
      isBlocked: blocked
    },
    transactions: []
  };
  const responses = {
    inspectLegacyAccount: {
      status: legacyStatus,
      message: "Legacy account review is required."
    },
    createMyProfile: { ok: true, created: true },
    getMyAccountData: account
  };
  const firebase = {
    auth: () => auth,
    functions: () => ({
      httpsCallable(name) {
        return async (payload) => {
          calls.push({ name, payload });
          if (name === "getMyAccountData" && blocked) {
            return { data: account };
          }
          return { data: responses[name] };
        };
      }
    })
  };
  const context = { firebase, console };
  context.window = context;
  vm.runInNewContext(source, context, { filename: "secure-client.js" });
  return {
    client: context.createGrashSecureClient(firebase),
    auth,
    calls
  };
}

test("legacy match requires review and does not create a zero-balance profile", async () => {
  const h = createHarness({ legacyStatus: "review_required" });
  const result = await h.client.signIn({
    email: "customer@example.com",
    password: "password123"
  });

  assert.equal(result.ok, false);
  assert.equal(result.legacyReviewRequired, true);
  assert.equal(result.legacyStatus, "review_required");
  assert.equal(h.auth.currentUser, null);
  assert.equal(h.calls.some((call) => call.name === "createMyProfile"), false);
  assert.equal(h.calls.some((call) => call.name === "getMyAccountData"), false);
});

test("new account with no legacy match creates and loads its secure profile", async () => {
  const h = createHarness({ legacyStatus: "no_match" });
  const result = await h.client.signIn({
    email: "customer@example.com",
    password: "password123"
  });

  assert.equal(result.ok, true);
  assert.equal(result.account.profile.uid, "test-uid");
  assert.deepEqual(
    h.calls.map((call) => call.name),
    ["inspectLegacyAccount", "createMyProfile", "getMyAccountData"]
  );
});

test("unverified email is signed out before any backend callable runs", async () => {
  const h = createHarness({ emailVerified: false });
  const result = await h.client.signIn({
    email: "customer@example.com",
    password: "password123"
  });

  assert.equal(result.ok, false);
  assert.equal(result.verificationRequired, true);
  assert.equal(h.auth.currentUser, null);
  assert.equal(h.calls.length, 0);
});

test("blocked secure profile is signed out and rejected", async () => {
  const h = createHarness({ legacyStatus: "no_match", blocked: true });
  await assert.rejects(
    h.client.signIn({ email: "customer@example.com", password: "password123" }),
    /account is restricted/i
  );
  assert.equal(h.auth.currentUser, null);
});

test("secure client exposes verified phone verification methods", () => {
  assert.match(source, /async sendPhoneVerification/);
  assert.match(source, /async completePhoneVerification/);
  assert.match(source, /linkWithCredential/);
  assert.match(source, /PhoneAuthProvider/);
});

test("sign-in pauses secure account creation until a unique verified phone is linked", async () => {
  const h = createHarness({ phoneNumber: null });
  const result = await h.client.signIn({ email: "customer@example.com", password: "password123" });
  assert.equal(result.phoneVerificationRequired, true);
  assert.equal(h.calls.some((call) => call.name === "createMyProfile"), false);
});
