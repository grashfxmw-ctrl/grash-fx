# GRASH FX

GRASH FX client website and Supabase-backed account platform.

## Current implementation

- Client authentication: `public/supabase-auth.html`
- Administrator dashboard: `public/admin-dashboard.html`
- Server-side account and financial-request API: `supabase/functions/account-api/index.ts`
- Database changes and controls: `supabase/migrations/`

Firebase has been removed from this development branch. The site is not confirmed live or production-deployed; do not treat this repository state as an end-to-end tested investment service.

## Financial operations

Deposit and withdrawal requests require administrator review. Deposit approval requires an external payment reference. The website does not itself prove that external funds were received or sent. Maturity processing and administrator authentication still require complete staging and security verification before real-money use.

Do not merge, deploy, or accept client funds until the production owner approves the release and all security, legal, operational, and reconciliation checks are complete.
