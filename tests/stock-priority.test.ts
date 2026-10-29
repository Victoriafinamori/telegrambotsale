import test from 'node:test';
import assert from 'node:assert/strict';
import { stockView, type StockProduct } from '../web/stock-priority.js';
const products: StockProduct[] = [
  { id: 'healthy', title: 'Arquivo digital', category: 'Arquivos', stock: 20 },
  { id: 'low', title: 'Licença anual', category: 'Ferramentas', stock: 3 },
  { id: 'empty', title: 'Assinatura mensal', category: 'Streaming', stock: 0 },
  { id: 'infinite', title: 'Guia', category: 'Arquivos', stock: 0, stock_mode: 'infinite' },
  { id: 'hidden', title: 'Produto oculto', category: 'Streaming', stock: 0, enabled: false },
  { id: 'ghost', title: 'Atendimento', category: 'Serviços', stock: 5, stock_mode: 'ghost' },
];
test('Replenishment prioritizes exhausted and scarce active stock across categories without changing the Telegram catalog order', () => {
  const before = products.map((p) => p.id);
  const result = stockView(products, { query: '', category: '', availability: 'all' });
  assert.deepEqual(
    result.urgent.map((p) => p.id),
    ['empty', 'low', 'ghost'],
  );
  assert.deepEqual(
    products.map((p) => p.id),
    before,
  );
  assert.deepEqual(
    result.groups.map((g) => g.category),
    ['Arquivos', 'Streaming'],
  );
  assert(!result.urgent.some((p) => ['infinite', 'hidden'].includes(p.id)));
});
test('Stock search combines accent-insensitive names, category and availability without hiding infinity as an exhausted product', () => {
  assert.deepEqual(
    stockView(products, {
      query: 'licenca',
      category: 'Ferramentas',
      availability: 'low',
    }).urgent.map((p) => p.id),
    ['low'],
  );
  assert.deepEqual(
    stockView(products, { query: '', category: '', availability: 'empty' }).urgent.map((p) => p.id),
    ['empty'],
  );
  assert.equal(
    stockView(products, { query: 'ausente', category: '', availability: 'all' }).count,
    0,
  );
});
