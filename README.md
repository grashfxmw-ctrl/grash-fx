# GRASH FX

Official GRASH FX Trading & Investment Telegram Mini App.

## Secure backend integration

Secure frontend/backend work is currently isolated on the `production-backend-integration` branch. It has not been deployed to production by this work.

- [Secure authentication page](secure-auth.html)
- [Secure customer account page](secure-account.html)
- [Admin transaction review](admin-review.html)
- [Admin audit log](admin-audit.html)
- [Admin customer directory](admin-users.html)
- [Admin legacy account review](admin-legacy-review.html)
- [Secure cutover and release checklist](SECURE_CUTOVER_CHECKLIST.md)

## Important implementation boundaries

- Secure account data and transaction requests are served through Firebase callable Functions.
- Deposit and withdrawal requests are pending until an authorized administrator reviews them. These pages do not process payments.
- Legacy account values are review snapshots, not verified opening balances. No automatic legacy balance/profit/referral migration is implemented.
- Investment-plan returns, scheduled profit credits, and referral reward rules must be approved and implemented separately before they are relied on.
- Automated tests do not replace staging tests, Firebase configuration review, payment reconciliation, or an explicit production release decision.

Do not deploy or merge this branch until the release checklist is complete and the production owner has approved the cutover.
