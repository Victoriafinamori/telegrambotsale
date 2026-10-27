import type { Doc } from './document-store.js';
const amount = (value: unknown) =>
  Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
// Purin names the merchant markup `feeCents` in its ledger and payout lookup.
// In a payout lookup `platformFeeCents` is the gateway's fee, not Blackout's.
export function saleBreakdown(row: Doc, gross: unknown) {
  const grossCents = amount(gross),
    netCents = amount(row.amountCents),
    blackoutFeeCents = amount(row.feeCents);
  const gatewayFeeCents =
    grossCents !== null &&
    netCents !== null &&
    blackoutFeeCents !== null &&
    grossCents >= netCents + blackoutFeeCents
      ? grossCents - netCents - blackoutFeeCents
      : null;
  const reconciled = gatewayFeeCents !== null;
  return { grossCents, netCents, blackoutFeeCents, gatewayFeeCents, reconciled };
}
export function payoutBreakdown(row: Doc) {
  const gatewayFeeCents = amount(row.platformFeeCents),
    blackoutFeeCents = amount(row.feeCents),
    netCents = amount(row.netAmountCents);
  const totalFeeCents =
    gatewayFeeCents !== null && blackoutFeeCents !== null
      ? gatewayFeeCents + blackoutFeeCents
      : null;
  return { gatewayFeeCents, blackoutFeeCents, netCents, totalFeeCents };
}
