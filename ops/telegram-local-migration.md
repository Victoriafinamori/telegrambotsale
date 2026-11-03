# Telegram-first pilot migration

Status: encrypted persistence, optional navigation and a draft-based appearance editor
integrated in the worker; disabled by default. No production worker has been enabled yet.

## Pilot navigation gate

- API: `LOCAL_NAVIGATION_PILOT_ACCOUNT_ID` must equal the pilot shop account ID.
- Worker: `BOT_LOCAL_NAVIGATION=pilot`, `BOT_LOCAL_DATA_DIR` on verified persistent
  storage, and a new private per-shop `BOT_LOCAL_DATA_KEY` (32 random bytes, base64url).
- Snapshot refresh follows the existing 45-second maintenance loop and expires after
  at most 60 seconds (or subscription expiry, whichever comes first). No stale disk
  snapshot is trusted after restart. Only public catalog/support fields and scoped
  owner/session/version metadata are included, never inventory units,
  payment keys, order/customer histories or the central encryption key.
- Plain `/start` and home/catalog/category/product/support render locally. Owner
  buttons require a verified owner in the fresh snapshot. Identity confirmation
  deep links, carts, orders, purchases,
  restock subscriptions and all finance continue through the existing central handler.
- Local display does not reserve or deliver anything. A product may change stock or
  price during the snapshot window; the central purchase validates current values.
- Telegram definitive 400/403 navigation failures do not block the incoming queue;
  transient failures retain the existing update-loop retry. These are disposable
  screens only, never deliveries or financial effects.
- The worker saves its update cursor locally, scoped to the bot and runtime generation,
  to avoid replaying already handled local navigation after a restart. Expired cursors
  are ignored; central operations keep their existing deduplication.

## Optional local configuration draft editor

- Additionally set `BOT_LOCAL_CONFIGURATION=pilot` on the same allowlisted worker.
  It requires local navigation and does not enable itself in existing applications.
- The verified owner can use `/configurar` or `Personalizar loja` from the local home
  screen. Menus, incoming content and previews use SQLite only. Callback screens
  replace the current message rather than accumulating a new message per button.
- Supports welcome, store banner, support fields and existing enabled products'
  description, banner and price. It does not yet create products or manage local stock.
- Explicit Save calls `/internal/bot/configuration`. Central validation checks runtime,
  owner, subscription, configuration revision, an existing central wizard and (for a
  global item) the current supplier cost and resale permission. It cannot change stock,
  payment settings, source bindings or fee rules. The central configuration remains
  authoritative at this intermediate stage; this is not a full local data migration.
- Persisted mutation IDs make lost-response retries idempotent. Local drafts are not
  reported as saved before acknowledgement. Central workflows invalidate the editor
  until a fresh session snapshot is obtained, avoiding interception of stock input.
- A save still accesses the central database. Periodic authorization/outbox work also
  remains central. Do not describe the API as payment-only or promise a measured
  performance gain until the full data split is deployed and measured.
- Keep web editing available until the equivalent Telegram workflows and ownership
  transfer are implemented and verified.

## Authority boundaries

- Worker: shop appearance, category/product overrides, own stock, local conversation state and outgoing message queue.
- Central: runtime authorization/revocation, subscription validity, payments, payout credentials, wallet, global supplier inventory, reservations, fulfillment evidence and commission settlement.
- A local catalog may display a cached global quantity; purchase must obtain an atomic central reservation before accepting payment. Cached quantities cannot authorize a sale.
- Central payment confirmation remains the only automatic-payment fulfillment trigger. Deduplicate by the central order/payment identifiers across restarts.
- Owner dashboard receives bounded summaries; it must not overwrite worker-owned fields after migration.

## Implemented foundation

`LocalShopStore` uses Node 24 SQLite, durable transactions, serialized operations,
authenticated encryption, per-shop identity checks, and consistent encrypted backups.
The encryption key must be unique per shop and private to that worker; never install
the central Firebase identity or platform encryption keys inside client workers.
It rejects central paths and paths belonging to other shops. It is intentionally
not a drop-in replacement for BotStore: that service also accesses central lifecycle,
financial and supplier documents. Those accesses must first be split behind explicit
interfaces. Do not route them through a local fallback.

## Required before enabling the pilot

1. Verify Hyze durable storage survives restart, redeploy and host recovery. Set up
   automatic encrypted backups outside that application's disk, with a restore drill.
2. Separate bot command handling into local shop operations and central operations;
   keep mixed carts, supplier reservations and finance in the central flow initially.
3. Add a versioned pilot-only capability, expiring authorization and bounded summary
   sync. Refuse privileged actions after authorization expiry; never serve stale
   permission data indefinitely during an outage.
4. Freeze web writes for the migrated shop, drain outstanding updates/orders, export
   its own data and verify counts. Do not duplicate global supplier units into local stock.
5. Start exactly one worker on the preserved Telegram offset. Verify catalog, owner
   configuration, own/global/mixed purchases, cancellations, payment callback retry,
   revocation, and restart without duplicate delivery or settlement.
6. Compare measured navigation latency and Firestore reads/writes against the same
   test sequence on the previous worker. Do not claim a speedup from unit tests.
7. Roll back only after draining local updates and syncing authoritative local changes;
   starting the old snapshot directly can lose stock changes or redeliver orders.

Customers remain on the current architecture until this pilot is verified. Firebase
stays on Spark: this migration does not authorize paid services or a billing upgrade.
