# Step 11 — Deployment and maintenance runbook

## Current deployment status

This repository is a development foundation, not a production investment service. Do not connect a public domain to a money-taking flow or accept real client funds until the release gates below are signed off.

- Backend branch: `feature/backend-foundation-v1`
- Website branch: `grash-fx-clean-website`
- Supabase project currently inspected: `grash-fx-foundation` (`vwghcjkgzeausfxqphmf`), region `eu-west-1`
- The existence of this project does not prove that it is isolated staging or production; verify its purpose and access before putting real data in it.
- The website preview is not proof of a deployed website or a backend connection.
- Never use the old Supabase project `vsearqlfvrhkckyndwtv` for this foundation without an explicit, reviewed decision.

## 1. Confirm hosting and domain ownership

Before changing DNS, record:
- Domain name and registrar account owner.
- Hosting provider and the exact production project/site ID.
- Which branch and commit are deployed.
- DNS records currently in place and a rollback copy.
- TLS/HTTPS status and renewal responsibility.

Connect the domain only after a staging deployment has passed smoke tests. Use the hosting provider's documented DNS instructions; do not guess A, AAAA, CNAME, or TXT values. Verify the domain's ownership and HTTPS certificate after DNS propagation. Keep preview/staging and production on separate hostnames where possible.

## 2. Separate environments

Create or confirm distinct development, staging, and production environments. Staging must use a separate database/project, test email settings, and fake payment records. Never copy real customer secrets or financial records into staging. Use test accounts and test funds only.

Before release, record the backend project ref and API URL used by each website build. Check that staging uses the staging backend and production uses only the approved production backend. Do not rely on a project display name alone.

## 3. Secrets and access

- Store server-only secrets in the hosting provider's encrypted environment/secrets settings.
- Use only the Supabase publishable/legacy anon key in browser code, with correct RLS policies.
- Never place Supabase service-role/secret keys, database passwords, private payment keys, email-provider secrets, or signing secrets in HTML, JavaScript shipped to browsers, Git commits, screenshots, or public logs.
- Rotate any secret that was committed, pasted into public content, or otherwise exposed; deleting the visible copy is not enough.
- Restrict production access to named maintainers and require MFA where supported.
- Keep a dated inventory of secret names, owners, purpose, rotation date, and emergency rotation procedure. Do not record secret values in this inventory.

## 4. Database security and migrations

- Apply reviewed migrations to staging first and capture the migration IDs and result.
- Review Supabase Security Advisors after schema or policy changes and resolve or formally accept each finding.
- Confirm every exposed table has appropriate RLS and that clients cannot access other clients' data, staff roles, audit data, or job-processing records.
- Verify all privileged functions have explicit execute grants, authorization checks, safe search paths, and appropriate security mode.
- Back up production before any migration that could change or remove data.
- Apply migrations to production only after staging tests pass and a rollback/recovery plan is recorded. Do not assume every database migration is safely reversible.

## 5. Backups and recovery drills

Before production approval:
- Confirm the Supabase plan's backup and point-in-time recovery capabilities and retention limits.
- Record the backup schedule, retention, encryption/access controls, and who can restore.
- Export or otherwise protect essential configuration and migration history separately from database backups.
- Run a restore drill into an isolated temporary project. Verify restored schema, policies, critical records, ledger consistency, and application connectivity.
- Record the restore date, duration, data-loss window, checks performed, issues, and reviewer.
- Repeat recovery drills periodically and after material changes.

A backup is not considered verified until a restore has been successfully tested.

## 6. Monitoring and incident response

Configure alerts for:
- Website errors and failed releases.
- Authentication failures or unusual login patterns.
- Database/API errors and elevated latency.
- Failed or overdue maturity jobs and retry exhaustion.
- Repeated payment notifications and idempotency conflicts.
- Deposit/withdrawal queue age and reconciliation differences.
- Backup failures and unexpected privilege/configuration changes.

Keep logs free of passwords, access tokens, private keys, full payment credentials, and unnecessary personal data. Document who receives alerts, how to escalate, and how to pause new deposits/withdrawal processing safely during an incident. Preserve financial history; do not delete ledger records to conceal or repair an incident.

## 7. Release and rollback checklist

- [ ] Reviewed code and migration changes on the intended branch.
- [ ] Automated tests pass in CI.
- [ ] Staging registration, login, password recovery, authorization, financial calculations, duplicate notifications, and admin permissions pass with fake accounts/funds.
- [ ] RLS and Supabase Security Advisor findings reviewed.
- [ ] Correct staging/production API URL and publishable key verified.
- [ ] No server-only secret appears in client bundles or repository history.
- [ ] Domain DNS and HTTPS verified after staging smoke tests.
- [ ] Backup created and recovery procedure confirmed before production migration.
- [ ] Monitoring and alert recipients tested.
- [ ] Rollback owner, steps, and decision threshold documented.
- [ ] Legal, licensing, financial, tax, privacy, payment, and operational approvals recorded.

## 8. Financial-service launch gate

Keep investment plans inactive and do not accept real-money deposits or promise returns until qualified professionals confirm the operating model and applicable requirements in every country served. The currently drafted 10%, 20%, 30%, and 40% daily rates are extraordinary and must not be presented as guaranteed or risk-free.

Technical gates also remain: end-to-end staging tests, complete admin authorization, maturity-worker scheduling and alerting, external cash/liquidity reconciliation, safe withdrawal controls, duplicate-processing tests, and a successful restore drill.

## 9. Maintenance cadence

- Every release: tests, migration review, secret scan, staging smoke test, backup/rollback check.
- Weekly: review error/security alerts, failed jobs, pending money requests, and reconciliation differences.
- Monthly: review staff access, dependency updates, secret rotation needs, backup status, and unresolved advisor findings.
- Quarterly and after major changes: restore drill, incident-response review, and access/permission audit.

## Current blockers to resolve before deployment

1. Confirm the hosting provider and whether a domain has already been purchased.
2. Confirm staging is isolated from production and no real-money functions are enabled.
3. Finish security policies for staff/audit/job tables and test all role boundaries.
4. Build and run automated staging tests.
5. Configure the maturity worker, monitoring, external-liquidity guard, and reconciliation.
6. Verify backup settings and complete a restore drill.
7. Complete independent legal, financial, compliance, and operational review.

Do not paste secrets into chat or commit them to this repository.