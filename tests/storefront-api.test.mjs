import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readdir, readFile } from 'node:fs/promises';
import { handleApi } from '../server/cloud-api.js';
import { BASE_CATALOG, normalizeCatalogProduct } from '../public/model.js';

const directory = new URL('../drizzle/', import.meta.url);
const migrations = await Promise.all((await readdir(directory)).filter(name => name.endsWith('.sql')).sort().map(name => readFile(new URL(name, directory), 'utf8')));
const NOW = '2026-11-01T01:00:00.000Z';
const opaque = owner => `shop-${createHash('sha256').update(owner).digest('hex').slice(0, 24)}`;
class Statement {
  constructor(db, sql, values = []) { Object.assign(this, { db, sql, values }); }
  bind(...values) { return new Statement(this.db, this.sql, values); }
  async all() { this.db.queries.push(this.sql); return { results: this.db.sqlite.prepare(this.sql).all(...this.values) }; }
  async first() { this.db.queries.push(this.sql); return this.db.sqlite.prepare(this.sql).get(...this.values) || null; }
  async run() { this.db.queries.push(this.sql); return { meta: { changes: Number(this.db.sqlite.prepare(this.sql).run(...this.values).changes) } }; }
}
class D1 {
  constructor() { this.queries = []; this.sqlite = new DatabaseSync(':memory:'); this.sqlite.exec('PRAGMA foreign_keys=ON'); for (const sql of migrations) this.sqlite.exec(sql); }
  prepare(sql) { return new Statement(this, sql); }
  async batch() { throw new Error('The public directory must never write or bind an identity.'); }
}
function fixture(t) {
  const DB = new D1(); t.after(() => DB.sqlite.close());
  const user = (id, role = 'merchant') => DB.sqlite.prepare('INSERT INTO users(user_id,email,name,role,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id, `${id}@private.test`, `private-${id}-name`, role, NOW, NOW);
  user('owner-admin-secret', 'admin');
  const merchant = (id, { status = 'enabled', name = '景泰模拟采购店', region = '甘肃 · 景泰', bound = true } = {}) => {
    if (bound) user(id);
    DB.sqlite.prepare('INSERT INTO merchant_accounts(id,email,user_id,name,region,status,permissions_json,version,created_at,updated_at,created_by,updated_by) VALUES(?,?,?,?,?,?,?,1,?,?,?,?)').run(
      `MERCHANT-${id}`, `${id}@private.test`, bound ? id : null, name, region, status, '["products","orders","aftersales"]', NOW, NOW, 'owner-admin-secret', 'owner-admin-secret');
  };
  const product = (id, owner = 'owner-admin-secret', overrides = {}) => {
    const value = normalizeCatalogProduct({ ...BASE_CATALOG[0], id, ...overrides });
    DB.sqlite.prepare('INSERT INTO products(id,owner_id,product_json,status,version,created_at,updated_at,updated_by) VALUES(?,?,?,?,1,?,?,?)').run(id, owner, JSON.stringify(value), value.status, NOW, NOW, owner);
    return value;
  };
  const call = (method = 'GET', headers = {}) => handleApi(new Request('https://storefront.example.test/api/v1/storefront', { method, headers }), { DB });
  const read = async () => {
    const response = await call(); assert.equal(response.status, 200, await response.clone().text()); assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    return response.json();
  };
  return { DB, user, merchant, product, call, read };
}

test('public storefront groups all administrator products into one opaque shop and projects an exact privacy whitelist', async t => {
  const f = fixture(t);
  for (const product of BASE_CATALOG) f.product(product.id, undefined, product);
  f.DB.queries = [];
  const result = await f.read();
  assert.deepEqual(Object.keys(result).sort(), ['regions', 'shops', 'updatedAt']);
  const real = result.shops.filter(shop => !shop.preview);
  assert.equal(real.length, 1); assert.equal(real[0].id, opaque('owner-admin-secret'));
  assert.equal(real[0].name, '景泰好物示范店'); assert.equal(real[0].procurementName, '示范采购员');
  assert.deepEqual(real[0].productIds, BASE_CATALOG.map(product => product.id).sort());
  assert.deepEqual(result.regions.find(region => region.id === 'gansu-jingtai').shopIds, [real[0].id]);
  assert.equal(result.updatedAt, NOW);
  for (const shop of result.shops) assert.deepEqual(Object.keys(shop).sort(), ['id', 'name', 'regionIds', 'regionLabel', 'description', 'procurementName', 'image', 'preview', 'productIds', 'simulation'].sort());
  for (const region of result.regions) assert.deepEqual(Object.keys(region).sort(), ['id', 'name', 'province', 'subtitle', 'description', 'image', 'preview', 'productIds', 'shopIds'].sort());
  assert.doesNotMatch(JSON.stringify(result), /owner-admin-secret|private-|@private|permissions|owner_id|user_id|merchant_accounts|createdBy/);
  assert.equal(f.DB.queries.length, 1); assert.match(f.DB.queries[0], /^SELECT /); assert.doesNotMatch(f.DB.queries[0], /u\.email|u\.name|permissions_json/);
});

test('only published products of visible owners appear; empty, pending, disabled and private records stay out', async t => {
  const f = fixture(t);
  f.merchant('owner-live-secret'); f.merchant('owner-disabled-secret', { status: 'disabled' }); f.merchant('owner-empty-secret');
  f.merchant('pending-secret', { bound: false });
  f.product('public-apple', 'owner-live-secret'); f.product('draft-apple', 'owner-live-secret', { status: 'draft' });
  f.product('offline-apple', 'owner-live-secret', { status: 'offline' }); f.product('hidden-apple', 'owner-disabled-secret');
  let result = await f.read();
  assert.deepEqual(result.shops.filter(shop => !shop.preview).map(shop => shop.id), [opaque('owner-live-secret')]);
  assert.deepEqual(result.shops.find(shop => !shop.preview).productIds, ['public-apple']);
  assert.equal(result.shops.find(shop => !shop.preview).name, '景泰模拟采购店');
  assert.doesNotMatch(JSON.stringify(result), /owner-live-secret|owner-disabled-secret|owner-empty-secret|pending-secret|draft-apple|offline-apple|hidden-apple/);
  f.DB.sqlite.prepare("UPDATE merchant_accounts SET status='disabled' WHERE user_id=?").run('owner-live-secret');
  result = await f.read();
  assert.deepEqual(result.shops.filter(shop => !shop.preview), []);
  assert.deepEqual(result.regions.map(region => region.id), ['shaanxi-dingbian']);
  assert.equal(result.updatedAt, null);
});

test('Dingbian is an explicit non-buyable preview until actual published products exist', async t => {
  const f = fixture(t); f.product('apple');
  let result = await f.read(), preview = result.shops.find(shop => shop.preview);
  assert.equal(preview.id, 'shop-preview-dingbian'); assert.deepEqual(preview.productIds, []);
  assert.match(preview.description, /尚未接入采购者|不能购买/);
  assert.equal(result.regions.find(region => region.id === 'shaanxi-dingbian').preview, true);
  f.merchant('owner-dingbian-secret', { name: '定边模拟好物店', region: '陕西 · 定边' });
  f.product('dingbian-potato', 'owner-dingbian-secret', { origin: '陕西省定边县（模拟）', image: 'assets/potato.jpg' });
  result = await f.read();
  assert.equal(result.shops.some(shop => shop.preview), false);
  assert.equal(result.regions.find(region => region.id === 'shaanxi-dingbian').preview, false);
  assert.deepEqual(result.regions.find(region => region.id === 'shaanxi-dingbian').productIds, ['dingbian-potato']);
  assert.equal(result.shops.find(shop => shop.id === opaque('owner-dingbian-secret')).regionLabel, '陕西 · 定边');
});

test('server ownership, changed origins, shared regions and stable ordering stay consistent without changing records', async t => {
  const f = fixture(t); f.merchant('owner-two-secret');
  f.product('z-apple'); f.product('a-pear'); f.product('m-goji', 'owner-two-secret');
  const before = await f.read(), shop = before.shops.find(shop => shop.productIds.includes('z-apple'));
  const changed = normalizeCatalogProduct({ ...BASE_CATALOG[0], id: 'z-apple', origin: '未知 · 新产地 A（模拟）' });
  f.DB.sqlite.prepare('UPDATE products SET product_json=?,updated_at=? WHERE id=?').run(JSON.stringify(changed), '2026-11-02T00:00:00.000Z', changed.id);
  f.product('new-origin-product', 'owner-two-secret', { origin: '未知 · 新产地 B（模拟）' });
  const after = await f.read(), same = await f.read();
  assert.deepEqual(after, same); assert.equal(after.updatedAt, '2026-11-02T00:00:00.000Z');
  assert.equal(after.shops.find(candidate => candidate.id === shop.id).regionIds.length, 2);
  const unknown = after.regions.filter(region => region.id.startsWith('region-'));
  assert.equal(unknown.length, 2); assert.notEqual(unknown[0].id, unknown[1].id);
  assert.ok(unknown.some(region => region.name === changed.origin));
  assert.deepEqual(after.regions.find(region => region.id === 'gansu-jingtai').productIds, ['a-pear', 'm-goji']);
  assert.deepEqual(after.regions.find(region => region.id === 'gansu-jingtai').shopIds, [opaque('owner-admin-secret'), opaque('owner-two-secret')].sort());
  assert.equal(new Set(after.shops.map(shop => shop.id)).size, after.shops.length);
  assert.equal(new Set(after.regions.map(region => region.id)).size, after.regions.length);
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) n FROM products').get().n, 4);
});

test('public directory ignores caller identity and rejects every mutation before touching the database', async t => {
  const f = fixture(t); f.product('apple');
  const anonymous = await f.read();
  const response = await f.call('GET', { 'oai-authenticated-user-id': 'invalid\tidentity', 'oai-authenticated-user-email': 'invalid' });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), anonymous);
  f.DB.queries = [];
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD']) {
    const result = await f.call(method); assert.equal(result.status, 405); assert.equal(result.headers.get('Allow'), 'GET');
  }
  assert.deepEqual(f.DB.queries, []);
  const unavailable = await handleApi(new Request('https://storefront.example.test/api/v1/storefront'), {});
  assert.equal(unavailable.status, 503); assert.doesNotMatch(await unavailable.text(), /owner-|SELECT|merchant_accounts/);
});
