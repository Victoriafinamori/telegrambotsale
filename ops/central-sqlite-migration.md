# Central SQLite migration (not deployed)

The API now accepts an encrypted SQLite DocumentStore in addition to Firestore.
It runs the existing account/permission, Purin wallet, payment, shared-stock,
reservation and commission domain services. Firebase Authentication and Hosting
stay in place. No production setting has been changed by this implementation.

## Deployment gates

During quota recovery the API can be quiesced with private
`BLACKOUT_MAINTENANCE=true` (Hyze-compatible alias). This blocks operational and
payment requests before database access and disables activation/reconciliation
timers. Health and public config do not read or write the database in either mode.
Payment webhooks get 503, never a false successful acknowledgment. Provider retry
limits still apply: review unresolved payments after reopening. Do not reconcile
the two legacy subscription charges the owner explicitly excluded.
Unset this flag or set it to false and restart only after the import and validation.

1. Confirm durable storage on the API application survives restart AND redeploy.
   Hyze's app backup endpoints exist, but that alone does not prove persistence or
   a consistent SQLite restore. Verify these using a disposable staging app.
2. One central API process/writer, one disk. Do not point multiple replicas at
   separate SQLite copies or a network filesystem. Moving beyond a single writer
   requires a server database and another adapter.
3. Generate a dedicated 32-byte base64url `PLATFORM_SQLITE_ENCRYPTION_KEY` in private
   storage, different from BOT_TOKEN_ENCRYPTION_KEY and ADMIN_MFA_ENCRYPTION_KEY.
   Preserve the original token/MFA keys: source ciphertext must remain readable.
4. Rehearse the export with `scripts/migrate-central-sqlite.ts <NEW-STAGING-PATH>`
   using the dedicated admin identity and FIREBASE_PROJECT_ID. This reads source
   documents and writes only the new encrypted destination/backup. Never commit or
   upload that file to a public location. It contains all platform data.
5. The source Firestore must permit reads. The quota blockage cannot be bypassed
   by creating an empty SQL database; that would abandon existing orders and stock.
6. For the FINAL export, quiesce all source writers (old API, background jobs, bots,
   administrative scripts). While offline, invoke the same script with
   `--source-quiesced`. This flag is an operator declaration, not a remote stop
   command. Failed, duplicate or empty imports are never marked production-ready.
   Nested documents with absent parents, including explicit reseller grants, are
   traversed. Dates and existing encrypted payloads are preserved and read back.
7. Check manifest counts, account roles, wallet bindings, pending orders, runtime
   generations and Telegram offsets; archive the encrypted consistent backup and
   its key in separate private storage. Perform a restore rehearsal.
8. Only then set private API variables:
   - BLACKOUT_DATABASE_BACKEND=sqlite (Hyze bootstrap selection)
   - PLATFORM_SQLITE_PATH=<absolute durable-volume path>
   - PLATFORM_SQLITE_ENCRYPTION_KEY=<private dedicated key>
   - SQLITE_DURABLE_STORAGE_CONFIRMED=true
   For direct Node startup use PLATFORM_DATABASE=sqlite. The old Firestore startup
   remains the default. An incomplete or empty imported database is refused.
9. Start the SINGLE new API, validate login/MFA, wallet reads and a controlled
   global-stock purchase/cancellation. Never regenerate an ambiguous charge or
   re-submit an uncertain payout during cutover. Keep provider webhook origins
   unchanged, or explicitly migrate them before taking payments.
10. Enable pilot local navigation separately, according to
    telegram-local-migration.md. Own inventory/configuration still use the central
    handler until their ownership-transfer protocol is implemented.

## Recovery and performance limits

Do not simply restart the old Firestore API after SQLite has accepted new writes.
Freeze the new API and reconcile new orders, payments, stock movements and runtime
offsets before rollback. Otherwise two diverging authorities can double sell/deliver.

SQLite stores payloads encrypted and serializes transactions. List predicates still
decrypt collection documents to filter; bounded result sizes are not indexes. This
adapter removes Firestore quotas, but it is not a claim of unlimited scale. Add
purpose-built indexes/projections after measuring production query sizes, without
putting credentials or stock contents into plaintext indexes.

The .verified-backup emitted by the export is a consistent encrypted file. It is
not an offsite or recurring backup service. Those remain required deployment work.
