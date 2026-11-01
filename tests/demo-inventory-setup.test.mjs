import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import { handleApi } from '../server/cloud-api.js';
import { BASE_CATALOG } from '../public/model.js';

const migrationDirectory = new URL('../drizzle/', import.meta.url);
const migrations = await Promise.all((await readdir(migrationDirectory)).filter(name => name.endsWith('.sql')).sort()
  .map(name => readFile(new URL(name, migrationDirectory), 'utf8')));
const ORIGIN = 'https://demo-inventory.example.test';
const SETUP = '/maintenance/demo-inventory';
const TOKEN = 'a'.repeat(64);
const IDS = ['jingtai-apple', 'goji', 'pear', 'potato', 'corn', 'onion'];
const ADMIN = { id: 'setup-admin', email: 'setup-admin@example.test' };
const BUYER = { id: 'setup-buyer', email: 'setup-buyer@example.test' };
const ACTOR = 'system:demo-inventory-v1';

class Statement {
  constructor(adapter, sql, values = []) { Object.assign(this, { adapter, sql, values }); }
  bind(...values) { return new Statement(this.adapter, this.sql, values); }
  execute(mode) {
    assert.ok(this.values.length <= 100, 'D1 statement binding limit exceeded');
    if (this.adapter.failSQL?.(this.sql)) throw new Error('simulated private database failure');
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
    this.sqlite = new DatabaseSync(':memory:'); this.sqlite.exec('PRAGMA foreign_keys=ON;');
    for (const migration of migrations) this.sqlite.exec(migration);
  }
  prepare(sql) { return new Statement(this, sql); }
  async batch(statements) {
    this.beforeBatch?.(statements);
    this.sqlite.exec('BEGIN');
    try { const results = statements.map(statement => statement.execute('run')); this.sqlite.exec('COMMIT'); return results; }
    catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
}
async function data(response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  return response.json();
}
function fixture(t) {
  const DB = new D1(); t.after(() => DB.sqlite.close());
  const env = { DB, BOOTSTRAP_ADMIN_EMAIL: ADMIN.email, DEMO_INVENTORY_SETUP_TOKEN: TOKEN,
    DEMO_INVENTORY_SETUP_EXPIRES_AT: new Date(Date.now() + 60 * 60 * 1000).toISOString() };
  const call = (path, { method = 'GET', body, token, origin = ORIGIN, user = null, headers = {} } = {}) => {
    const requestHeaders = new Headers(headers);
    if (token !== undefined) requestHeaders.set('X-Demo-Setup-Token', token);
    if (origin !== null && method !== 'GET') requestHeaders.set('Origin', origin);
    if (user) { requestHeaders.set('oai-authenticated-user-id', user.id); requestHeaders.set('oai-authenticated-user-email', user.email); }
    if (body !== undefined) requestHeaders.set('Content-Type', 'application/json');
    return handleApi(new Request(`${ORIGIN}/api/v1${path}`, { method, headers: requestHeaders,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
  };
  const setup = (options = {}) => call(SETUP, { method: 'POST', body: {}, token: TOKEN, ...options });
  const catalog = async () => {
    await data(await call('/session', { user: ADMIN }));
    await data(await call('/admin/seed', { method: 'POST', body: {}, user: ADMIN }));
  };
  const rows = table => DB.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  const snapshot = () => Object.fromEntries(['users','products','product_inventory','inventory_events','orders','setup_operations'].map(table => [table, rows(table)]));
  const configure = async (id = 'jingtai-apple', stocks = { small: 0, family: 0 }) => data(await call(`/admin/inventory/${id}`, {
    method: 'PUT', user: ADMIN, body: { expectedVersion: 0, stocks, batchCode: 'EXISTING-MOCK', harvestDate: '', note: '已有模拟批次', reason: '模拟验收配置' }
  }));
  return { DB, env, call, setup, catalog, rows, snapshot, configure };
}

test('schema migrations create empty structures, with no inventory or setup backfill', t => {
  const f = fixture(t);
  assert.deepEqual(f.rows('setup_operations'), []);
  assert.deepEqual(f.rows('users'), []);
  assert.deepEqual(f.rows('product_inventory'), []);
  assert.deepEqual(f.rows('inventory_events'), []);
});

test('maintenance is disabled without a valid bounded secret and expiry, even for an administrator', async t => {
  const f = fixture(t); await f.catalog(); const before = f.snapshot();
  await data(await f.call(SETUP), 404);
  await data(await f.setup({ token: undefined, user: ADMIN }), 404);
  await data(await f.setup({ token: 'b'.repeat(64), user: ADMIN }), 403);
  await data(await f.setup({ token: TOKEN, method: 'GET', body: undefined }), 404);
  const expiry = f.env.DEMO_INVENTORY_SETUP_EXPIRES_AT;
  for (const value of [undefined, '', 'tomorrow', '2026-99-99T00:00:00.000Z', new Date(Date.now() - 1000).toISOString(), new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString()]) {
    f.env.DEMO_INVENTORY_SETUP_EXPIRES_AT = value; await data(await f.setup(), 404);
  }
  f.env.DEMO_INVENTORY_SETUP_EXPIRES_AT = expiry;
  for (const value of [undefined, '', 'weak', 'a'.repeat(63), 'g'.repeat(64)]) {
    f.env.DEMO_INVENTORY_SETUP_TOKEN = value; await data(await f.setup(), 404);
  }
  assert.deepEqual(f.snapshot(), before);
});

test('valid setup still requires the exact same origin and an empty JSON object', async t => {
  const f = fixture(t); await f.catalog(); const before = f.snapshot();
  for (const origin of [null, 'https://foreign.example.test']) await data(await f.setup({ origin }), 403);
  for (const body of [{ stocks: { small: 100 } }, { productIds: IDS }, [], null]) await data(await f.setup({ body }), 400);
  await data(await f.setup({ body: undefined }), 415);
  assert.deepEqual(f.snapshot(), before);
});

test('explicit setup configures only six mock products and audits every version-one batch atomically', async t => {
  const f = fixture(t); await f.catalog(); const beforeProducts = f.rows('products');
  assert.deepEqual(await data(await f.setup()), { seededIds: IDS, skippedIds: [], replayed: false });
  assert.deepEqual(f.rows('products'), beforeProducts);
  assert.deepEqual(f.rows('orders'), []);
  const inventory = f.rows('product_inventory'), events = f.rows('inventory_events');
  assert.equal(inventory.length, 6); assert.equal(events.length, 6);
  for (const row of inventory) {
    assert.deepEqual([row.small_stock, row.family_stock, row.version, row.harvest_date], [20, 12, 1, '']);
    assert.match(row.batch_id, /^BATCH-[A-F0-9-]{36}$/); assert.match(row.batch_code, /^DEMO-SETUP-V1-/);
    assert.match(row.note, /模拟库存/); assert.match(row.note, /不代表真实/); assert.equal(row.updated_by, ACTOR);
    const event = events.find(value => value.product_id === row.product_id);
    assert.equal(event.action, 'adjusted'); assert.equal(event.actor_id, ACTOR);
    assert.equal(event.before_json, null); assert.equal(event.order_id, null); assert.equal(event.created_at, row.updated_at);
    const after = JSON.parse(event.after_json);
    assert.equal(after.configured, true); assert.equal(after.version, 1); assert.equal(after.batchId, row.batch_id);
    assert.deepEqual(after.stocks, { small: 20, family: 12 });
  }
  const actor = f.rows('users').find(user => user.user_id === ACTOR);
  assert.equal(actor.role, 'buyer'); assert.match(actor.name, /系统/);
  assert.equal(f.rows('setup_operations').length, 1);
  const read = await data(await f.call('/inventory'));
  assert.equal(read.inventories.length, 6); assert.ok(read.inventories.every(row => row.configured && row.stocks.small === 20));
});

test('retries return the saved summary and never replenish consumed or zero stock', async t => {
  const f = fixture(t); await f.catalog(); await data(await f.setup());
  f.DB.sqlite.prepare("UPDATE product_inventory SET small_stock=0,family_stock=0,version=5 WHERE product_id='jingtai-apple'").run();
  const before = f.snapshot();
  assert.deepEqual(await data(await f.setup()), { seededIds: IDS, skippedIds: [], replayed: true });
  assert.deepEqual(f.snapshot(), before);
  delete f.env.DEMO_INVENTORY_SETUP_TOKEN;
  await data(await f.setup(), 404); assert.deepEqual(f.snapshot(), before);
});

test('simultaneous first requests produce one durable operation and one event per product', async t => {
  const f = fixture(t); await f.catalog();
  const results = await Promise.all([f.setup(), f.setup(), f.setup()].map(async response => data(await response)));
  assert.equal(results.filter(result => !result.replayed).length, 1);
  assert.equal(results.filter(result => result.replayed).length, 2);
  assert.ok(results.every(result => result.seededIds.length === 6));
  assert.equal(f.rows('product_inventory').length, 6); assert.equal(f.rows('inventory_events').length, 6);
  assert.equal(f.rows('setup_operations').length, 1);
});

test('configured zero stock and historical batches are skipped without modifying their records', async t => {
  const f = fixture(t); await f.catalog(); await f.configure(); await f.configure('goji', { small: 3, family: 4 });
  f.DB.sqlite.prepare("DELETE FROM product_inventory WHERE product_id='goji'").run();
  const before = f.rows('product_inventory'), beforeEvents = f.rows('inventory_events');
  assert.deepEqual(await data(await f.setup()), { seededIds: IDS.slice(2), skippedIds: IDS.slice(0, 2), replayed: false });
  assert.deepEqual(f.rows('product_inventory').find(row => row.product_id === 'jingtai-apple'), before[0]);
  assert.equal(f.rows('product_inventory').some(row => row.product_id === 'goji'), false);
  assert.deepEqual(f.rows('inventory_events').slice(0, 2), beforeEvents);
});

test('nonmock, unpublished, other-owner, changed-variant and nonwhitelisted products remain unavailable', async t => {
  const f = fixture(t); await f.catalog();
  await data(await f.call('/session', { user: { id: 'other-admin', email: 'other@example.test' } }));
  f.DB.sqlite.prepare("UPDATE users SET role='admin' WHERE user_id='other-admin'").run();
  f.DB.sqlite.prepare("UPDATE products SET product_json=json_set(product_json,'$.origin','真实货源') WHERE id='jingtai-apple'").run();
  f.DB.sqlite.prepare("UPDATE products SET product_json=json_set(product_json,'$.summary','真实产品介绍') WHERE id='goji'").run();
  f.DB.sqlite.prepare("UPDATE products SET owner_id='other-admin' WHERE id='pear'").run();
  f.DB.sqlite.prepare("UPDATE products SET status='offline' WHERE id='potato'").run();
  f.DB.sqlite.prepare("UPDATE products SET product_json=json_set(product_json,'$.variants[1].id','large') WHERE id='corn'").run();
  await f.configure('onion');
  await data(await f.call('/admin/products/extra-demo', { method: 'PUT', user: ADMIN,
    body: { product: { ...BASE_CATALOG[0], id: 'extra-demo' }, expectedVersion: 0 } }));
  const before = f.snapshot();
  const result = await data(await f.setup(), 409); assert.equal(result.error.code, 'setup_no_eligible_products');
  assert.deepEqual(f.snapshot(), before);
});

test('empty catalog and disabled or demoted bootstrap owners cannot consume the setup operation', async t => {
  const f = fixture(t);
  await data(await f.setup(), 409); assert.deepEqual(f.snapshot(), { users: [], products: [], product_inventory: [], inventory_events: [], orders: [], setup_operations: [] });
  await f.catalog();
  f.DB.sqlite.prepare("UPDATE users SET role='buyer' WHERE user_id=?").run(ADMIN.id);
  const demoted = f.snapshot(); await data(await f.setup(), 409); assert.deepEqual(f.snapshot(), demoted);
  f.DB.sqlite.prepare("UPDATE users SET role='admin' WHERE user_id=?").run(ADMIN.id);
  f.DB.sqlite.prepare(`INSERT INTO merchant_accounts(id,email,user_id,name,region,status,permissions_json,version,created_at,updated_at,created_by,updated_by)
    VALUES('disabled-owner',?,?,'模拟采购者','模拟地区','disabled','[]',1,'2026-01-01','2026-01-01',?,?)`).run(ADMIN.email, ADMIN.id, ADMIN.id, ADMIN.id);
  const disabled = f.snapshot(); await data(await f.setup(), 409); assert.deepEqual(f.snapshot(), disabled);
});

test('stock and audit insertion failures roll back system actor, claim, every batch and event', async t => {
  const f = fixture(t); await f.catalog(); const before = f.snapshot();
  for (const fail of [sql => sql.startsWith('INSERT INTO inventory_events'), sql => sql.startsWith('WITH requested')]) {
    f.DB.failSQL = fail; await data(await f.setup(), 503); assert.deepEqual(f.snapshot(), before);
  }
  f.DB.failSQL = null; await data(await f.setup()); assert.equal(f.rows('product_inventory').length, 6);
});

test('eligibility is rechecked in the transaction after an earlier read', async t => {
  const f = fixture(t); await f.catalog();
  f.DB.beforeBatch = () => {
    f.DB.beforeBatch = null;
    f.DB.sqlite.prepare("UPDATE products SET status='offline' WHERE id='jingtai-apple'").run();
  };
  assert.deepEqual(await data(await f.setup()), { seededIds: IDS.slice(1), skippedIds: ['jingtai-apple'], replayed: false });
  assert.equal(f.rows('product_inventory').some(row => row.product_id === 'jingtai-apple'), false);
});

test('reserved system namespace cannot authenticate or bootstrap administration', async t => {
  const f = fixture(t); await f.catalog(); await data(await f.setup()); const before = f.snapshot();
  for (const id of [ACTOR, 'system:other']) {
    const response = await data(await f.call('/session', { user: { id, email: ADMIN.email } }), 401);
    assert.equal(response.error.code, 'identity_invalid');
  }
  assert.deepEqual(f.snapshot(), before);
});

test('configured inventory supports quote, reserve, ship, receive and aftersale without payments', async t => {
  const f = fixture(t); await f.catalog(); await data(await f.setup());
  const items = [{ productId: 'jingtai-apple', variant: 'small', quantity: 2 }, { productId: 'goji', variant: 'family', quantity: 1 }];
  const { quote } = await data(await f.call('/orders/quote', { method: 'POST', user: BUYER, body: { items, address: 'gansu' } }));
  const request = { items, address: 'gansu', expectedTotal: quote.total, productVersions: quote.productVersions,
    inventoryVersions: quote.inventoryVersions, idempotencyKey: crypto.randomUUID() };
  let { order } = await data(await f.call('/orders', { method: 'POST', user: BUYER, body: request }), 201);
  assert.equal(f.rows('product_inventory').find(row => row.product_id === 'jingtai-apple').small_stock, 18);
  assert.equal(f.rows('product_inventory').find(row => row.product_id === 'goji').family_stock, 11);
  await data(await f.call('/orders', { method: 'POST', user: BUYER, body: request }));
  const reserved = f.rows('product_inventory');
  ({ order } = await data(await f.call(`/admin/orders/${order.id}/ship`, { method: 'POST', user: ADMIN,
    body: { expectedVersion: order.version, carrier: '模拟快递', tracking: 'DEMO-SETUP-FLOW' } })));
  ({ order } = await data(await f.call(`/orders/${order.id}/receive`, { method: 'POST', user: BUYER, body: { expectedVersion: order.version } })));
  assert.equal(order.receipt.status, 'received');
  ({ order } = await data(await f.call(`/orders/${order.id}/aftersale`, { method: 'POST', user: BUYER,
    body: { expectedVersion: order.version, type: 'refund', reason: 'damaged', description: '模拟流程测试，无真实退款', hasEvidence: false } })));
  ({ order } = await data(await f.call(`/admin/orders/${order.id}/aftersale/resolve`, { method: 'POST', user: ADMIN,
    body: { expectedVersion: order.version, reply: '模拟售后已处理，不发生真实退款。' } })));
  assert.equal(order.afterSale.status, 'resolved');
  assert.deepEqual(f.rows('product_inventory'), reserved);
  assert.deepEqual(await data(await f.setup()), { seededIds: IDS, skippedIds: [], replayed: true });
  assert.deepEqual(f.rows('product_inventory'), reserved);
});
