import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdir, readFile } from 'node:fs/promises';
import { handleApi } from '../server/cloud-api.js';
import { BASE_CATALOG, normalizeCatalogProduct } from '../public/model.js';

const migrationDirectory = new URL('../drizzle/', import.meta.url);
const migrations = await Promise.all((await readdir(migrationDirectory)).filter(name => name.endsWith('.sql')).sort().map(name => readFile(new URL(name, migrationDirectory), 'utf8')));
class Statement {
  constructor(adapter, sql, values = []) { Object.assign(this, { adapter, sql, values }); }
  bind(...values) { return new Statement(this.adapter, this.sql, values); }
  execute(mode) {
    this.adapter.beforeSQL?.(this.sql);
    if (this.adapter.failSQL?.(this.sql)) throw new Error('private SQL failure');
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
  constructor() { this.sqlite = new DatabaseSync(':memory:'); this.sqlite.exec('PRAGMA foreign_keys=ON;'); for (const migration of migrations) this.sqlite.exec(migration); }
  prepare(sql) { return new Statement(this, sql); }
  async batch(statements) {
    this.sqlite.exec('BEGIN');
    try { const results = statements.map(statement => statement.execute('run')); this.sqlite.exec('COMMIT'); return results; }
    catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
}
const ADMIN = { id: 'order-admin', email: 'owner@example.test' };
const SELLER = { id: 'seller-one', email: 'seller@example.test' };
const OTHER_SELLER = { id: 'seller-two', email: 'other-seller@example.test' };
const BUYER = { id: 'buyer-one', email: 'buyer@example.test' };
const OTHER_BUYER = { id: 'buyer-two', email: 'other-buyer@example.test' };
const ORIGIN = 'https://orders.example.test';
const ITEMS = [{ productId: 'jingtai-apple', variant: 'small', quantity: 2 }, { productId: 'goji', variant: 'family', quantity: 1 }];

function fixture(t) {
  const DB = new D1(); t.after(() => DB.sqlite.close());
  const env = { DB, BOOTSTRAP_ADMIN_EMAIL: ADMIN.email };
  const call = (path, { method = 'GET', user = null, body, origin = ORIGIN, headers = {} } = {}) => {
    const requestHeaders = new Headers(headers);
    if (user) { requestHeaders.set('oai-authenticated-user-id', user.id); requestHeaders.set('oai-authenticated-user-email', user.email); }
    if (method !== 'GET' && method !== 'HEAD' && origin !== null) requestHeaders.set('Origin', origin);
    if (body !== undefined) { requestHeaders.set('Content-Type', requestHeaders.get('Content-Type') || 'application/json'); if (typeof body !== 'string') body = JSON.stringify(body); }
    return handleApi(new Request(ORIGIN + '/api/v1' + path, { method, headers: requestHeaders, body }), env);
  };
  const session = user => call('/session', { user });
  const merchant = async user => {
    await session(user); DB.sqlite.prepare("UPDATE users SET role='merchant' WHERE user_id=?").run(user.id);
    DB.sqlite.prepare(`INSERT INTO merchant_accounts(id,email,user_id,name,region,status,permissions_json,version,created_at,updated_at,created_by,updated_by)
      VALUES(?,?,?,?,?,'enabled',?,1,?,?,?,?)`).run(`MERCHANT-${crypto.randomUUID().toUpperCase()}`, user.email, user.id, user.id, '模拟产地', JSON.stringify(['products', 'orders', 'aftersales']), new Date().toISOString(), new Date().toISOString(), user.id, user.id);
  };
  const publish = async (user = SELLER, id = 'jingtai-apple', overrides = {}) => {
    const product = { ...normalizeCatalogProduct(BASE_CATALOG.find(product => product.id === id) || BASE_CATALOG[0]), id, status: 'published', ...overrides };
    const response = await call('/admin/products/' + id, { method: 'PUT', user, body: { product, expectedVersion: overrides.version || 0 } });
    assert.equal(response.status, 200, await response.clone().text()); return (await response.json()).product;
  };
  const quote = async (items = ITEMS, address = 'gansu', user = BUYER) => {
    const response = await call('/orders/quote', { method: 'POST', user, body: { items, address } });
    assert.equal(response.status, 200, await response.clone().text()); return (await response.json()).quote;
  };
  const payload = async (overrides = {}) => {
    const items = overrides.items || ITEMS, address = overrides.address || 'gansu';
    const q = await quote(items, address, overrides.user || BUYER);
    return { items, address, expectedTotal: q.total, productVersions: q.productVersions, idempotencyKey: crypto.randomUUID(), ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'user')) };
  };
  const create = (body, user = BUYER) => call('/orders', { method: 'POST', user, body });
  const mutation = (path, body, user = BUYER) => call(path, { method: 'POST', user, body });
  const setup = async () => { await session(ADMIN); await merchant(SELLER); await merchant(OTHER_SELLER); await publish(SELLER); await publish(SELLER, 'goji'); };
  return { DB, call, session, merchant, publish, quote, payload, create, mutation, setup };
}
async function data(response, expected = 200) {
  assert.equal(response.status, expected, await response.clone().text());
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  return response.json();
}

