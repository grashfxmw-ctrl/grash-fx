# GRASH FX backend foundation

This folder contains the first source-code foundation for GRASH FX. It is not deployed and must not be used to accept or promise real-money returns.

## Current status

- [x] PostgreSQL core schema for profiles, roles, plan versions, investments, money requests, ledger entries, referrals, support tickets, audit events and retry-safe jobs.
- [x] User-provided plan values seeded as **inactive drafts**.
- [x] Ledger entries are append-only; corrections must be separate linked entries.
- [ ] Select and configure the authentication/database provider.
- [x] Supabase selected; initial client-read access policies and server-side financial functions are present. Full policy/function security testing is still outstanding.
- [x] Server-side investment creation, manual deposit/withdrawal review and maturity calculation functions are defined in migrations.
- [ ] Configure a scheduled maturity worker and alerts; add a reconciled external-liquidity control before enabling real-money withdrawals.
- [ ] Add automated tests and a staging environment.
- [ ] Complete legal, compliance, operational and security reviews before any live-money activity.

## Files

- `schema/001_core_tables.sql` — initial PostgreSQL tables, constraints, indexes and ledger mutation protection.
- `schema/002_seed_plan_versions.sql` — proposed plan data; all four plans remain inactive and unapproved.
- `docs/access-control.md` — permissions and security requirements.
- `docs/financial-rules.md` — investment lifecycle, ledger and maturity rules.

## Before applying the schema

1. Choose the backend provider and create a separate development project.
2. Back up any existing project before changing it. These files do not modify Firebase or any current live database.
3. Review the migration against the provider's PostgreSQL version and identity model.
4. Apply it only to an empty development database first.
5. Add provider-specific row-level security policies before exposing any table through an API.
6. Run tests with fake accounts and fake funds.

## Important financial rule

The proposed rates are 10%, 20%, 30% and 40% **per day** for seven days. These are extraordinary rates and must not be described as guaranteed or risk-free. Plan data is stored as a draft only. Do not activate the plans or accept client funds until the model has been independently assessed and all applicable legal, licensing, consumer-protection, tax, privacy and payment requirements have been confirmed.

The website's internal ledger is an accounting record, not a bank account and not proof that external funds have been received or paid. External payment evidence and daily reconciliation are required.

## Step 8 — Investment and maturity calculations

The SQL foundation records principal, plan/rate/term snapshots, server-generated start and maturity timestamps, and investment status. The maturity function calculates simple daily profit from the saved plan terms and uses unique ledger keys to avoid duplicate credits on retries. See [`docs/financial-rules.md`](docs/financial-rules.md) for the rules and outstanding controls.

**Not launch-ready:** the current maturity function credits principal and profit to the internal ledger without checking that external treasury cash is sufficient. An internal ledger balance is not proof of cash available to pay a withdrawal. A separate reconciled treasury/liquidity control, scheduled worker, failure alerts, and staging tests are required before real-money use.
