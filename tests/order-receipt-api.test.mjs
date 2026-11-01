import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdir, readFile } from 'node:fs/promises';
import { handleApi } from '../server/cloud-api.js';
import { BASE_CATALOG, createOrder, shipOrder, createAfterSale, resolveAfterSale } from '../public/model.js';

const migrationDirectory = new URL('../drizzle/', import.meta.url);
const migrations = await Promise.all((await readdir(migrationDirectory)).filter(name => name.endsWith('.sql')).sort().map(name => readFile(new URL(name, migrationDirectory), 'utf8')));
class Statement {
  constructor(adapter, sql, values = []) { Object.assign(this, { adapter, sql, values }); }
  bind(...values) { return new Statement(this.adapter, this.sql, values); }
  execute(mode) {
    this.adapter.beforeSQL?.(this.sql);
    const statement = this.adapter.sqlite.prepare(this.sql);
    if (mode === 'first') return statement.get(...this.values) || null;
    if (mode === 'all') return { results: statement.all(...this.values) };
    return { meta: { changes: Number(statement.run(...this.values).changes) } };
  }
  async first(column) { const row = this.execute('first'); return column ? row?.[column] ?? null : row; }
  async all() { return this.execute('all'); }
  async run() { return this.execute('run'); }
}
class D1 {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec('PRAGMA foreign_keys=ON;');
    for (const migration of migrations) this.sqlite.exec(migration);
  }
  prepare(sql) { return new Statement(this, sql); }
  async batch(statements) {
    this.sqlite.exec('BEGIN');
    try { const values = statements.map(statement => statement.execute('run')); this.sqlite.exec('COMMIT'); return values; }
    catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
}
const ADMIN = { id: 'receipt-admin', email: 'receipt-admin@example.test' };
const SELLER = { id: 'receipt-seller', email: 'receipt-seller@example.test' };
const BUYER = { id: 'receipt-buyer', email: 'receipt-buyer@example.test' };
const OTHER = { id: 'receipt-other', email: 'receipt-other@example.test' };
const ORIGIN = 'https://receipt.example.test';
const createdAt = '2026-10-30T00:00:00.000Z';
const shippedAt = '2026-10-30T01:00:00.000Z';
const afterInput = { type: 'refund', reason: 'damaged', description: '模拟收货问题，无真实客户资料', hasEvidence: false };

