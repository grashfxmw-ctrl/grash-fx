import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../frontend/secure-client.js", import.meta.url), "utf8");

function harness({ verified = true, blocked = false } = {}) {
  let currentUser = null;
  const calls = [];
  const user = {
    uid: "uid-test",
    email: "investor@example.com",
    displayName: "Investor",
    emailVerified: verified,
    async reload() {},
    async updateProfile(profile) { this.displayName = profile.displayName; },
    async sendEmailVerification() { calls.push({ name: "sendEmailVerification" }); }
  };
  const auth = {
    get currentUser() { return currentUser; },
    async createUserWithEmailAndPassword(email, password) {
      calls.push({ name: "createUser", email, password });
      currentUser = { ...user, email, emailVerified: false };
      return { user: currentUser };
    },
    async signInWithEmailAndPassword(email, password) {
      calls.push({ name: "signIn", email, password });
      currentUser = { ...user, emailVerified: verified };
      return { user: currentUser };
    },
    async signOut() { currentUser = null; },
    onAuthStateChanged(callback) { callback(currentUser); return () => {}; }
  };
  const functions = {
    httpsCallable(name) {
      return async (payload) => {
        calls.push({ name, payload });
        if (name === "getMyAccountData") {
          return { data: { profile: { uid: "uid-test", isBlocked: blocked, balance: 0 }, transactions: [] } };
        }
        return { data: { ok: true } };
      };
    }
  };
  const context = { window: {}, globalThis: {}, Error, String, Object };
  vm.runInNewContext(source, context);
  return {
    client: context.window.createGrashSecureClient({ auth: () => auth, functions: () => functions }),
    calls
  };
}

test("sign-up requires a reasonable password and sends verification without creating a profile", async () => {
  const { client, calls } = harness();
  await assert.rejects(client.signUp({ name: "Investor", email: "i@example.com", password: "short" }), /at least 8/);
  const result = await client.signUp({ name: "Investor", email: "I@Example.com", password: "long-password" });
  assert.equal(result.verificationRequired, true);
  assert.ok(calls.some((c) => c.name === "sendEmailVerification"));
  assert.ok(!calls.some((c) => c.name === "createMyProfile"));
});

test("unverified sign-in does not call protected backend endpoints", async () => {
  const { client, calls } = harness({ verified: false });
  const result = await client.signIn({ email: "investor@example.com", password: "long-password" });
  assert.equal(result.verificationRequired, true);
  assert.ok(!calls.some((c) => c.name === "createMyProfile" || c.name === "getMyAccountData"));
});

test("verified sign-in creates a profile and loads only the authenticated account", async () => {
  const { client, calls } = harness();
  const result = await client.signIn({ email: "investor@example.com", password: "long-password" });
  assert.equal(result.profile.uid, "uid-test");
  assert.deepEqual(calls.filter((c) => c.name === "createMyProfile").length, 1);
  assert.deepEqual(calls.filter((c) => c.name === "getMyAccountData").length, 1);
});

test("blocked account is signed out after account data is loaded", async () => {
  const { client, calls } = harness({ blocked: true });
  await assert.rejects(client.signIn({ email: "investor@example.com", password: "long-password" }), /restricted/);
  assert.ok(calls.some((c) => c.name === "getMyAccountData"));
});

test("admin transaction queue calls the protected server endpoint", async () => {
  const { client, calls } = harness();
  await client.signIn({ email: "admin@example.com", password: "long-password" });
  const result = await client.listAdminTransactions({ limit: 20 });
  assert.equal(result.ok, true);
  const queueCall = calls.find((c) => c.name === "adminListTransactions");
  assert.ok(queueCall);
  assert.equal(queueCall.payload.limit, 20);
});
