import test from 'node:test';
import assert from 'node:assert/strict';
import { supplierStockScreen } from '../server/supplier-stock-screen.js';
import { tokenHash } from '../server/token-hash.js';
import type { Shop } from '../server/bot-types.js';
const shop = {
  products: Array.from({ length: 12 }, (_, i) => ({
    id: i.toString(16).padStart(12, '0'),
    title: 'Produto ' + i,
    category: 'Digital',
    price: 899,
    stock: i === 0 ? 0 : i === 1 ? 2 : 15,
    description: 'Produto',
    enabled: true,
  })),
} as unknown as Shop;
test('Supplier hub organizes categories, prioritizes empty stock and paginates existing stock controls', () => {
  const original = structuredClone(shop);
  const home = supplierStockScreen(shop, 'supplier');
  assert.match(home.text, /1 sem estoque · 1 com até 5/);
  assert.match(JSON.stringify(home.markup), /supplierlow:0/);
  const urgent = supplierStockScreen(shop, 'supplierlow:0');
  assert.equal(
    urgent.markup.inline_keyboard[0][0].callback_data,
    'admin:stockfor:' + '0'.repeat(12),
  );
  const category = supplierStockScreen(
    shop,
    'suppliercat:' + tokenHash('Digital').slice(0, 16) + ':0',
  );
  assert.equal(
    category.markup.inline_keyboard.filter((r) => r[0].callback_data.startsWith('admin:stockfor:'))
      .length,
    8,
  );
  assert.match(JSON.stringify(category.markup), /Próxima/);
  assert.deepEqual(shop, original);
});
test('Supplier stock hub excludes linked stock and does not treat infinite or disabled stock as urgent', () => {
  const copy = structuredClone(shop);
  copy.products[0].stock_mode = 'infinite';
  copy.products[1].enabled = false;
  copy.products.push({
    ...copy.products[0],
    id: 'a'.repeat(12),
    stock: 0,
    resale_source: { supplierId: 'other', productId: 'b'.repeat(12) },
  });
  const home = supplierStockScreen(copy, 'supplier');
  assert.match(home.text, /12 produtos/);
  assert.doesNotMatch(JSON.stringify(home.markup), /supplierlow/);
  assert.doesNotMatch(JSON.stringify(home.markup), /stockfor:aaaaaaaaaaaa/);
});
