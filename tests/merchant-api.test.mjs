import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdir, readFile } from 'node:fs/promises';
import { handleApi } from '../server/cloud-api.js';
import { BASE_CATALOG, normalizeCatalogProduct } from '../public/model.js';

const directory = new URL('../drizzle/', import.meta.url);
const migrations = await Promise.all((await readdir(directory)).filter(name => name.endsWith('.sql')).sort().map(name => readFile(new URL(name, directory), 'utf8')));
class Statement {
  constructor(db, sql, values = []) { Object.assign(this, { db, sql, values }); }
  bind(...values) { return new Statement(this.db, this.sql, values); }
  execute(mode) {
    this.db.beforeSQL?.(this.sql);
    if (this.db.failSQL?.(this.sql)) throw new Error('private storage details');
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
    try { const results = statements.map(statement => statement.execute('run')); this.sqlite.exec('COMMIT'); return results; }
    catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
}
class R2 {
  objects = new Map();
  async put(key, bytes) { this.objects.set(key, bytes); }
  async head(key) { const bytes = this.objects.get(key); return bytes ? { size: bytes.length } : null; }
  async get(key) { const bytes = this.objects.get(key); return bytes ? { body: new Response(bytes).body } : null; }
  async delete(key) { this.objects.delete(key); }
}
const ADMIN = { id: 'admin', email: 'admin@example.test' };
const SELLER = { id: 'jingtai-seller', email: 'jingtai@example.test' };
const OTHER = { id: 'dingbian-seller', email: 'dingbian@example.test' };
const BUYER = { id: 'buyer', email: 'buyer@example.test' };
const ORIGIN = 'https://merchants.example.test';
const PERMISSIONS = ['products', 'orders', 'aftersales'];
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=', 'base64'));
async function data(response, expected = 200) {
  assert.equal(response.status, expected, await response.clone().text());
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  return response.json();
}
function fixture(t) {
  const DB = new D1(), BUCKET = new R2(); t.after(() => DB.sqlite.close());
  const env = { DB, BUCKET, BOOTSTRAP_ADMIN_EMAIL: ADMIN.email };
  const call = (path, { method = 'GET', user = ADMIN, body, origin = ORIGIN, headers = {} } = {}) => {
    headers = new Headers(headers);
    if (user) { headers.set('oai-authenticated-user-id', user.id); headers.set('oai-authenticated-user-email', user.email); }
    if (!['GET', 'HEAD'].includes(method) && origin !== null) headers.set('Origin', origin);
    if (body !== undefined && !(body instanceof Uint8Array)) { headers.set('Content-Type', headers.get('Content-Type') || 'application/json'); if (typeof body !== 'string') body = JSON.stringify(body); }
    return handleApi(new Request(ORIGIN + '/api/v1' + path, { method, headers, body }), env);
  };
  const session = async user => data(await call('/session', { user }));
  const input = (user = SELLER, overrides = {}) => ({ name: '模拟景泰采购者', email: user.email, region: '甘肃·景泰', status: 'enabled', permissions: [...PERMISSIONS], ...overrides });
  const add = async (user = SELLER, overrides = {}) => (await data(await call('/admin/merchants', { method: 'POST', body: input(user, overrides) }), 201)).merchant;
  const get = async id => (await data(await call('/admin/merchants/' + id))).merchant;
  const edit = async (profile, overrides = {}) => (await data(await call('/admin/merchants/' + profile.id, { method: 'PUT', body: { ...input({ email: profile.email }, profile), ...overrides, id: undefined, bound: undefined, version: undefined, createdAt: undefined, updatedAt: undefined, expectedVersion: profile.version } }))).merchant;
  const bind = async (user = SELLER, overrides = {}) => { const profile = await add(user, overrides); await session(user); return get(profile.id); };
  const product = (id = 'demo-apples', overrides = {}) => ({ ...normalizeCatalogProduct(BASE_CATALOG[0]), id, status: 'published', ...overrides });
  const save = async (user = SELLER, value = product(), expectedVersion = 0) => {
    const response = await call('/admin/products/' + value.id, { method: 'PUT', user, body: { product: value, expectedVersion } });
    if (response.status === 200) DB.sqlite.prepare(`INSERT OR IGNORE INTO product_inventory(product_id,small_stock,family_stock,batch_id,batch_code,harvest_date,note,version,updated_at,updated_by) VALUES(?,100,100,?,'TEST-BATCH','2026-10-31','模拟测试库存',1,?,?)`).run(value.id,`BATCH-${crypto.randomUUID().toUpperCase()}`,new Date().toISOString(),user.id);
    return response;
  };
  const upload = (user = SELLER) => call('/media?kind=image', { method: 'POST', user, body: PNG, headers: { 'Content-Type': 'image/png', 'X-File-Name': 'test.png', 'X-Media-Source': 'Own%20test%20image' } });
  const selection = { items: [{ productId: 'demo-apples', variant: 'small', quantity: 1 }], address: 'gansu' };
  const quote = async () => (await data(await call('/orders/quote', { method: 'POST', user: BUYER, body: selection }))).quote;
  const payload = async () => { const q = await quote(); return { ...selection, expectedTotal: q.total, productVersions: q.productVersions, inventoryVersions: q.inventoryVersions, idempotencyKey: crypto.randomUUID() }; };
  const create = body => call('/orders', { method: 'POST', user: BUYER, body });
  const action = (order, name, body = {}, user = SELLER) => call(`/admin/orders/${order.id}/${name}`, { method: 'POST', user, body: { expectedVersion: order.version, ...body } });
  return { DB, BUCKET, call, session, input, add, get, edit, bind, product, save, upload, selection, quote, payload, create, action };
}

test('only administrators create merchant profiles; edits are versioned and audit the before/after atomically', async t => {
  const f = fixture(t); await f.session(ADMIN);
  await data(await f.call('/admin/merchants', { user: null }), 401);
  await data(await f.call('/admin/merchants', { user: BUYER }), 403);
  assert.deepEqual((await data(await f.call('/admin/merchants'))).merchants, []);
  assert.equal((await data(await f.call('/products'))).products.length, 0);
  let profile = await f.add(SELLER, { email: '  JINGTAI@example.test  ', permissions: ['orders', 'products'] });
  assert.equal(profile.email, SELLER.email); assert.deepEqual(profile.permissions, ['products', 'orders']);
  assert.equal(profile.bound, false); assert.equal(profile.version, 1); assert.match(profile.id, /^MERCHANT-[A-F0-9-]{36}$/);
  profile = await f.edit(profile, { name: '模拟定边采购者', region: '陕西·定边', permissions: ['aftersales'] });
  assert.equal(profile.version, 2); assert.equal(profile.region, '陕西·定边');
  const events = (await data(await f.call(`/admin/merchants/${profile.id}/audit`))).events;
  assert.deepEqual(events.map(event => event.action), ['updated', 'created']);
  assert.equal(events[0].before.region, '甘肃·景泰'); assert.equal(events[0].after.region, '陕西·定边');
  assert.equal(events[0].actorName, 'admin'); assert.equal(events[1].before, null);
  assert.equal(events[0].after.userId, undefined);
  await data(await f.call('/admin/merchants/' + profile.id, { method: 'PUT', body: { ...f.input(), expectedVersion: 1 } }), 409);
  await data(await f.call('/admin/merchants', { method: 'POST', body: f.input(SELLER) }), 409);
  await data(await f.call('/admin/merchants', { method: 'POST', body: f.input(ADMIN) }), 409);
  await f.session(SELLER); await data(await f.call('/admin/merchants', { user: SELLER }), 403);
});

test('trusted email claims exactly one stable account; later email changes, reused emails and role revocation fail closed', async t => {
  const f = fixture(t); const profile = await f.add();
  const session = await f.session(SELLER);
  assert.equal(session.role, 'merchant'); assert.equal(session.canManage, true); assert.equal(session.merchant.id, profile.id);
  assert.deepEqual(session.permissions, PERMISSIONS); assert.equal(session.merchant.bound, true);
  const changed = { ...SELLER, email: 'new-address@example.test' };
  assert.equal((await f.session(changed)).merchant.id, profile.id);
  assert.equal((await f.session({ id: 'email-reuse', email: SELLER.email })).canManage, false);
  await f.add(changed);
  assert.equal((await f.session(changed)).merchant.id, profile.id, 'one stable ID cannot claim a second profile');
  const current = await f.get(profile.id);
  await data(await f.call('/admin/merchants/' + profile.id, { method: 'PUT', body: { ...f.input(), email: changed.email, expectedVersion: current.version } }), 409);
  f.DB.sqlite.prepare("UPDATE users SET role='buyer' WHERE user_id=?").run(SELLER.id);
  const revoked = await f.session(SELLER);
  assert.equal(revoked.role, 'buyer'); assert.equal(revoked.canManage, false); assert.deepEqual(revoked.permissions, []);
  assert.equal((await data(await f.call(`/admin/merchants/${profile.id}/audit`))).events.filter(event => event.action === 'bound').length, 1);
  await f.session(OTHER); f.DB.sqlite.prepare("UPDATE users SET role='merchant' WHERE user_id=?").run(OTHER.id);
  assert.equal((await f.session(OTHER)).canManage, false, 'legacy merchant role without profile has no privileges');
  await data(await f.save(OTHER), 403);
});

test('concurrent trusted identities cannot steal an email claim or duplicate the binding audit', async t => {
  const f = fixture(t); const profile = await f.add();
  const sessions = await Promise.all([f.session(SELLER), f.session({ id: 'competitor', email: SELLER.email }), f.session(SELLER)]);
  const bound = f.DB.sqlite.prepare('SELECT user_id,version FROM merchant_accounts WHERE id=?').get(profile.id);
  assert.equal(bound.version, 2); assert.ok([SELLER.id, 'competitor'].includes(bound.user_id));
  const otherId = bound.user_id === SELLER.id ? 'competitor' : SELLER.id;
  assert.equal((await f.session({ id: otherId, email: SELLER.email })).canManage, false);
  assert.ok(sessions.some(session => session.canManage));
  assert.equal(f.DB.sqlite.prepare("SELECT count(*) n FROM merchant_audit WHERE action='bound'").get().n, 1);
});

test('disabled pending profiles still bind identity, block management, and resume only the same owner when enabled', async t => {
  const f = fixture(t); let profile = await f.add(SELLER, { status: 'disabled' });
  let session = await f.session(SELLER);
  assert.equal(session.role, 'merchant'); assert.equal(session.merchant.bound, true); assert.deepEqual(session.permissions, []);
  await data(await f.save(), 403);
  profile = await f.edit(await f.get(profile.id), { status: 'enabled' });
  session = await f.session(SELLER); assert.equal(session.canManage, true);
  profile = await f.edit(profile, { permissions: [] });
  assert.equal((await f.session(SELLER)).canManage, false);
  await data(await f.call('/admin/orders', { user: SELLER }), 403);
});

test('product/order/aftersale permissions are independent and procurement agents see only their own data', async t => {
  const f = fixture(t); let profile = await f.bind(SELLER, { permissions: ['products'] }); await f.bind(OTHER);
  await data(await f.save()); await data(await f.save(OTHER, f.product('dingbian-apples')));
  assert.deepEqual((await data(await f.call('/admin/products', { user: SELLER }))).products.map(product => product.id), ['demo-apples']);
  await data(await f.save(OTHER, f.product(), 1), 403);
  await data(await f.call('/admin/orders', { user: SELLER }), 403);
  const first = (await data(await f.create(await f.payload()), 201)).order;
  const second = (await data(await f.create(await f.payload()), 201)).order;
  await data(await f.call('/admin/orders/' + first.id, { user: OTHER }), 404);
  profile = await f.edit(profile, { permissions: ['orders'] });
  await data(await f.call('/admin/products', { user: SELLER }), 403); await data(await f.upload(), 403);
  assert.equal((await data(await f.call('/admin/orders', { user: SELLER }))).orders.length, 2);
  await data(await f.action(first, 'note', { note: '模拟采购备注' }));
  const requested = (await data(await f.call(`/orders/${second.id}/aftersale`, { method: 'POST', user: BUYER, body: { expectedVersion: 1, type: 'refund', reason: 'damaged', description: '测试模拟', hasEvidence: false } }))).order;
  await data(await f.action(requested, 'aftersale/resolve', { reply: '模拟处理' }), 403);
  profile = await f.edit(profile, { permissions: ['aftersales'] });
  assert.deepEqual((await data(await f.call('/admin/orders', { user: SELLER }))).orders.map(order => order.id), [second.id]);
  await data(await f.call('/admin/orders/' + first.id, { user: SELLER }), 404);
  await data(await f.action(requested, 'ship', { carrier: '模拟快递', tracking: 'MOCK-001' }), 403);
  await data(await f.action(requested, 'note', { note: '无订单权限' }), 403);
  await data(await f.action(requested, 'aftersale/resolve', { reply: '仅模拟处理，实际退款0元' }));
  await data(await f.call('/admin/merchants/' + profile.id, { user: SELLER }), 403);
});

test('disabling hides public products/media and blocks new purchases atomically; existing orders remain for admin takeover', async t => {
  const f = fixture(t); let profile = await f.bind();
  const media = await data(await f.upload(), 201); await data(await f.save(SELLER, f.product('demo-apples', { imageMediaId: media.id })));
  const input = await f.payload(), order = (await data(await f.create(input), 201)).order;
  const pending = await f.payload();
  profile = await f.edit(profile, { status: 'disabled' });
  assert.deepEqual((await data(await f.call('/products', { user: null }))).products, []);
  await data(await f.call('/media/' + media.id, { user: null }), 404); await data(await f.call('/media/' + media.id, { user: SELLER }), 404);
  await data(await f.call('/orders/quote', { method: 'POST', user: BUYER, body: f.selection }), 409);
  await data(await f.create(pending), 409);
  assert.equal((await data(await f.create(input))).replayed, true, 'old idempotent replay survives disabling');
  await data(await f.call('/admin/orders/' + order.id, { user: SELLER }), 403);
  await data(await f.action(order, 'ship', { carrier: '模拟物流', tracking: 'DEMO-MOCK-001' }, ADMIN));
  profile = await f.edit(profile, { status: 'enabled' });
  assert.equal((await data(await f.call('/products'))).products.length, 1);
  const fresh = await f.payload();
  f.DB.beforeSQL = sql => {
    if (!sql.startsWith('INSERT INTO orders')) return;
    f.DB.beforeSQL = null; f.DB.sqlite.prepare("UPDATE merchant_accounts SET status='disabled' WHERE id=?").run(profile.id);
  };
  await data(await f.create(fresh), 409);
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) n FROM orders').get().n, 1);
});

