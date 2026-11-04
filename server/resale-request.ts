import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { DocumentTransaction } from './document-store.js';
import { HttpError } from './types.js';

export async function requestResale(
  tx: DocumentTransaction,
  accountId: string,
  uid: string,
  raw: unknown,
  now: Date,
) {
  const input = z
    .object({
      capability: z.enum(['products', 'plans']),
      enabled: z.boolean(),
      revision: z.number().int().nonnegative(),
    })
    .strict()
    .parse(raw);
  const account = await tx.get('merchant_accounts/' + accountId);
  if (!account || account.firebase_uid !== uid || account.access_status !== 'approved')
    throw new HttpError(403, 'RESELLER_OWNER_REQUIRED', 'Acesso exclusivo ao responsável da loja.');
  const target = 'resale_profiles/' + accountId,
    profile = await tx.get(target);
  if ((profile?.revision ?? 0) !== input.revision)
    throw new HttpError(409, 'RESALE_CHANGED', 'Atualize as opções de revenda.');
  const next = input.enabled
    ? profile?.[input.capability] === 'approved'
      ? 'approved'
      : 'requested'
    : 'none';
  tx.set(target, {
    id: accountId,
    products: profile?.products ?? 'none',
    plans: profile?.plans ?? 'none',
    [input.capability]: next,
    store_name: account.store_name,
    revision: input.revision + 1,
    updated_at: now,
  });
  tx.set('resale_audit/' + randomUUID(), {
    actor: uid,
    account_id: accountId,
    action: 'resale.' + input.capability + '.' + next,
    created_at: now,
  });
  return { ok: true };
}