async function data(response, expected = 200) {
  assert.equal(response.status, expected, await response.clone().text());
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  return response.json();
}
async function fixture(t) {
  const DB = new D1(); t.after(() => DB.sqlite.close());
  const env = { DB, BOOTSTRAP_ADMIN_EMAIL: ADMIN.email };
  const call = (path, { method = 'GET', user = BUYER, body, origin = ORIGIN } = {}) => {
    const headers = { Accept: 'application/json' };
    if (user) { headers['oai-authenticated-user-id'] = user.id; headers['oai-authenticated-user-email'] = user.email; }
    if (method !== 'GET' && origin !== null) headers.Origin = origin;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return handleApi(new Request(ORIGIN + '/api/v1' + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
  };
  for (const user of [ADMIN, SELLER, BUYER, OTHER]) await data(await call('/session', { user }));
  DB.sqlite.prepare("UPDATE users SET role='merchant' WHERE user_id=?").run(SELLER.id);
  DB.sqlite.prepare(`INSERT INTO merchant_accounts(id,email,user_id,name,region,status,permissions_json,version,created_at,updated_at,created_by,updated_by)
    VALUES(?,?,?,?,?,'enabled',?,1,?,?,?,?)`).run(`MERCHANT-${crypto.randomUUID().toUpperCase()}`, SELLER.email, SELLER.id, '收货验收采购者（模拟）', '甘肃·景泰', JSON.stringify(['products', 'orders', 'aftersales']), createdAt, createdAt, ADMIN.id, ADMIN.id);
  await data(await call('/admin/products/jingtai-apple', { method: 'PUT', user: SELLER, body: { product: BASE_CATALOG[0], expectedVersion: 0 } }));
  DB.sqlite.prepare(`INSERT INTO product_inventory(product_id,small_stock,family_stock,batch_id,batch_code,harvest_date,note,version,updated_at,updated_by)
    VALUES('jingtai-apple',7,9,?,'RECEIPT-TEST','2026-10-30','模拟库存，不应因收货变化',1,?,?)`).run(`BATCH-${crypto.randomUUID().toUpperCase()}`, createdAt, SELLER.id);
  const seed = (transform = value => value) => {
    const id = `DEMO-${crypto.randomUUID().toUpperCase()}`;
    const initial = createOrder({ productId: 'jingtai-apple', variant: 'small', quantity: 1, address: 'gansu' }, id, createdAt);
    const order = transform(shipOrder({ ...initial, merchantNote: '仅后台可见的模拟备注' }, '模拟物流', 'DEMO-RECEIPT-API', shippedAt));
    DB.sqlite.prepare('INSERT INTO orders(id,buyer_id,seller_id,request_key,request_json,order_json,version,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?)')
      .run(id, BUYER.id, SELLER.id, crypto.randomUUID(), '{}', JSON.stringify(order), createdAt, createdAt);
    return order;
  };
  const mutate = (order, action, body = { expectedVersion: 1 }, user = BUYER) => call('/orders/' + order.id + '/' + action, { method: 'POST', user, body });
  const row = id => DB.sqlite.prepare('SELECT * FROM orders WHERE id=?').get(id);
  const stock = () => ({ inventory: DB.sqlite.prepare('SELECT * FROM product_inventory').all(), events: DB.sqlite.prepare('SELECT * FROM inventory_events').all() });
  return { DB, call, seed, mutate, row, stock };
}

test('only the owning buyer confirms receipt, changing no stock, snapshots or private fields', async t => {
  const f = await fixture(t), order = f.seed(), beforeStock = f.stock();
  const { order: received } = await data(await f.mutate(order, 'receive'));
  assert.equal(received.version, 2);
  assert.equal(received.status, 'created');
  assert.deepEqual(received.fulfillment, order.fulfillment);
  assert.equal(received.receipt.status, 'received');
  assert.ok(Date.parse(received.receipt.receivedAt) >= Date.parse(shippedAt));
  assert.equal(received.total, order.total);
  assert.equal(received.merchantNote, undefined);
  assert.equal(received.buyerId, undefined);
  assert.equal(received.sellerId, undefined);
  assert.deepEqual(f.stock(), beforeStock, 'Receipt must never replenish, reserve or audit stock.');
  const saved = f.row(order.id);
  assert.equal(JSON.parse(saved.order_json).merchantNote, order.merchantNote);
  await data(await f.mutate(order, 'receive'), 409);
  const again = await data(await f.mutate(order, 'receive', { expectedVersion: 2 }), 409);
  assert.equal(again.error.code, 'order_state_invalid');
  assert.deepEqual(f.row(order.id), saved, 'Retries must not increment versions or replace receipt time.');
  assert.deepEqual((await data(await f.call('/orders/' + order.id))).order.receipt, received.receipt);
  assert.deepEqual((await data(await f.call('/admin/orders/' + order.id, { user: SELLER }))).order.receipt, received.receipt);
});

test('another buyer, merchant and administrator cannot impersonate the recipient', async t => {
  const f = await fixture(t), order = f.seed(), saved = f.row(order.id);
  for (const user of [OTHER, SELLER, ADMIN]) await data(await f.mutate(order, 'receive', { expectedVersion: 1 }, user), 404);
  await data(await f.mutate(order, 'receive', { expectedVersion: 1 }, null), 401);
  for (const user of [SELLER, ADMIN]) await data(await f.call('/admin/orders/' + order.id + '/receive', { method: 'POST', user, body: { expectedVersion: 1 } }), 404);
  await data(await f.call('/orders/' + order.id + '/receive', { method: 'POST', body: { expectedVersion: 1 }, origin: 'https://other.example.test' }), 403);
  assert.deepEqual(f.row(order.id), saved);
});

test('receipt respects lifecycle constraints, field validation and chronological order', async t => {
  const f = await fixture(t);
  const pending = value => createAfterSale(value, afterInput, 'AFTER-RECEIPT-PENDING', '2026-10-30T02:00:00.000Z');
  for (const transform of [value => { const copy = { ...value }; delete copy.fulfillment; return copy; }, value => ({ ...value, status: 'cancelled' }),
    pending, value => resolveAfterSale(pending(value), '模拟退款已完成', '2026-10-30T03:00:00.000Z'),
    value => ({ ...value, fulfillment: { ...value.fulfillment, shippedAt: '2999-01-01T00:00:00.000Z' } }),
    value => ({ ...value, createdAt: '2026-10-31T00:00:00.000Z' })]) {
    const order = f.seed(transform), saved = f.row(order.id);
    assert.equal((await data(await f.mutate(order, 'receive'), 409)).error.code, 'order_state_invalid');
    assert.deepEqual(f.row(order.id), saved);
  }
  const order = f.seed(), saved = f.row(order.id);
  for (const body of [{}, { expectedVersion: 0 }, { expectedVersion: '1' }, { expectedVersion: 1, receipt: { status: 'received', receivedAt: createdAt } },
    { expectedVersion: 1, buyerId: BUYER.id }, { expectedVersion: 1, status: 'received' }]) await data(await f.mutate(order, 'receive', body), 400);
  await data(await f.call('/orders/' + order.id + '/receive'), 405);
  assert.deepEqual(f.row(order.id), saved);
});

test('completed receipt still supports after-sale service and rejects cancellation or reshipping', async t => {
  const f = await fixture(t), original = f.seed(), beforeStock = f.stock();
  let order = (await data(await f.mutate(original, 'receive'))).order;
  const receipt = structuredClone(order.receipt);
  await data(await f.mutate(order, 'cancel', { expectedVersion: order.version }), 409);
  await data(await f.call('/admin/orders/' + order.id + '/ship', { method: 'POST', user: SELLER,
    body: { expectedVersion: order.version, carrier: '模拟物流', tracking: 'DEMO-AGAIN' } }), 409);
  order = (await data(await f.mutate(order, 'aftersale', { expectedVersion: order.version, ...afterInput }))).order;
  assert.equal(order.afterSale.status, 'submitted');
  assert.deepEqual(order.receipt, receipt);
  order = (await data(await f.call('/admin/orders/' + order.id + '/aftersale/resolve', { method: 'POST', user: SELLER,
    body: { expectedVersion: order.version, reply: '模拟售后完成，无实际退款' } }))).order;
  assert.equal(order.afterSale.status, 'resolved');
  assert.deepEqual(order.receipt, receipt);
  assert.deepEqual(f.stock(), beforeStock);
});

test('concurrent confirmation is version checked and ownership is checked again at write time', async t => {
  const f = await fixture(t), order = f.seed(), beforeStock = f.stock();
  const results = await Promise.all([f.mutate(order, 'receive'), f.mutate(order, 'receive')]);
  assert.deepEqual(results.map(response => response.status).sort(), [200, 409]);
  const stored = f.row(order.id);
  assert.equal(stored.version, 2);
  assert.equal(JSON.parse(stored.order_json).receipt.status, 'received');
  assert.deepEqual(f.stock(), beforeStock);
  const changed = f.seed();
  f.DB.beforeSQL = sql => {
    if (!sql.startsWith('UPDATE orders SET order_json=')) return;
    f.DB.beforeSQL = null;
    f.DB.sqlite.prepare('UPDATE orders SET buyer_id=? WHERE id=?').run(OTHER.id, changed.id);
  };
  assert.equal((await data(await f.mutate(changed, 'receive'), 409)).error.code, 'version_conflict');
  assert.equal(f.row(changed.id).version, 1);
  assert.equal(JSON.parse(f.row(changed.id).order_json).receipt, undefined);
});
