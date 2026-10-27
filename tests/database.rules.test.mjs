import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { ref, get, set } from "firebase/database";

let env;
before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-grashfx-security",
    database: { rules: readFileSync(new URL("../database.rules.json", import.meta.url), "utf8") }
  });
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.database();
    await set(ref(db, "secure_users/user-a"), { uid: "user-a", email: "a@example.com", balance: 100, role: "user" });
    await set(ref(db, "secure_users/user-b"), { uid: "user-b", email: "b@example.com", balance: 50, role: "user" });
    await set(ref(db, "secure_transactions/tx-a"), { id: "tx-a", userId: "user-a", type: "Deposit", amount: 10, status: "Pending" });
    await set(ref(db, "secure_audit/log-a"), { action: "test" });
    await set(ref(db, "platform_data/users"), [{ id: "legacy-user", balance: 999 }]);
  });
});
after(async () => { if (env) await env.cleanup(); });

test("users can read only their own profile", async () => {
  const db = env.authenticatedContext("user-a", { email: "a@example.com", email_verified: true }).database();
  await assertSucceeds(get(ref(db, "secure_users/user-a")));
  await assertFails(get(ref(db, "secure_users/user-b")));
});

test("clients cannot write profile data or financial permissions", async () => {
  const db = env.authenticatedContext("user-a", { email: "a@example.com", email_verified: true }).database();
  await assertFails(set(ref(db, "secure_users/user-a/balance"), 1000000));
  await assertFails(set(ref(db, "secure_users/user-a/role"), "admin"));
});

test("users can read their own transaction only", async () => {
  const db = env.authenticatedContext("user-a", { email: "a@example.com", email_verified: true }).database();
  await assertSucceeds(get(ref(db, "secure_transactions/tx-a")));
  await assertFails(get(ref(db, "secure_transactions/tx-b")));
});

test("audit and legacy global data are not client accessible", async () => {
  const db = env.authenticatedContext("user-a", { email: "a@example.com", email_verified: true }).database();
  await assertFails(get(ref(db, "secure_audit/log-a")));
  await assertFails(get(ref(db, "platform_data/users")));
  await assertFails(set(ref(db, "platform_data/users"), []));
});

test("unauthenticated clients cannot read protected data", async () => {
  const db = env.unauthenticatedContext().database();
  await assertFails(get(ref(db, "secure_users/user-a")));
  await assertFails(get(ref(db, "secure_transactions/tx-a")));
  await assertFails(get(ref(db, "secure_audit/log-a")));
});

test("clients cannot create or alter transaction records directly", async () => {
  const db = env.authenticatedContext("user-a", { email: "a@example.com", email_verified: true }).database();
  await assertFails(set(ref(db, "secure_transactions/tx-a/status"), "Completed"));
  await assertFails(set(ref(db, "secure_transactions/forged"), { userId: "user-a", amount: 999999, status: "Completed" }));
});

test("users cannot list the full protected profile or transaction collections", async () => {
  const db = env.authenticatedContext("user-a", { email: "a@example.com", email_verified: true }).database();
  await assertFails(get(ref(db, "secure_users")));
  await assertFails(get(ref(db, "secure_transactions")));
});