test('database audit failure rolls back merchant create, update and first binding without partial success', async t => {
  const f = fixture(t); await f.session(ADMIN);
  f.DB.failSQL = sql => sql.startsWith('INSERT INTO merchant_audit');
  const failed = await data(await f.call('/admin/merchants', { method: 'POST', body: f.input() }), 503);
  assert.equal(JSON.stringify(failed).includes('private storage'), false);
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) n FROM merchant_accounts').get().n, 0);
  f.DB.failSQL = null; const profile = await f.add();
  f.DB.failSQL = sql => sql.startsWith('INSERT INTO merchant_audit');
  await data(await f.call('/admin/merchants/' + profile.id, { method: 'PUT', body: { ...f.input(), name: '不应保存', expectedVersion: 1 } }), 503);
  assert.equal((await f.get(profile.id)).name, profile.name); assert.equal((await f.get(profile.id)).version, 1);
  await data(await f.call('/session', { user: SELLER }), 503);
  assert.equal(f.DB.sqlite.prepare('SELECT role FROM users WHERE user_id=?').get(SELLER.id).role, 'buyer');
  assert.equal((await f.get(profile.id)).bound, false);
  f.DB.failSQL = null; assert.equal((await f.session(SELLER)).canManage, true);
});

test('final SQL guards reject revoked permissions during product, media and order mutations', async t => {
  const f = fixture(t); const profile = await f.bind();
  await data(await f.save()); const order = (await data(await f.create(await f.payload()), 201)).order;
  const revokeOn = prefix => {
    f.DB.beforeSQL = sql => {
      if (!sql.startsWith(prefix)) return;
      f.DB.beforeSQL = null; f.DB.sqlite.prepare("UPDATE merchant_accounts SET permissions_json='[]' WHERE id=?").run(profile.id);
    };
  };
  revokeOn('UPDATE products'); await data(await f.save(SELLER, f.product('demo-apples', { name: '不应更新' }), 1), 409);
  assert.notEqual(JSON.parse(f.DB.sqlite.prepare('SELECT product_json FROM products').get().product_json).name, '不应更新');
  const restore = () => f.DB.sqlite.prepare('UPDATE merchant_accounts SET permissions_json=? WHERE id=?').run(JSON.stringify(PERMISSIONS), profile.id);
  restore(); revokeOn('INSERT INTO products'); await data(await f.save(SELLER, f.product('not-created')), 422);
  assert.equal(f.DB.sqlite.prepare("SELECT id FROM products WHERE id='not-created'").get(), undefined);
  restore(); revokeOn('INSERT INTO media'); await data(await f.upload(), 403); assert.equal(f.BUCKET.objects.size, 0);
  restore(); revokeOn('UPDATE orders'); await data(await f.action(order, 'note', { note: '不应更新' }), 409);
  assert.equal(f.DB.sqlite.prepare('SELECT version FROM orders WHERE id=?').get(order.id).version, 1);
});