test('cloud quotes use trusted current prices and snapshot a combined same-merchant order without payment', async t => {
  const f = fixture(t); await f.setup();
  const quote = await f.quote();
  assert.equal(quote.address, 'gansu'); assert.equal(quote.shipping, 600); assert.equal(quote.quantity, 3);
  assert.equal(quote.total, BASE_CATALOG[0].variants[0].price * 2 + BASE_CATALOG.find(product => product.id === 'goji').variants[1].price + 600);
  assert.deepEqual(quote.productVersions, { goji: 1, 'jingtai-apple': 1 });
  const input = await f.payload();
  const { order, replayed } = await data(await f.create(input), 201);
  assert.equal(replayed, false); assert.match(order.id, /^DEMO-[A-F0-9-]{36}$/); assert.equal(order.version, 1);
  assert.equal(order.total, quote.total); assert.equal(order.items.length, 2); assert.equal(order.status, 'created');
  assert.equal(order.fulfillment, undefined); assert.equal(order.buyerId, undefined); assert.equal(order.sellerId, undefined);
  assert.deepEqual(order.afterSaleHistory, []);
  assert.deepEqual((await data(await f.call('/orders/' + order.id, { user: BUYER }))).order, order);
  assert.equal((await data(await f.call('/orders', { user: BUYER }))).orders.length, 1);
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) AS n FROM orders').get().n, 1);
});

test('orders enforce account and merchant isolation, no anonymous reads and no buyer management writes', async t => {
  const f = fixture(t); await f.setup();
  const { order } = await data(await f.create(await f.payload()), 201);
  await data(await f.call('/orders'), 401); await data(await f.call('/admin/orders'), 401);
  await data(await f.create(await f.payload(), null), 401);
  await data(await f.call('/orders/' + order.id, { user: OTHER_BUYER }), 404);
  assert.deepEqual((await data(await f.call('/orders', { user: OTHER_BUYER }))).orders, []);
  assert.deepEqual((await data(await f.call('/orders', { user: SELLER }))).orders, []);
  assert.equal((await data(await f.call('/admin/orders', { user: SELLER }))).orders.length, 1);
  assert.deepEqual((await data(await f.call('/admin/orders', { user: OTHER_SELLER }))).orders, []);
  await data(await f.call('/admin/orders/' + order.id, { user: OTHER_SELLER }), 404);
  await data(await f.mutation('/admin/orders/' + order.id + '/ship', { expectedVersion: 1, carrier: '模拟快递', tracking: 'DEMO-SHIP-1' }), 403);
  await data(await f.mutation('/orders/' + order.id + '/cancel', { expectedVersion: 1 }, OTHER_BUYER), 404);
  const noted = await data(await f.mutation('/admin/orders/' + order.id + '/note', { expectedVersion: 1, note: '仅商家内部可见' }, SELLER));
  assert.equal(noted.order.merchantNote, '仅商家内部可见');
  assert.equal((await data(await f.call('/orders/' + order.id, { user: BUYER }))).order.merchantNote, undefined);
  assert.equal((await data(await f.call('/orders', { user: BUYER }))).orders[0].merchantNote, undefined);
  await data(await f.call('/admin/orders', { user: BUYER }), 403);
});

test('idempotent retries and concurrent creates never duplicate an order, including after catalog changes', async t => {
  const f = fixture(t); await f.setup();
  const input = await f.payload();
  const responses = await Promise.all([f.create(input), f.create(input)]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 201]);
  const first = await responses[0].json(), second = await responses[1].json();
  assert.equal(first.order.id, second.order.id);
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) AS n FROM orders').get().n, 1);
  await f.publish(SELLER, 'jingtai-apple', { version: 1, status: 'offline' });
  const retried = await data(await f.create(input)); assert.equal(retried.replayed, true); assert.equal(retried.order.id, first.order.id);
  await data(await f.create({ ...input, items: [{ ...ITEMS[0], quantity: 1 }, ITEMS[1]] }), 409);
  await data(await f.create({ ...input, expectedTotal: input.expectedTotal - 1 }), 409);
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) AS n FROM orders').get().n, 1);
});

