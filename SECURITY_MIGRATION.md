# GRASH FX Security Migration — Initial Audit

## Scope and safety

This audit was performed against `index.html` on the `secure-backend-migration` branch. It does not change the published website or Firebase project. Do not deploy new Firebase rules or functions until the frontend migration is complete and tested.

## Confirmed issues in the current frontend

1. **Shared writable database root.** The browser listens to `platform_data` and writes the entire `users`, `transactions`, `messages`, and `activityLogs` collections with one `set()`. If client rules permit this, a browser can overwrite other users' records and balances.
2. **Client-side admin PIN.** The PIN `5978` and admin UI checks are in public JavaScript. A PIN embedded in a webpage cannot authenticate an administrator securely.
3. **Local storage is treated as login state.** `grash_current_user` is loaded from localStorage. This is editable by the visitor and is not proof of identity.
4. **Demo credentials are embedded in source.** A fallback investor account includes a password in client-side code.
5. **Profit calculation runs in visitors' browsers.** `checkAutomatedProfits()` updates balances and ROI transactions in frontend JavaScript, including a timer that runs every minute. Browser-side calculations must never be authoritative for money or account state.
6. **Deposit/withdrawal approvals run in the browser.** `approveDeposit()`, `approveWithdrawal()`, and `rejectTx()` directly mutate arrays and then save the entire shared database object.
7. **Referral bonus is not idempotent.** Deposit approval adds a $5 referral bonus without checking whether that deposit was already processed, so repeated approval can award multiple bonuses.

## Existing product details to preserve during migration

- Starter: 10%, $50–$500
- Basic: 20%, $501–$2,000
- Premium: 30%, $2,001–$5,000
- VIP: 40%, $5,001–$100,000
- The current UI advertises daily returns for 7 days. These rates are product claims, not verified or guaranteed returns. Do not silently change the percentages or imply guaranteed profit.

## Safe migration order

1. Enable and verify Firebase Authentication (email/password) and create a trusted admin identity. Remove the client-side PIN as an authority.
2. Design per-user data paths and server-owned financial records. Authenticate every client request; authorize admin actions using server-verified custom claims or an equivalent server-controlled role.
3. Add Cloud Functions for transaction requests and admin approvals. Validate amounts, statuses, ownership, plan limits, and allowed state transitions on the server. Make approvals and referral awards idempotent and use database transactions.
4. Move scheduled ROI processing to a server scheduler only after the business rules and funding/solvency model are explicitly confirmed. Prevent duplicate credits with stable period/transaction IDs.
5. Migrate the frontend to Firebase Auth and callable/server endpoints. Never trust balances, roles, transaction status, or profit calculations supplied by the browser.
6. Test with a separate Firebase test project or emulator. Then deploy restrictive database rules and functions in a planned cutover. Do not lock down the existing production database before the migrated frontend is ready.
7. Review privacy, payment handling, and the legal/regulatory requirements for offering investment products before accepting real deposits.

## Target rules warning

`database.rules.json` is a staged target policy that denies client access to the legacy `platform_data` tree. Deploying it before the frontend cutover would break the current website. It is committed for review only and has not been deployed.

## Staged frontend adapter

- `frontend/secure-client.js` now provides a small Firebase Auth/Callable Functions adapter for email verification, sign-in, profile creation, account loading, deposit/withdrawal requests, and admin transaction review.
- The adapter is deliberately **not loaded by `index.html` yet**. The existing page still has tightly coupled legacy state and must be migrated as one coordinated cutover; wiring in authentication alone would leave balances and history inconsistent.
- CI syntax-checks the adapter. Before cutover, add automated client tests and migrate dashboard/profile/transaction/admin flows to the secure data model; remove the old shared writes, localStorage identity, client PIN, demo credentials, and browser profit engine.

## Current status

- Working branch: `secure-backend-migration`
- No Firebase configuration, rules, functions, production data, or live website has been changed by this audit.
- Next implementation step: build and test the server-side authentication/authorization and transaction layer before switching the existing frontend.
