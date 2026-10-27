# GRASH FX Cloud Functions (migration branch)

This folder is a **staged backend foundation**, not a deployed or production-ready service.

> **Do not deploy `database.rules.json` yet.** Those target rules intentionally deny all client access to the legacy `platform_data` tree and would break the current live frontend until its migration is complete.

## Current endpoints

- `createMyProfile`: creates a zero-balance profile for the signed-in UID.
- `requestTransaction`: records a pending deposit or withdrawal request; it does not move funds.
- `getMyAccountData`: returns the signed-in user's limited profile and up to 100 of their own transaction records.
- `reviewTransaction`: administrator-only approval/rejection for records in the new `secure_transactions` tree.
- `adminListTransactions`: administrator-only, bounded queue for pending and interrupted transaction reviews.
- `adminGetUserProfile`: returns a limited profile view to the administrator.

## Important safety status

- The existing website still uses the legacy `platform_data` database shape and has **not** been migrated to these endpoints.
- These functions use new `secure_users`, `secure_transactions`, and `secure_audit` paths. They are not compatible with the old page until its authentication, profile, transaction, and admin flows are migrated.
- No Firebase rules have been deployed or changed. Do not deploy these functions as a production cutover yet.
- Do not enable broad client read/write access to the `secure_*` paths. A matching restrictive Realtime Database rules file and emulator tests are required before deployment.
- The admin check uses the verified Firebase Auth email `grashfxmw@gmail.com`. Confirm the account is protected with a strong password and multi-factor authentication where available before production.
- Scheduled ROI credits and referral bonuses are deliberately not implemented here. Confirm the business rules, funding model, and compliance requirements first; never treat client-side profit calculations as authoritative.

## Staging setup

See [`STAGING_SETUP.md`](../STAGING_SETUP.md) for the isolated Firebase project checklist, safe local preview configuration, and staging-only test plan. The committed preview files intentionally contain placeholders; do not replace them with production config or commit real project configuration.

## Local checks

From this directory:

```sh
npm install
npm run check
```

Then test with the Firebase Emulator Suite and a separate test project. Verify unauthenticated calls fail, ordinary users cannot approve transactions, users cannot read or alter another user's records, repeated approvals cannot credit twice, and simultaneous withdrawals cannot overspend.

## Required before launch

1. Migrate the UI to Firebase Authentication and callable functions.
2. Add restrictive Realtime Database rules for the new schema.
3. Keep expanding automated emulator tests and verify recovery handling for interrupted approvals.
4. Decide how to handle existing user records and pending transactions; do not blindly import untrusted client balances.
5. Run a staging cutover and explicitly approve production deployment.
