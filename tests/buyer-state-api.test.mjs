import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdir, readFile } from 'node:fs/promises';
import { handleApi } from '../server/cloud-api.js';

const directory = new URL('../drizzle/', import.meta.url);
const migrations = await Promise.all((await readdir(directory)).filter(name => name.endsWith('.sql')).sort().map(name => readFile(new URL(name, directory), 'utf8')));
const ORIGIN = 'https://shopping.example.test', NOW = '2026-11-01T00:00:00.000Z';
const BUYER = { id: 'private-buyer-one', email: 'buyer-one@private.test' }, OTHER = { id: 'private-buyer-two', email: 'buyer-two@private.test' };
const empty = () => ({ cart: [], favorites: [], recent: [], preferredAddress: 'gansu' });
const apple = { productId: 'jingtai-apple', variant: 'small', quantity: 4, selected: true };
const goji = { productId: 'goji', variant: 'small', quantity: 3, selected: false };
const input = () => ({ cart: [{ ...apple }, { ...goji }], favorites: ['jingtai-apple'], recent: ['goji', 'jingtai-apple'], preferredAddress: 'shaanxi' });
class Statement {
  constructor(db, sql, values = []) { Object.assign(this, { db, sql, values }); }
  bind(...values) { return new Statement(this.db, this.sql, values); }
  execute(mode) {
    this.db.beforeSQL?.(this.sql);
    if (this.db.failSQL?.(this.sql)) throw new Error('private database details');
    const query = this.db.sqlite.prepare(this.sql);
    if (mode === 'first') return query.get(...this.values) || null;
    if (mode === 'all') return { results: query.all(...this.values) };
    return { meta: { changes: Number(query.run(...this.values).changes) } };
  }
  async first() { return this.execute('first'); }
  async all() { return this.execute('all'); }
  async run() { return this.execute('run'); }
}
class D1 {
  constructor() { this.sqlite = new DatabaseSync(':memory:'); this.sqlite.exec('PRAGMA foreign_keys=ON'); for (const sql of migrations) this.sqlite.exec(sql); }
  prepare(sql) { return new Statement(this, sql); }
  async batch(statements) {
    this.sqlite.exec('BEGIN');
    try { const result = statements.map(statement => statement.execute('run')); this.sqlite.exec('COMMIT'); return result; }
    catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
}
async function data(response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  return response.json();
}
function fixture(t) {
  const DB = new D1(); t.after(() => DB.sqlite.close());
  DB.sqlite.prepare('INSERT INTO users(user_id,email,name,role,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('seller-admin', 'admin@private.test', 'Private admin', 'admin', NOW, NOW);
  const call = (path = '', { method = 'GET', user = BUYER, body, origin = ORIGIN } = {}) => {
    const headers = new Headers();
    if (user) { headers.set('oai-authenticated-user-id', user.id); headers.set('oai-authenticated-user-email', user.email); }
    if (!['GET', 'HEAD'].includes(method) && origin !== null) headers.set('Origin', origin);
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    return handleApi(new Request(ORIGIN + '/api/v1/me/shopping' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), { DB });
  };
  const read = async user => data(await call('', { user }));
  const save = (state, expectedVersion = 0, user = BUYER) => call('', { method: 'PUT', user, body: { expectedVersion, state } });
  const order = (buyer = BUYER, items = [{ ...apple, quantity: 2 }]) => {
    const id = `DEMO-${crypto.randomUUID().toUpperCase()}`, snapshot = { id, items, status: 'created' };
    DB.sqlite.prepare('INSERT INTO orders(id,buyer_id,seller_id,request_key,request_json,order_json,version,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?)').run(id, buyer.id, 'seller-admin', crypto.randomUUID(), '{}', JSON.stringify(snapshot), NOW, NOW);
    return id;
  };
  const consume = (orderId, expectedVersion, user = BUYER) => call('/consume-order', { method: 'POST', user, body: { orderId, expectedVersion } });
  const rows = table => DB.sqlite.prepare(`SELECT count(*) n FROM ${table}`).get().n;
  return { DB, call, read, save, order, consume, rows };
}

test('shopping starts as a read-only version-zero state and only the trusted buyer owns saved preferences', async t => {
  const f = fixture(t);
  await data(await f.call('', { user: null }), 401);
  const initial = await f.read(BUYER); assert.deepEqual(initial, { state: empty(), version: 0, updatedAt: null }); assert.equal(f.rows('buyer_shopping'), 0);
  const state = { ...input(), cart: [{ ...apple, productId: 'removed-public-product' }], preferredAddress: 'other' };
  const saved = await data(await f.save(state)); assert.equal(saved.version, 1); assert.deepEqual(saved.state, state);
  assert.deepEqual((await f.read(OTHER)).state, empty()); assert.deepEqual((await f.read(BUYER)).state, state);
  assert.deepEqual(Object.keys(saved).sort(), ['state', 'updatedAt', 'version']);
  assert.doesNotMatch(JSON.stringify(saved), /private-buyer|@private|user_id|email|ownerId|permissions|seller-admin/);
  await data(await f.call('', { method: 'PUT', body: { expectedVersion: 1, state, accountId: OTHER.id } }), 400);
  assert.equal(f.rows('orders'), 0); assert.equal(f.rows('product_inventory'), 0);
});

test('shopping validation rejects unknown or real-address fields, duplicates, oversized lists and invalid SKU quantities without writes', async t => {
  const f = fixture(t);
  const invalid = [
    null, [], { ...empty(), name: '真实姓名' }, { ...empty(), preferredAddress: '我的家庭住址' },
    { ...empty(), cart: [{ ...apple, quantity: 0 }] }, { ...empty(), cart: [{ ...apple, quantity: 11 }] },
    { ...empty(), cart: [{ ...apple, quantity: 1.5 }] }, { ...empty(), cart: [{ ...apple, variant: 'custom' }] },
    { ...empty(), cart: [{ ...apple, selected: undefined }] }, { ...empty(), cart: [{ ...apple, selected: 'true' }] },
    { ...empty(), cart: [{ ...apple, productId: '<script>' }] }, { ...empty(), cart: [{ ...apple, buyerId: OTHER.id }] },
    { ...empty(), cart: [{ ...apple }, { ...apple }] },
    { ...empty(), cart: Array.from({ length: 13 }, (_, index) => ({ ...apple, productId: `product-${index}` })) },
    { ...empty(), favorites: ['goji', 'goji'] }, { ...empty(), favorites: Array.from({ length: 21 }, (_, index) => `product-${index}`) },
    { ...empty(), recent: [null] }, { ...empty(), recent: ['email@private.test'] }
  ];
  for (const state of invalid) await data(await f.save(state), 400);
  for (const expectedVersion of [-1, 0.5, '0', Number.MAX_SAFE_INTEGER]) await data(await f.save(empty(), expectedVersion), 400);
  assert.equal(f.rows('buyer_shopping'), 0);
});

test('first insert and later writes use atomic compare-and-swap; a second device never overwrites the winning revision', async t => {
  const f = fixture(t), first = input(), other = { ...empty(), favorites: ['corn'] };
  let responses = await Promise.all([f.save(first, 0), f.save(other, 0)]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  const v1 = await f.read(); assert.equal(v1.version, 1);
  responses = await Promise.all([f.save({ ...first, preferredAddress: 'other' }, 1), f.save(other, 1)]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  const winner = await responses.find(response => response.status === 200).json(), current = await f.read();
  assert.equal(current.version, 2); assert.deepEqual(current.state, winner.state); assert.equal(f.rows('buyer_shopping'), 1);
  await data(await f.save(first, 1), 409); assert.deepEqual((await f.read()).state, winner.state);
});

test('order consumption subtracts snapshot quantities, keeps unselected and later-added amounts, and persists a replay marker', async t => {
  const f = fixture(t); await data(await f.save(input()));
  const orderId = f.order(BUYER, [{ ...apple, quantity: 2 }, { ...goji, quantity: 1 }]);
  let result = await data(await f.consume(orderId, 1));
  assert.equal(result.consumed, true); assert.equal(result.version, 2);
  assert.deepEqual(result.state, { ...input(), cart: [{ ...apple, quantity: 2 }, goji] });
  assert.equal(f.rows('buyer_order_consumptions'), 1);
  assert.deepEqual(await data(await f.consume(orderId, 1)), result, 'old expectedVersion is safe for an already-consumed order');
  const later = { ...input(), cart: [{ ...apple, quantity: 5 }, goji] };
  await data(await f.save(later, 2)); result = await data(await f.consume(orderId, 0));
  assert.equal(result.version, 3); assert.deepEqual(result.state, later); assert.equal(f.rows('buyer_order_consumptions'), 1);
  await f.read(OTHER); await data(await f.consume(orderId, 0, OTHER), 404);
  await data(await f.consume(`DEMO-${crypto.randomUUID().toUpperCase()}`, 0, OTHER), 404);
});

test('consumption before a shopping row exists is recorded once and cannot remove a future basket', async t => {
  const f = fixture(t); await f.read(); const orderId = f.order();
  const consumed = await data(await f.consume(orderId, 0)); assert.equal(consumed.version, 1); assert.deepEqual(consumed.state, empty());
  await data(await f.save(input(), 1));
  const replay = await data(await f.consume(orderId, 0)); assert.equal(replay.version, 2); assert.deepEqual(replay.state, input());
});

test('consumption conflicts leave no marker, and failure while recording the marker rolls back the cart update', async t => {
  const f = fixture(t); await data(await f.save(input())); const orderId = f.order();
  const before = await f.read();
  await data(await f.consume(orderId, 0), 409); assert.equal(f.rows('buyer_order_consumptions'), 0);
  f.DB.failSQL = sql => sql.startsWith('INSERT INTO buyer_order_consumptions');
  await data(await f.consume(orderId, 1), 503); f.DB.failSQL = null;
  assert.equal(f.rows('buyer_order_consumptions'), 0); assert.deepEqual(await f.read(), before);
  await data(await f.consume(orderId, 1)); assert.equal((await f.read()).version, 2);
});

test('a device changing the cart between consumption read and transaction cannot produce an orphan marker or overwrite its state', async t => {
  const f = fixture(t); await data(await f.save(input())); const orderId = f.order();
  const competing = { ...input(), preferredAddress: 'other', cart: [{ ...apple, quantity: 9 }] };
  f.DB.beforeSQL = sql => {
    if (!sql.startsWith('UPDATE buyer_shopping')) return;
    f.DB.beforeSQL = null;
    f.DB.sqlite.prepare('UPDATE buyer_shopping SET state_json=?,version=version+1 WHERE user_id=?').run(JSON.stringify(competing), BUYER.id);
  };
  await data(await f.consume(orderId, 1), 409);
  assert.equal(f.rows('buyer_order_consumptions'), 0); const current = await f.read(); assert.equal(current.version, 2); assert.deepEqual(current.state, competing);
  await data(await f.consume(orderId, 2)); assert.equal(f.rows('buyer_order_consumptions'), 1); assert.equal((await f.read()).state.cart[0].quantity, 7);
});

test('concurrent consumption of one order applies once, while two orders cannot consume the same cart revision', async t => {
  const f = fixture(t); await data(await f.save(input())); const orderId = f.order();
  let results = await Promise.all([f.consume(orderId, 1), f.consume(orderId, 1)]);
  assert.deepEqual(results.map(response => response.status), [200, 200]); assert.equal((await f.read()).version, 2); assert.equal(f.rows('buyer_order_consumptions'), 1);
  const second = f.order(), third = f.order();
  results = await Promise.all([f.consume(second, 2), f.consume(third, 2)]);
  assert.deepEqual(results.map(response => response.status).sort(), [200, 409]); assert.equal((await f.read()).version, 3); assert.equal(f.rows('buyer_order_consumptions'), 2);
});

test('malformed order snapshots, foreign origins and unsupported methods cannot mutate buyer state', async t => {
  const f = fixture(t); await data(await f.save(input()));
  const invalidOrder = f.order(BUYER, [{ ...apple, quantity: 100 }]);
  await data(await f.consume(invalidOrder, 1), 409); assert.equal(f.rows('buyer_order_consumptions'), 0);
  await data(await f.call('', { method: 'PUT', origin: 'https://elsewhere.test', body: { expectedVersion: 1, state: empty() } }), 403);
  for (const method of ['POST', 'DELETE', 'PATCH']) await data(await f.call('', { method }), 405);
  await data(await f.call('/consume-order', { method: 'PUT', body: {} }), 405);
  await data(await f.call('/consume-order', { method: 'POST', body: { orderId: invalidOrder, expectedVersion: 1, buyerId: OTHER.id } }), 400);
  assert.deepEqual((await f.read()).state, input());
});
