import type { Doc, DocumentTransaction } from './document-store.js';
import { HttpError } from './types.js';
import { tokenHash } from './accounts.js';
export type ResaleSnapshot = {
  kind: 'plan' | 'product';
  partnerId: string;
  subaccount: string;
  generation: string;
  baseCents: number;
};
export async function resaleRecipient(
  tx: DocumentTransaction,
  partnerId: string,
  kind: ResaleSnapshot['kind'],
  generation: string,
  baseCents: number,
): Promise<ResaleSnapshot> {
  const [account, shop, setup, profile, platform] = await Promise.all([
    tx.get('merchant_accounts/' + partnerId),
    tx.get('bot_shops/' + partnerId),
    tx.get('merchant_bot_setup/' + partnerId),
    tx.get('resale_profiles/' + partnerId),
    tx.get('platform_payments/purincash'),
  ]);
  const claim = shop?.purin_subaccount
    ? await tx.get('purin_subaccount_claims/' + shop.purin_subaccount)
    : null;
  if (
    account?.access_status !== 'approved' ||
    profile?.[kind === 'plan' ? 'plans' : 'products'] !== 'approved' ||
    platform?.generation !== generation ||
    shop?.purin_connection !== generation ||
    !shop?.purin_subaccount ||
    claim?.account_id !== partnerId ||
    !shop.owner_id ||
    shop.owner_id !== setup?.telegram_user_id ||
    shop.owner_bot_id !== setup?.bot_id
  )
    throw new HttpError(
      409,
      'RESELLER_WALLET_REQUIRED',
      'O parceiro precisa de aprovação e carteira Purin vinculada ao responsável confirmado.',
    );
  return { kind, partnerId, subaccount: shop.purin_subaccount, generation, baseCents };
}
// The provider allocates base + margin atomically in the original charge.
// Proof comes from the recipient ledger, never from webhook-supplied financial fields.
export function creditProof(snapshot: ResaleSnapshot, payment: Doc, ledger: Doc) {
  if (ledger.subaccountId !== snapshot.subaccount)
    throw new HttpError(
      409,
      'RESALE_LEDGER_MISMATCH',
      'Extrato de comissão não corresponde ao parceiro.',
    );
  const rows = (ledger.transactions ?? []).filter(
    (r: Doc) => r.type === 'sale' && r.refId === payment.paymentId,
  );
  if (rows.length !== 1) return null;
  const row = rows[0],
    margin = row.amountCents,
    base = row.feeCents;
  if (
    !Number.isSafeInteger(margin) ||
    margin < 0 ||
    !Number.isSafeInteger(base) ||
    base < 0 ||
    margin + base > payment.amountCents ||
    (payment.subaccountId !== undefined && payment.subaccountId !== snapshot.subaccount) ||
    (payment.subaccountFeeCents !== undefined && payment.subaccountFeeCents !== snapshot.baseCents)
  )
    throw new HttpError(
      409,
      'RESALE_LEDGER_MISMATCH',
      'Valores de comissão precisam de conferência.',
    );
  return {
    id: tokenHash(payment.paymentId),
    paymentId: payment.paymentId,
    partnerId: snapshot.partnerId,
    kind: snapshot.kind,
    subaccount: snapshot.subaccount,
    generation: snapshot.generation,
    grossCents: payment.amountCents,
    baseCents: snapshot.baseCents,
    gatewayFeeCents: payment.amountCents - margin - base,
    blackoutFeeCents: 0,
    partnerCents: margin,
    allocatedBaseCents: base,
    status: base === snapshot.baseCents ? 'credited' : 'review_required',
    ledgerId: row.id ?? null,
  };
}
export async function recordCommission(
  tx: DocumentTransaction,
  proof: Doc,
  reference: Doc,
  now: Date,
) {
  const path = 'resale_commissions/' + proof.id,
    current = await tx.get(path);
  if (current && (current.partnerId !== proof.partnerId || current.paymentId !== proof.paymentId))
    throw new HttpError(409, 'COMMISSION_ALREADY_USED', 'Comissão já vinculada a outra venda.');
  tx.set(path, { ...proof, ...reference, created_at: current?.created_at ?? now, checked_at: now });
  tx.set('resale_partners/' + proof.partnerId + '/commissions/' + proof.id, {
    ...proof,
    ...reference,
    created_at: current?.created_at ?? now,
    checked_at: now,
  });
}
