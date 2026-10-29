import { createHash, randomInt } from 'node:crypto';
import type { Doc } from './document-store.js';
import { SecretVault } from './secret-vault.js';
import { HttpError } from './types.js';
export const stockVersion = (stock: Doc) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        stock.units.map((u: Doc) => u.id),
        stock.mode ?? 'individual',
        stock.remaining ?? 0,
        stock.template?.id ?? '',
      ]),
    )
    .digest('hex')
    .slice(0, 12);
export function stockItems(stock: Doc, vault: SecretVault, account: string, product: string) {
  return stock.units.map((u: Doc) => {
    const content = JSON.parse(vault.open(u.ciphertext, `${account}:stock:${product}:${u.id}`));
    return {
      id: u.id,
      kind: content.kind,
      text: content.kind === 'text' ? content.text : content.name || 'Arquivo digital',
      fileId: content.kind === 'document' ? content.fileId : undefined,
    };
  });
}
export function changeStock(stock: Doc, action: string, version: string, unitId?: string) {
  if (stockVersion(stock) !== version)
    throw new HttpError(
      409,
      'STOCK_CHANGED',
      'O estoque mudou. Atualize a lista antes de continuar.',
    );
  if (action === 'clear') stock.units = [];
  else if (action === 'delete') {
    if (!stock.units.some((u: Doc) => u.id === unitId))
      throw new HttpError(404, 'UNIT_NOT_FOUND', 'Unidade não encontrada.');
    stock.units = stock.units.filter((u: Doc) => u.id !== unitId);
  } else if (action === 'shuffle') {
    for (let i = stock.units.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [stock.units[i], stock.units[j]] = [stock.units[j], stock.units[i]];
    }
  } else throw new HttpError(400, 'STOCK_ACTION', 'Ação inválida.');
}
