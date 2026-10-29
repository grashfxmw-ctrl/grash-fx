# Step 9 — Secure administrator panel

## Status and boundary

This document defines the first administrator-panel build. It is a security specification, not a deployed panel. The website is not deployed, and the Supabase development migration history must be checked before applying any new SQL. Do not expose administrator pages or accept real funds until authorization policies and staging tests pass.

## Panel sections

1. **Overview** — counts of pending deposits and withdrawals, restricted accounts, investments due for maturity, failed background jobs, and unreconciled treasury differences. Show timestamps and currency; never imply internal ledger balances prove external cash exists.
2. **Investment plans** — list plan versions, status, effective dates, minimum, currency, rate basis and term. New edits create a new version. A plan used by an investment is never rewritten in place.
3. **Money requests** — separate deposit and withdrawal queues; view submitted details and evidence; record review decision, reason and external payment reference. A review decision is not proof a transfer occurred. Only record paid after external payment is verified.
4. **Client accounts** — search by exact account identifiers, view status and account history, restrict/unrestrict with a reason, and record investigation notes. Do not delete an account's financial history.
5. **Investments** — view principal, saved plan/rate/term snapshots, start and maturity times, status and linked ledger entries. No direct edit controls for principal, profit, maturity, or ledger.
6. **Reports and reconciliation** — request volumes, ledger summaries by currency, maturity jobs, treasury reconciliation differences, failed operations, and export history. Export permissions must be restricted and each export audited.
7. **Audit trail** — append-only event history with actor, role, action, target record, reason, server timestamp, request/correlation ID, and safe before/after metadata. Never log passwords, session tokens, recovery codes, private keys or full payment secrets.

## Roles and least privilege

- **Support:** view limited account information, manage assigned support tickets, and add investigation notes. No financial approvals or balance changes.
- **Finance operator:** review payment evidence and enter verified external payment references within assigned workflows. Cannot grant roles or silently post credits.
- **Reviewer:** approve/reject eligible money requests with a mandatory reason. Separate approval from external payment completion where possible.
- **Administrator:** manage plan drafts, account restrictions and staff access. Must use MFA and re-authenticate for sensitive actions. Role grants/revocations require a reason and audit event.
- **System worker:** performs scheduled maturity and other server-only work using a service identity; it is not a human administrator.

Never derive administrator access from a client-editable profile field or a URL parameter. Authorization must be enforced by database/server functions on every request, not merely by hiding buttons in the browser.

## Financial integrity rules

- Ledger rows are append-only. No administrator UI or RPC may update or delete posted ledger entries.
- A correction is a new, linked reversal/adjustment entry with a reason and references to the original entry; the original remains visible.
- Manual credits/adjustments require a dedicated permission, a mandatory reason, idempotency key, and preferably a second approver above a defined threshold. The threshold must be configured and documented before launch.
- Plan changes create a new version and require review/approval. Existing investments retain their saved terms.
- A deposit is credited only after an authorised operator verifies external receipt. A withdrawal is marked paid only after external payment evidence is recorded.
- Internal balance and profit display must remain distinct from reconciled treasury cash available to pay clients. The known treasury/liquidity control is still a launch blocker.
- All sensitive operations execute transactionally, validate the actor server-side, and append an audit event in the same transaction.

## Required server actions before the UI can be connected

Implement narrowly scoped server/database functions for:
- reading an overview with only permitted, aggregate fields;
- listing/searching clients, requests, plans, investments and audit events with pagination;
- changing a client's account status with a reason;
- creating a draft plan version and submitting it for review;
- approving/rejecting a plan version using a distinct reviewer permission;
- reviewing a money request with a reason and idempotency protection;
- recording verified external payment completion;
- granting/revoking staff roles with a reason and separate administrator permission;
- exporting a report and recording who exported it.

Do not expose generic table-write endpoints or accept arbitrary SQL from the browser. Restrict function execution grants and verify row-level security for all underlying tables.

## Audit-event minimum

Every privileged action records:
- authenticated actor ID and effective staff role;
- action name and target entity ID;
- mandatory reason for sensitive changes;
- server-generated timestamp;
- request/correlation ID and hashed client IP only if necessary and disclosed;
- limited metadata sufficient to investigate the event without storing secrets.

Protect audit events against update/delete using database permissions and a trigger. A database owner/service role can bypass ordinary grants, so operational access to those credentials must be tightly restricted and independently logged. Back up audit data and test restoration.

## Staging acceptance checklist

- [ ] Anonymous users and ordinary clients cannot load admin data or call admin functions.
- [ ] Each staff role is denied actions outside its permissions, including direct RPC calls.
- [ ] MFA and recent re-authentication are required for role changes and high-risk actions.
- [ ] Missing reasons and duplicate idempotency keys are rejected.
- [ ] Audit rows are created atomically with sensitive actions and cannot be updated/deleted by normal app roles.
- [ ] Plan changes create a new version; existing investment snapshots remain unchanged.
- [ ] Ledger corrections create linked entries and preserve original entries.
- [ ] Concurrent approvals and retries do not create duplicate ledger entries or payment state changes.
- [ ] Reports are permission-filtered, paginated, and exports are audited.
- [ ] Treasury reconciliation, maturity scheduling, alerting, backup restoration, and security review pass before live-money use.

## Current blockers

The core schema contains staff-role, audit-event, plan-version, request, investment and ledger tables, but this does not mean the complete staff policies or admin RPCs are deployed. The website money-request method migration is also still pending application in the configured Supabase project. Build and test the authorization layer before connecting any administrator UI.
