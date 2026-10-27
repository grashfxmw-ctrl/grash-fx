# GRASH FX staging Firebase setup

This checklist is for a **new, isolated Firebase project** used only to test the secure migration. It does not authorize or perform a production cutover.

## Non-negotiable safety rules

- Create a separate Firebase project with a clearly recognizable name such as `grashfx-staging`.
- Do **not** select or reuse the existing production `grashfx` project.
- Do not put service-account JSON, private keys, passwords, or other secrets in this repository, GitHub issues, screenshots, or chat.
- Do not deploy the staged database rules to production. The legacy website still depends on `platform_data`.
- Use dummy users and fictional amounts only. This preview is not a payment processor and does not verify real-world deposits.

## 1. Create an isolated Firebase project

1. Open the Firebase console and create a new project. Confirm the project ID is not the production project ID.
2. Add a Web app in the staging project and copy its public web configuration into a private local copy of `admin-preview.html` and `secure-preview.html` only when ready to test. These web config values are not service-account credentials, but must still point exclusively to staging.
3. Enable **Authentication → Sign-in method → Email/Password**.
4. Create test accounts for an ordinary user and the administrator email `grashfxmw@gmail.com`. Verify the administrator email. Secure the admin account with a strong unique password and MFA where available.
5. Create a **Realtime Database** instance in the staging project. Record its region and database URL.
6. Set a billing budget alert and review Firebase pricing before enabling Cloud Functions. Do not assume all services are free.

## 2. Configure the local preview

Replace the `REPLACE_WITH_STAGING_...` values in a local, uncommitted copy of each preview HTML file with the staging web app's config. Do not remove the placeholders from the committed branch, and do not copy production config into these pages.

Open the page through a local web server (not by double-clicking the file) so its relative script path `frontend/secure-client.js` resolves. Example from the repository root:

```sh
npx http-server . -p 8080
```

Then open `http://localhost:8080/admin-preview.html` or `http://localhost:8080/secure-preview.html`. The local server package may need to be installed first.

## 3. Configure and deploy to staging only

Before deploying, explicitly select the staging project and verify its ID:

```sh
firebase login
firebase projects:list
firebase use --add
firebase use <YOUR_STAGING_PROJECT_ID>
firebase use
```

Confirm the selected ID is the new staging ID, not `grashfx`. Then review the target files and functions. The repo's `firebase.json` points at `database.rules.json`, which intentionally denies client writes and blocks the legacy tree. This is appropriate for staging tests but **will break the old website if deployed to its production database**.

Deploy only after confirming the active project is staging:

```sh
firebase deploy --only database,functions
```

Do not run the command if the selected project is unclear or points at production. Never deploy these rules to production as part of this staging setup.

## 4. Test with fictional data

- A verified ordinary user can create a zero-balance profile and request a test deposit.
- An ordinary user cannot load the admin queue or approve/reject a transaction.
- The verified allowlisted administrator can load the queue.
- Pending requests can be rejected; approved requests update the staging profile balance exactly once.
- Repeating or racing approval requests does not apply a deposit/withdrawal twice.
- A withdrawal cannot take the test balance below zero.
- Processing transactions can be retried safely after a simulated interruption.
- Direct client writes to balances, roles, transaction statuses, and audit records are denied.
- Inspect staging logs and audit records after each test.

If a test fails, stop and fix it before using the preview further. A passing page syntax test does not prove the deployed Firebase integration is correct.

## 5. Before any production launch

Production requires a separate, explicitly approved cutover plan: migrate the existing UI away from shared `platform_data` writes and localStorage identity; decide how to reconcile old balances and pending requests; verify transaction idempotency and recovery; review payment, privacy, and financial-services compliance; and rehearse rollback. Do not silently import client-side balances or advertise returns as guaranteed.
