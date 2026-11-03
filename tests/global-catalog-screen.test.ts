import test from 'node:test';
import assert from 'node:assert/strict';
import { globalCatalogScreen } from '../server/global-catalog-screen.js';
import { sharedCatalog } from '../server/resale-product.js';
import { MemoryDocuments } from './document-memory.js';
import { tokenHash } from '../server/accounts.js';
import type { Shop } from '../server/bot-types.js';

const offers = Array.from({ length: 17 }, (_, i) => ({
  supplierId: 'supplier',
  baseCents: 899,
  product: {
    id: i.toString(16).padStart(12, '0'),
    title: 'Produto ' + i,
    description: 'Descrição',
    price: 899,
    category: 'Categoria ' + String(i).padStart(2, '0'),
    enabled: true,
    stock: 2,
  },
}));
const shop = { products: [] } as unknown as Shop;
test('Global catalog starts with bounded categories and paginates without losing the chosen category', () => {
  const first = globalCatalogScreen(offers, shop, 'globalcategories:0');
  assert.match(first.text, /17 produtos · 17 categorias/);
  assert.equal(
    first.markup.inline_keyboard.filter((r) =>
      r.some((b) => b.callback_data.startsWith('admin:globalcat:')),
    ).length,
    8,
  );
  const last = globalCatalogScreen(offers, shop, 'globalcategories:999');
  assert.match(last.text, /Página 3 de 3/);
  const cat = offers[3].product.category;
  const selected = globalCatalogScreen(
    offers,
    shop,
    'globalcat:' + tokenHash(cat).slice(0, 16) + ':0',
  );
  assert.match(selected.text, /Categoria 03/);
  assert.equal(
    selected.markup.inline_keyboard.filter((r) =>
      r.some((b) => b.callback_data.startsWith('admin:globalpick:')),
    ).length,
    1,
  );
  for (const screen of [first, last, selected])
    for (const row of screen.markup.inline_keyboard)
      for (const button of row) assert(Buffer.byteLength(button.callback_data) <= 64);
});
test('Published items are marked with supplier cost; empty catalog has a refresh and exit', () => {
  const linked = {
    ...shop,
    products: [
      {
        ...offers[0].product,
        resale_source: { supplierId: 'supplier', productId: offers[0].product.id },
      },
    ],
  };
  const screen = globalCatalogScreen(offers, linked, 'globalproducts:0');
  assert.match(screen.markup.inline_keyboard[0][0].text, /✓ Produto 0/);
  assert.match(screen.markup.inline_keyboard[0][0].text, /8,99/);
  const empty = globalCatalogScreen([], shop, 'globalcategories:0');
  assert.match(empty.text, /CATÁLOGO INDISPONÍVEL/);
  assert(
    empty.markup.inline_keyboard.some((r) => r.some((b) => b.text.includes('Atualizar catálogo'))),
  );
});
test('Catalog reads supplier once for all products and respects explicit blocks and costs', async () => {
  const memory = new MemoryDocuments();
  await memory.transaction(async (tx) => {
    tx.set('resale_platform/settings', { supplier_id: 'supplier' });
    tx.set('resale_profiles/partner', { products: 'approved' });
    tx.set('merchant_accounts/supplier', { access_status: 'approved' });
    tx.set('bot_shops/supplier', { products: offers.map((o) => o.product) });
    tx.set('resale_suppliers/supplier/grants/partner_' + offers[0].product.id, {
      enabled: false,
      baseCents: 899,
    });
    tx.set('resale_suppliers/supplier/grants/partner_' + offers[1].product.id, {
      enabled: true,
      baseCents: 699,
    });
  });
  let supplierReads = 0;
  const rows = await memory.transaction<Awaited<ReturnType<typeof sharedCatalog>>>(async (tx) =>
    sharedCatalog(
      {
        ...tx,
        get: async (p) => {
          if (p === 'bot_shops/supplier') supplierReads++;
          return tx.get(p);
        },
      },
      'partner',
    ),
  );
  assert.equal(supplierReads, 1);
  assert.equal(rows.length, 16);
  assert.equal(rows.find((o) => o.product.id === offers[1].product.id)?.baseCents, 699);
});
