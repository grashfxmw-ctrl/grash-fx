# GRASH FX Legacy Account Migration Checklist

## Current implementation boundary

The secure backend branch contains a read-only `inspectLegacyAccount` callable. It requires a Firebase-authenticated user with a verified email and compares that normalized email against `platform_data/users`.

The callable returns only a status (`no_match`, `ambiguous`, `blocked`, or `review_required`) and a match count. It does not return a legacy record and does not copy any profile, balance, profit, referral, role, plan, or password fields.

## Important finding: production database rules are not in this repository

The current repository's `main` branch contains the static website but no checked-in Realtime Database rules file. Therefore, repository review alone cannot prove whether the live `platform_data` tree is protected against client writes.

**Do not deploy replacement database rules yet.** The legacy site currently reads and writes `platform_data`; a rules change could lock out the live application or prevent customer operations. Export/download the current Realtime Database rules from the Firebase console and review them before any rule change. Never place service-account credentials or private keys in this repository.

## Migration gates before transferring financial values

- [ ] Export the current production Realtime Database rules without changing them.
- [ ] Confirm whether unauthenticated or ordinary authenticated clients can write `platform_data`.
- [ ] Create a protected backup/export of `platform_data` before any migration.
- [ ] Reconcile each legacy user's balance against trusted deposit/withdrawal records and administrator records; do not treat a client-writable balance as authoritative.
- [ ] Decide how legacy investment plans, accrued returns, referral bonuses, referrals, and transaction history are represented in the secure schema.
- [ ] Resolve duplicate normalized emails and blocked accounts manually.
- [ ] Verify the account owner through Firebase Auth email verification; never copy or reuse legacy plaintext passwords.
- [ ] Migrate only approved, reconciled values with a server-side, idempotent operation and a durable migration marker.
- [ ] Test with a controlled account and confirm both the original record and secure record before switching the UI.
- [ ] Switch login/signup and account screens only after migration and access-control checks pass.

## Current production protections

- Existing login/signup and `platform_data` UI flows are intentionally unchanged on this branch.
- The secure backend endpoints use verified Firebase Auth identities and server-side admin authorization.
- The read-only legacy inspection callable is not a migration and does not move money.
- No Firebase deployment or production database modification has been performed by this change.

## Next implementation step

After the production rules and data integrity are reviewed, add a server-side migration callable that accepts no client-supplied financial values, matches exactly one verified-email legacy record, rejects blocked/ambiguous records, and writes a one-time migration marker. Until those preconditions are met, keep the financial migration disabled.
