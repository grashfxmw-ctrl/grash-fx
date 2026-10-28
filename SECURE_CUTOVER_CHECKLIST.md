# GRASH FX Secure Cutover and Release Checklist

**Status:** preparation checklist — not a deployment authorization  
**Development branch:** `production-backend-integration`

This document defines the gates that must be completed before the secure frontend replaces any live GRASH FX workflow. Passing automated source tests alone is not proof that Firebase is configured safely or that financial records are correct.

## 1. Legacy account reconciliation

- [ ] Confirm who is authorized to reconcile customer records.
- [ ] Match each legacy record to a verified identity; resolve duplicate emails and ambiguous records manually.
- [ ] Preserve the original legacy record as read-only evidence before any change.
- [ ] Verify deposits against payment-provider records or independently retained receipts.
- [ ] Verify withdrawals and refunds against payment records.
- [ ] Reconcile profit separately from deposits and withdrawals; do not treat a displayed profit figure as proof of funds.
- [ ] Verify plan name, principal, start/end dates, and any plan terms against an approved source.
- [ ] Verify referral relationships and each referral reward independently.
- [ ] Record evidence references, reviewer, review time, discrepancies, and final disposition.
- [ ] Require a second-person review for any proposed financial opening balance.
- [ ] Do not copy passwords, authentication secrets, or old session tokens.
- [ ] Do not credit a secure account from an unverified legacy snapshot.

## 2. Admin controls and financial audit

- [ ] Confirm server-side authorization on every administrative callable.
- [ ] Confirm admin access is restricted to the intended verified account(s), with a documented recovery process.
- [ ] Confirm transaction approvals are idempotent under concurrent calls and retries.
- [ ] Confirm withdrawals cannot make the balance negative, including concurrent withdrawal approvals.
- [ ] Record actor, action, transaction/account reference, timestamp, decision, and review note in an append-only audit trail.
- [ ] Define how failed/interrupted transactions are recovered without duplicate balance mutations.
- [ ] Reconcile the secure ledger against transaction records before enabling customer-facing balances.
- [ ] Test unauthorized access, duplicate review, malformed amounts, blocked users, and insufficient funds.
- [ ] Never treat a browser-only admin PIN or localStorage value as authorization.

## 3. Investment and referral rules (implemented on development branch)

- [ ] Confirm the existing Starter (10%), Basic (20%), Premium (30%), and VIP (40%) percentages are intentionally daily returns per 24-hour cycle.
- [ ] Confirm the existing plan investment ranges remain Starter $50–$500, Basic $501–$2,000, Premium $2,001–$5,000, and VIP $5,001–$100,000.
- [ ] Confirm the $5 referral reward is credited to the inviter after the new account verifies its email and creates its secure profile.
- [ ] Confirm that seven daily credits accumulate in the profit balance and transfer to the main balance at maturity.
- [x] At maturity, transfer accumulated profit plus the original investment principal to the main balance in the same profile transaction; mark the plan Completed to prevent a second return.
- [ ] Confirm the $20 minimum deposit, $50 minimum withdrawal, $50 minimum investment, and zero-fee policy are reflected in all customer-facing terms before release.
- [ ] Confirm that the scheduled processor, duplicate prevention, account isolation, and referral-link flow work in Firebase staging.
- [ ] Confirm admin balance edits are restricted server-side and every edit requires a reason and creates an audit record.
- [ ] Confirm Firebase Phone Authentication and the required authorized domains are enabled before release.
- [ ] Confirm every secure customer account must link a verified phone number and the backend reserves each normalized number for one UID only.
- [ ] Verify account deletion is blocked while balances/profits, active investments, or pending/processing transactions remain; confirm successful deletion removes the Auth account and releases only that account’s phone reservation while retaining historical transactions/audit records.
- [ ] Verify hashed IP reuse is recorded as a review signal; do not auto-block solely on IP because shared Wi-Fi, carrier NAT, and VPNs can create false positives.
- [ ] Reconcile existing customer accounts before cutover; legacy records do not automatically populate the new verified-phone registry.
- [ ] Define and publish any plan cancellation, pause, refund, and missed-scheduler policies before enabling plans for customers.
- [ ] Have legal/compliance review public claims about returns, risks, and the nature of the investment service.
- [ ] Confirm the system's financial ledger and customer transaction history are sufficient for reconciliation; the scheduled profit processor currently writes audit entries but does not create a separate customer transaction row for each daily credit.

## 4. Firebase configuration and security

- [ ] Verify the Firebase project ID and environments (development/staging/production).
- [ ] Enable Email/Password Authentication and configure verification/reset email templates.
- [ ] Verify authorized domains and the production hosting origin.
- [ ] Deploy Functions to a staging environment first and verify Node.js/runtime compatibility.
- [ ] Review Realtime Database rules: deny client access to secure records and restrict legacy reads/writes according to a migration plan.
- [ ] Add required database indexes for queries used by secure callables.
- [ ] Confirm callable Functions enforce verified identity and server-side admin authorization.
- [ ] Confirm no secrets, service-account keys, private credentials, or payment credentials are committed.
- [ ] Configure budget alerts, logging/monitoring, backups, and a documented rollback procedure.
- [ ] Test restore/recovery using a non-production backup.
- [ ] Do not change live rules until all dependent legacy screens and integrations have been inventoried.

## 5. Frontend integration and end-to-end testing

- [ ] Inventory every page and navigation entry that reads or writes legacy `platform_data`.
- [ ] Wire secure pages into a staging navigation without removing the current production path.
- [ ] Verify signup, verification, sign-in, sign-out, password reset, blocked users, and legacy-account review.
- [ ] Verify customer isolation: one customer cannot read another customer's profile or transactions.
- [ ] Verify admin pages deny non-admin users even if a user manually opens the URL.
- [ ] Verify deposit/withdrawal requests remain pending until reviewed.
- [ ] Verify UI loading, empty, failure, retry, and expired-session states.
- [ ] Test on mobile and desktop, including slow/offline network behavior.
- [ ] Run all automated tests and inspect the actual CI result for the final commit.
- [ ] Complete staging smoke tests with test accounts and non-real financial values.

## 6. Controlled release and rollback

- [ ] Confirm the final change list and obtain owner approval for the production cutover.
- [ ] Back up the relevant production data and record the backup/restore procedure.
- [ ] Complete the migration ledger and independent review of all opening balances.
- [ ] Deploy backend changes before directing users to secure pages, where dependencies require that order.
- [ ] Validate the deployment with admin and customer test accounts before announcing it.
- [ ] Roll out to a small controlled group first if practical.
- [ ] Monitor errors, transaction states, audit events, and balance reconciliation after release.
- [ ] Keep a documented rollback route that does not re-enable insecure balance writes.
- [ ] Do not delete legacy records until retention, reconciliation, and rollback obligations are resolved.

## Current implementation boundaries

The secure branch currently includes Firebase Auth client integration, callable Functions for profiles and transaction requests/reviews, secure customer/admin screens, and a read-only legacy review/staging flow. It does **not** by itself establish that Firebase production configuration is correct, that real payment processing exists, that plan returns/referrals are implemented, or that legacy balances have been reconciled.

A staged legacy snapshot is evidence to investigate, not an approved opening balance. Do not add funds or mark a migration complete until a separately reviewed, auditable reconciliation process exists.
