# Access-control requirements

These are implementation requirements, not active security policies. A provider-specific policy migration is required before the database is exposed to a client application.

## Client

A signed-in client may:
- Read their own profile, investment records, ledger history, money requests, referrals and support tickets.
- Update only explicitly permitted profile fields.
- Submit a deposit or withdrawal request through a server-side function.
- Open support tickets and read their own tickets.

A client must never:
- Set or directly update their available balance.
- Write ledger entries.
- Mark a deposit as received or a withdrawal as paid.
- Approve their own requests or change their role.
- Change a plan's rate, minimum, duration or approval status.
- Read another client's private records or administrator records.

## Staff roles

- Support: support tickets and limited account status; no financial approvals.
- Finance operator: review payment evidence and record external payment references within assigned permissions.
- Reviewer: approve/reject eligible requests, with reason and audit record.
- Administrator: manage roles and system configuration; MFA and re-authentication required.

Use least privilege. For large or unusual adjustments, require a second reviewer where practical. Never grant staff permissions through a client-editable profile field.

## Server-only financial actions

Only trusted server code may:
- Create an investment after verifying the account, approved active plan, minimum, currency and available ledger funds.
- Post ledger entries.
- Confirm external payment receipt or completion.
- Calculate and process maturity.
- Grant referral rewards or manual adjustments.

Every financial action must run transactionally, use an idempotency key, and write an audit event. A retry must not create a second credit.

## Identity, devices and privacy

Verify email and apply signup/login rate limits. IP/device signals can help detect abuse but are not reliable proof that two registrations belong to one person. Explain data collection in the privacy notice, retain only what is necessary, restrict access, and set retention/deletion procedures. Do not promise strict one-account-per-phone enforcement unless the chosen provider and a privacy-respecting design can actually support it.

## Required verification tests

1. Anonymous visitors cannot read private tables.
2. Client A cannot read or modify Client B's records.
3. Clients cannot insert, update or delete ledger entries.
4. Clients cannot modify roles, plan approvals or financial request decisions.
5. A support role cannot perform finance approvals.
6. A repeated request with the same idempotency key has one effect only.
7. Every privileged decision includes an actor, timestamp and reason.
8. Access rules are tested in the provider's staging environment before deployment.