test('merchant updates serialize concurrent edits and duplicate-email races without losing audit history', async t => {
  const f = fixture(t); const a = await f.add(), b = await f.add(OTHER);
  const responses = await Promise.all(['甲', '乙'].map(name => f.call('/admin/merchants/' + a.id, { method: 'PUT', body: { ...f.input(), name, expectedVersion: 1 } })));
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  const current = await f.get(a.id);
  await data(await f.call('/admin/merchants/' + b.id, { method: 'PUT', body: { ...f.input(OTHER), email: SELLER.email, expectedVersion: b.version } }), 409);
  assert.equal(current.version, 2);
  assert.equal((await data(await f.call(`/admin/merchants/${a.id}/audit`))).events.length, 2);
  assert.equal((await f.get(b.id)).email, OTHER.email);
});

test('merchant administration validates fields, blocks forged ownership/roles and requires bounded same-origin JSON', async t => {
  const f = fixture(t);
  for (const override of [{ role: 'admin' }, { userId: 'pretend' }, { permissions: ['admin'] }, { permissions: ['orders', 'orders'] }, { permissions: 'products' }, { status: 'pending' }, { region: '' }, { name: 'x'.repeat(81) }, { email: 'bad-email' }]) {
    await data(await f.call('/admin/merchants', { method: 'POST', body: f.input(SELLER, override) }), 400);
  }
  await data(await f.call('/admin/merchants', { method: 'POST', body: f.input(), origin: null }), 403);
  await data(await f.call('/admin/merchants', { method: 'POST', body: f.input(), origin: 'https://evil.example.test' }), 403);
  await data(await f.call('/admin/merchants', { method: 'POST', body: f.input(), headers: { 'Content-Type': 'text/plain' } }), 415);
  await data(await f.call('/admin/merchants', { method: 'POST', body: { ...f.input(), name: 'x'.repeat(100000) } }), 413);
  await data(await f.call('/admin/merchants/not-an-id'), 404);
  await data(await f.call('/admin/merchants', { method: 'DELETE' }), 405);
});
