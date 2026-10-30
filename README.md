# GRASH FX

GRASH FX public website and Supabase-backed account platform.

## Current structure

- Public website: `public/index.html` (browsing and plan information do not require sign-in)
- Client registration/login: `public/account.html` (email/password authentication)
- Separate administrator entry: `public/admin.html` → `public/admin-dashboard.html`
- Supabase Edge Function: `supabase/functions/account-api/index.ts`
- Database migrations: `supabase/migrations/`
- Regression tests: `tests/`

The legacy Firebase implementation has been replaced in the default-branch website entry point. Supabase is the intended backend. The public site and backend are not yet certified as a fully tested production investment service.

## Safety and release status

- Keep investment plans inactive until end-to-end staging tests pass.
- A submitted deposit request is not proof of receipt; verify external payments independently.
- Verify withdrawals against actual external payments and reconciliation records.
- Test email confirmation, cross-device login, profile review, balance calculations, referrals, withdrawal reservation/release, and seven-day maturity before accepting real funds.
- Review business registration, investment regulations, disclosures, and operating requirements for every country served.

Never commit Supabase secret/service-role keys. Only the publishable client key may appear in browser code.
