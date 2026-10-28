import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const clientSource = await readFile(new URL("../frontend/secure-client.js", import.meta.url), "utf8");

function createHarness({ verified = true } = {}) {
  const calls = [];
  let currentUser = null;
  let signedOut = false;
  const user = {
    uid: "auth-user-1",
    email: "person@example.com",
    emailVerified: verified,
    displayName: "Test Person",
    async reload() {},
    async updateProfile(profile) { this.displayName = profile.displayName; },
    async sendEmailVerification() { calls.push("sendEmailVerification"); }
  };

  const auth = {
    get currentUser() { return currentUser; },
    async createUserWithEmailAndPassword(email, password) {
      calls.push({ type: "createUser", email, password });
      currentUser = user;
      return { user };
    },
    async signInWithEmailAndPassword(email, password) {
      calls.push({ type: "signIn", email, password });
      currentUser = user;
      return { user };
    },
    async signOut() {
      calls.push("signOut");
      currentUser = null;
      signedOut = true;
    },
    onAuthStateChanged() { return () => {}; }
  };

  const functions = {
    httpsCallable(name) {
      return async (payload) => {
        calls.push({ type: "callable", name, payload });
        if (name === "getMyAccountData") {
          return { data: { profile: { uid: user.uid, balance: 0 }, transactions: [] } };
        }
        return { data: { ok: true } };
      };
    }
  };

  const window = {};
  vm.runInNewContext(clientSource, { window, globalThis: window });
  const client = window.createGrashSecureClient({
    auth: () => auth,
    functions: () => functions
  });
  return { client, calls, get signedOut() { return signedOut; } };
}

test("secure signup sends verification and does not create a profile before verification", async () => {
  const h = createHarness({ verified: false });
  const result = await h.client.signUp({
    name: "Test Person",
    email: " Person@Example.com ",
    password: "long-test-password"
  });

  assert.deepEqual(result, { ok: true, verificationRequired: true });
  assert.ok(h.calls.some((call) => call?.type === "createUser" && call.email === "person@example.com"));
  assert.ok(h.calls.includes("sendEmailVerification"));
  assert.ok(h.calls.includes("signOut"));
  assert.equal(h.calls.some((call) => call?.type === "callable"), false);
});

test("secure sign-in rejects an unverified account without creating a profile", async () => {
  const h = createHarness({ verified: false });
  const result = await h.client.signIn({
    email: "person@example.com",
    password: "long-test-password"
  });

  assert.deepEqual(result, { ok: false, verificationRequired: true });
  assert.ok(h.calls.includes("signOut"));
  assert.equal(h.calls.some((call) => call?.type === "callable"), false);
});

test("verified sign-in creates the server-owned profile and loads account data", async () => {
  const h = createHarness({ verified: true });
  const result = await h.client.signIn({
    email: "person@example.com",
    password: "long-test-password"
  });

  assert.equal(result.profile.uid, "auth-user-1");
  const callableNames = h.calls.filter((call) => call?.type === "callable").map((call) => call.name);
  assert.deepEqual(callableNames, ["createMyProfile", "getMyAccountData"]);
});
