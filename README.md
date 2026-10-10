# Accounting / General Ledger (K-ERP module)

Double-entry general ledger that plugs into **K-ERPHub**. It has no login of its own: it verifies the
JWT that ERPHUB signs (same `JWT_SECRET`) and requires `"accounting"` in `allowedModules`.
Design and rules: `../../plan/ACCOUNTING_PLAN.md`.

## Run

```bash
docker start k-erp-stock-pg            # Postgres on :5433 (shared container, own database)
cp .env.example .env                   # JWT_SECRET must equal K-ERPHub's; set ACCOUNTING_SERVICE_KEY
npm install
npx prisma migrate dev                 # creates tables + CHECK constraint + immutability triggers
npm run prisma:seed                    # chart of accounts + 2 sample entries
npm run dev                            # :4002

# frontend (sibling folder): npm run build  -> served by this backend under /erp/accounting/
```

Register in ERPHUB (`K-ERPHub/src/config/modules.json`, key `accounting`) and give users
`"accounting"` in `allowedModules` plus the `Accountant` / `Admin` role to post.

## Tests

`npm test` runs unit tests and integration tests against a **real Postgres** in a separate
`<database>_test` database (created and migrated automatically; never touches dev data).

## Notes

- Money is `BigInt` satang, sent to clients as strings.
- Posted entries are immutable (service rules + DB triggers). Fix mistakes with a reversal.
- `POST /api/postings` is service-to-service (`X-Service-Key`), used by the Stock outbox worker (M2).