test('stale prices, forged totals and a product update between quote and insert cannot create orders', async t => {
  const f = fixture(t); await f.setup();
  const input = await f.payload();
  await data(await f.create({ ...input, expectedTotal: 1 }), 409);
  await f.publish(SELLER, 'jingtai-apple', { version: 1, name: '新批次苹果' });
  await data(await f.create(input), 409);
  const fresh = await f.payload();
  f.DB.beforeSQL = sql => {
    if (!sql.startsWith('INSERT INTO orders')) return;
    f.DB.beforeSQL = null;
    f.DB.sqlite.prepare("UPDATE products SET status='offline',version=version+1 WHERE id='goji'").run();
  };
  await data(await f.create(fresh), 409);
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) AS n FROM orders').get().n, 0);
});

test('mixed merchants and malformed order bodies are rejected before persistence', async t => {
  const f = fixture(t); await f.setup(); await f.publish(OTHER_SELLER, 'pear');
  await data(await f.call('/orders/quote', { method: 'POST', user: BUYER, body: { items: [ITEMS[0], { productId: 'pear', variant: 'small', quantity: 1 }], address: 'gansu' } }), 422);
  const input = await f.payload();
  for (const invalid of [
    { ...input, buyerId: OTHER_BUYER.id }, { ...input, total: 1 }, { ...input, address: 'other' },
    { ...input, items: [] }, { ...input, items: [ITEMS[0], ITEMS[0]] }, { ...input, items: [{ ...ITEMS[0], quantity: 11 }] },
    { ...input, items: [{ ...ITEMS[0], unitPrice: 1 }] }, { ...input, items: [{ ...ITEMS[0], quantity: '1' }] },
    { ...input, idempotencyKey: 'bad' }, { ...input, productVersions: {} }, { ...input, productVersions: { ...input.productVersions, fake: 1 } }
  ]) await data(await f.create(invalid), 400);
  await data(await f.call('/orders', { method: 'POST', user: BUYER, body: input, origin: null }), 403);
  await data(await f.call('/orders', { method: 'POST', user: BUYER, body: input, origin: 'https://evil.test' }), 403);
  await data(await f.call('/orders', { method: 'POST', user: BUYER, body: input, headers: { 'Content-Type': 'text/plain' } }), 415);
  await data(await f.call('/orders', { method: 'POST', user: BUYER, body: '{invalid' }), 400);
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) AS n FROM orders').get().n, 0);
});

