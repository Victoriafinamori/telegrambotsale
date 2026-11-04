# Production data authority

Production switched to encrypted central SQLite on Hyze on 2026-11-04. Firebase
Authentication and Hosting remain in use. The original Firestore database is an
archived migration source and no longer represents current orders, stock or offsets.

- Use the authenticated live API/admin portal for operational changes. Do not run
  old `.local/` administrative scripts that write directly to Firestore.
- Never redeploy a private import ZIP or overwrite the operating SQLite file with
  the original Firestore export. After new writes, rollback requires reconciliation.
- Ordinary code packages must exclude databases, WALs, backups and credentials.
  The one-time private import was explicitly authorized and is not a reusable release.
- Preserve all production environment variables and the three distinct storage,
  token and MFA keys. Keep secrets and data in private storage, outside Git/frontend.
- Current database path is `.blackout-data/central.sqlite` relative to the Hyze app
  directory; the bootstrap resolves it and checks it remains inside that directory.
- The central database has one API writer process. Verify storage and consistent
  backups before changing the deployment topology. A live file copy without its WAL
  is not a current database backup.
- Do not reconcile the two legacy initial subscription charges excluded by the owner.

See `ops/sqlite-cutover-2026-11-04.md` for evidence and current migration limits.