test('shipping and order versions serialize multi-device state changes and preserve the original snapshot', async t => {
  const f = fixture(t); await f.setup();
  const { order } = await data(await f.create(await f.payload()), 201);
  await f.publish(SELLER, 'jingtai-apple', { version: 1, name: '后来的苹果', status: 'offline' });
  const paths = '/admin/orders/' + order.id;
  const responses = await Promise.all([
    f.mutation(paths + '/ship', { expectedVersion: 1, carrier: '模拟快递', tracking: 'DEMO-TRACK-1' }, SELLER),
    f.mutation(paths + '/note', { expectedVersion: 1, note: '并行备注' }, ADMIN)
  ]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  const current = (await data(await f.call('/orders/' + order.id, { user: BUYER }))).order;
  assert.equal(current.version, 2); assert.deepEqual(current.items, order.items); assert.equal(current.total, order.total);
  if (!current.fulfillment) await data(await f.mutation(paths + '/ship', { expectedVersion: 2, carrier: '模拟快递', tracking: 'DEMO-TRACK-1' }, ADMIN));
  const shipped = (await data(await f.call('/orders/' + order.id, { user: BUYER }))).order;
  assert.equal(shipped.fulfillment.status, 'shipped');
  await data(await f.mutation('/orders/' + order.id + '/cancel', { expectedVersion: shipped.version }), 409);
  await data(await f.mutation(paths + '/ship', { expectedVersion: shipped.version, carrier: '模拟快递', tracking: 'DEMO-AGAIN' }, SELLER), 409);
});

test('after-sale submit, withdraw, reapply and merchant resolution synchronize with immutable history', async t => {
  const f = fixture(t); await f.setup();
  const { order } = await data(await f.create(await f.payload()), 201);
  const base = '/orders/' + order.id, adminBase = '/admin/orders/' + order.id;
  const application = { expectedVersion: 1, type: 'replacement', reason: 'damaged', description: '模拟坏果，无真实收货信息', hasEvidence: true };
  let current = (await data(await f.mutation(base + '/aftersale', application))).order;
  assert.equal(current.version, 2); assert.equal(current.afterSale.status, 'submitted'); assert.equal(current.afterSaleHistory.length, 1);
  await data(await f.mutation(adminBase + '/ship', { expectedVersion: 2, carrier: '模拟快递', tracking: 'DEMO-BLOCKED' }, SELLER), 409);
  await data(await f.mutation(base + '/cancel', { expectedVersion: 2 }), 409);
  await data(await f.mutation(base + '/aftersale', { ...application, expectedVersion: 2 }), 409);
  await data(await f.mutation(adminBase + '/aftersale/resolve', { expectedVersion: 2, reply: '买家无权完成' }), 403);
  current = (await data(await f.mutation(base + '/aftersale/withdraw', { expectedVersion: 2 }))).order;
  assert.equal(current.afterSale.status, 'withdrawn'); assert.equal(current.afterSaleHistory.length, 2);
  current = (await data(await f.mutation(base + '/aftersale', { ...application, expectedVersion: 3, type: 'refund' }))).order;
  assert.notEqual(current.afterSale.id, current.afterSaleHistory[0].id);
  current = (await data(await f.mutation(adminBase + '/aftersale/resolve', { expectedVersion: 4, reply: '模拟退款完成，实际退款0元' }, SELLER))).order;
  assert.equal(current.afterSale.status, 'resolved'); assert.equal(current.version, 5);
  assert.deepEqual(current.afterSaleHistory.map(value => value.status), ['submitted', 'withdrawn', 'submitted', 'resolved']);
  assert.equal(current.afterSaleHistory.at(-1).merchantReply, '模拟退款完成，实际退款0元');
  const otherDevice = (await data(await f.call(base, { user: BUYER }))).order;
  assert.deepEqual(otherDevice.afterSaleHistory, current.afterSaleHistory);
  await data(await f.mutation(adminBase + '/ship', { expectedVersion: 5, carrier: '模拟快递', tracking: 'DEMO-BLOCKED' }, SELLER), 409);
  await data(await f.mutation(base + '/cancel', { expectedVersion: 5 }), 409);
  await data(await f.mutation(base + '/aftersale', { ...application, expectedVersion: 5 }), 409);
});

test('cancelled orders remain readable and cannot be shipped or claim after-sale', async t => {
  const f = fixture(t); await f.setup(); const { order } = await data(await f.create(await f.payload()), 201);
  const cancelled = (await data(await f.mutation('/orders/' + order.id + '/cancel', { expectedVersion: 1 }))).order;
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.version, 2);
  await data(await f.mutation('/admin/orders/' + order.id + '/ship', { expectedVersion: 2, carrier: '模拟快递', tracking: 'DEMO-NO' }, ADMIN), 409);
  await data(await f.mutation('/orders/' + order.id + '/aftersale', { expectedVersion: 2, type: 'refund', reason: 'other', description: '', hasEvidence: false }), 409);
});

test('keyset pagination traverses every order once and validates cursor without crossing account filters', async t => {
  const f = fixture(t); await f.setup();
  const input = await f.payload();
  for (let i = 0; i < 103; i++) await data(await f.create({ ...input, idempotencyKey: 'pagination-' + i }), 201);
  await data(await f.create({ ...input, idempotencyKey: 'another-buyer-key' }, OTHER_BUYER), 201);
  const first = await data(await f.call('/orders', { user: BUYER }));
  assert.equal(first.orders.length, 100); assert.ok(first.nextCursor);
  const second = await data(await f.call('/orders?cursor=' + first.nextCursor, { user: BUYER }));
  assert.equal(second.orders.length, 3); assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.orders, ...second.orders].map(order => order.id)).size, 103);
  const other = await data(await f.call('/orders', { user: OTHER_BUYER })); assert.equal(other.orders.length, 1);
  for (const query of ['?cursor=%', '?cursor=abc', '?cursor=', '?buyerId=buyer-two', '?cursor=a&cursor=b']) await data(await f.call('/orders' + query, { user: BUYER }), 400);
});

test('database failures are generic, leave no phantom order, and never report failed state writes as success', async t => {
  const f = fixture(t); await f.setup(); const input = await f.payload();
  f.DB.failSQL = sql => sql.startsWith('INSERT INTO orders');
  const error = await data(await f.create(input), 503); assert.ok(!JSON.stringify(error).includes('private SQL'));
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) AS n FROM orders').get().n, 0);
  f.DB.failSQL = null; const { order } = await data(await f.create(input), 201);
  f.DB.failSQL = sql => sql.startsWith('UPDATE orders');
  await data(await f.mutation('/orders/' + order.id + '/cancel', { expectedVersion: 1 }), 503);
  f.DB.failSQL = null;
  const stored = (await data(await f.call('/orders/' + order.id, { user: BUYER }))).order;
  assert.equal(stored.version, 1); assert.equal(stored.status, 'created');
});
