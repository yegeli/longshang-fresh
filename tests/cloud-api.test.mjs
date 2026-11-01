import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdir, readFile } from 'node:fs/promises';
import { handleApi } from '../server/cloud-api.js';
import { BASE_CATALOG, normalizeCatalogProduct } from '../public/model.js';

// Apply the real generated migrations, never a test-only copy of the schema.
const migrationDirectory = new URL('../drizzle/', import.meta.url);
const migrationFiles = (await readdir(migrationDirectory)).filter(name => name.endsWith('.sql')).sort();
assert.ok(migrationFiles.length, 'Generate the actual Drizzle migration before running cloud tests.');
const migrations = await Promise.all(migrationFiles.map(name => readFile(new URL(name, migrationDirectory), 'utf8')));

class D1Statement {
  constructor(adapter, sql, values = []) { Object.assign(this, { adapter, sql, values }); }
  bind(...values) { return new D1Statement(this.adapter, this.sql, values); }
  execute(mode) {
    if (this.adapter.failSQL?.(this.sql)) throw new Error('private database failure: SQL must not escape');
    const statement = this.adapter.sqlite.prepare(this.sql);
    if (mode === 'first') return statement.get(...this.values) || null;
    if (mode === 'all') return { success: true, results: statement.all(...this.values) };
    const result = statement.run(...this.values);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
  async first(column) { const row = this.execute('first'); return column ? row?.[column] ?? null : row; }
  async all() { return this.execute('all'); }
  async run() { return this.execute('run'); }
}
class D1Adapter {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec('PRAGMA foreign_keys=ON;');
    for (const migration of migrations) this.sqlite.exec(migration);
  }
  prepare(sql) { return new D1Statement(this, sql); }
  async batch(statements) {
    this.sqlite.exec('BEGIN');
    try {
      const result = statements.map(statement => statement.execute('run'));
      this.sqlite.exec('COMMIT');
      return result;
    } catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
}
class R2Adapter {
  objects = new Map();
  puts = 0;
  deletes = 0;
  async put(key, bytes) {
    this.puts++;
    if (this.failPut) throw new Error('private R2 failure');
    this.objects.set(key, new Uint8Array(bytes));
    return this.head(key);
  }
  async head(key) { const bytes = this.objects.get(key); return bytes ? { size: bytes.byteLength, httpEtag: '"owned-fixture"' } : null; }
  async get(key, options) {
    let bytes = this.objects.get(key);
    if (!bytes) return null;
    if (options?.range) bytes = bytes.slice(options.range.offset, options.range.offset + options.range.length);
    return { ...await this.head(key), body: new Response(bytes).body };
  }
  async delete(key) { this.deletes++; if (this.failDelete) throw new Error('private cleanup failure'); this.objects.delete(key); }
}

const ADMIN = { id: 'stable-admin', email: 'owner@example.test' };
const MERCHANT = { id: 'merchant-one', email: 'one@example.test' };
const OTHER = { id: 'merchant-two', email: 'two@example.test' };
const BUYER = { id: 'customer-one', email: 'customer@example.test' };
const ORIGIN = 'https://shop.example.test';
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=', 'base64'));
// Owned container-signature fixture, not a redistributable or playable video.
const VIDEO = new Uint8Array(4096).map((_, index) => index % 251);
VIDEO.set([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]);

function fixture(t, options = {}) {
  const DB = new D1Adapter(), BUCKET = new R2Adapter();
  t.after(() => DB.sqlite.close());
  const env = { DB, BUCKET, BOOTSTRAP_ADMIN_EMAIL: ADMIN.email, ...options };
  const call = (path, { method = 'GET', user = null, body, headers = {}, origin = ORIGIN } = {}) => {
    const requestHeaders = new Headers(headers);
    if (user) {
      requestHeaders.set('oai-authenticated-user-id', user.id);
      requestHeaders.set('oai-authenticated-user-email', user.email);
    }
    if (!['GET', 'HEAD'].includes(method) && origin !== null) requestHeaders.set('Origin', origin);
    if (body !== undefined && !(body instanceof Uint8Array) && !(body instanceof ReadableStream) && typeof body !== 'string') {
      body = JSON.stringify(body);
      if (!requestHeaders.has('Content-Type')) requestHeaders.set('Content-Type', 'application/json');
    }
    return handleApi(new Request(`${ORIGIN}/api/v1${path}`, { method, headers: requestHeaders, body, ...(body instanceof ReadableStream ? { duplex: 'half' } : {}) }), env);
  };
  const session = async user => (await call('/session', { user })).json();
  const grant = async user => {
    await session(user);
    DB.sqlite.prepare("UPDATE users SET role='merchant' WHERE user_id=?").run(user.id);
    DB.sqlite.prepare(`INSERT INTO merchant_accounts(id,email,user_id,name,region,status,permissions_json,version,created_at,updated_at,created_by,updated_by)
      VALUES(?,?,?,?,?,'enabled',?,1,?,?,?,?)`).run(`MERCHANT-${crypto.randomUUID().toUpperCase()}`, user.email, user.id, user.id, '模拟产地', JSON.stringify(['products', 'orders', 'aftersales']), new Date().toISOString(), new Date().toISOString(), user.id, user.id);
  };
  const product = (id = 'own-product', overrides = {}) => JSON.parse(JSON.stringify({ ...normalizeCatalogProduct(BASE_CATALOG[0]), id, status: 'draft', ...overrides }));
  const save = (user, value, expectedVersion = 0, options = {}) => call(`/admin/products/${value.id}`, { method: 'PUT', user, body: { product: value, expectedVersion }, ...options });
  const upload = (user, kind = 'image', bytes = PNG, options = {}) => call(`/media?kind=${kind}`, {
    method: 'POST', user, body: bytes,
    headers: { 'Content-Type': kind === 'image' ? 'image/png' : 'video/mp4', 'X-File-Name': encodeURIComponent(kind === 'image' ? '自有图片.png' : '自有视频.mp4'), 'X-Media-Source': encodeURIComponent('测试自有素材，仅供接口验收。'), ...options.headers }, ...Object.fromEntries(Object.entries(options).filter(([key]) => key !== 'headers'))
  });
  return { DB, BUCKET, env, call, session, grant, product, save, upload };
}

async function status(response, expected) {
  assert.equal(response.status, expected, await response.clone().text());
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  return response;
}

test('hosted sessions fail closed; bootstrap binds once to a stable identity and honors durable role changes', async t => {
  const f = fixture(t);
  const anonymous = await f.session(null);
  assert.equal(anonymous.user, null);
  assert.equal(anonymous.role, 'anonymous');
  assert.equal(anonymous.canManage, false);
  assert.equal(anonymous.signInUrl, '/signin-with-chatgpt?return_to=%2Fadmin.html');
  assert.equal(anonymous.signOutUrl, '/signout-with-chatgpt?return_to=%2Fadmin.html');
  await status(await f.call('/admin/products'), 401);
  await status(await f.call('/admin/products', { headers: { 'oai-authenticated-user-id': ADMIN.id } }), 401);
  assert.equal((await f.session(BUYER)).role, 'buyer');
  const admin = await f.session(ADMIN);
  assert.equal(admin.role, 'admin');
  assert.equal(admin.canManage, true);
  assert.equal((await f.call('/products').then(response => response.json())).products.length, 0, 'login must not silently seed data');
  assert.equal((await f.session({ id: 'same-email-different-person', email: ADMIN.email })).role, 'buyer');
  assert.equal((await f.session({ ...ADMIN, email: 'changed@example.test' })).role, 'admin', 'stable ID retains role after email changes');
  f.DB.sqlite.prepare("UPDATE users SET role='buyer' WHERE user_id=?").run(ADMIN.id);
  assert.equal((await f.session(ADMIN)).role, 'buyer', 'bootstrap does not undo an explicit administrator revocation');
  await status(await f.call('/admin/products', { user: ADMIN }), 403);

  const noBootstrap = fixture(t, { BOOTSTRAP_ADMIN_EMAIL: '' });
  assert.equal((await noBootstrap.session(ADMIN)).role, 'buyer');
  assert.equal(noBootstrap.DB.sqlite.prepare('SELECT count(*) AS n FROM admin_bootstrap').get().n, 0);
  const parallel = fixture(t);
  const sessions = await Promise.all([parallel.session(ADMIN), parallel.session({ ...ADMIN, id: 'second-matching-id' })]);
  assert.equal(sessions.filter(session => session.role === 'admin').length, 1);
  assert.equal(parallel.DB.sqlite.prepare("SELECT count(*) AS n FROM users WHERE role='admin'").get().n, 1);
});

test('the actual migrated SQLite schema enforces roles, foreign keys, version/status and media constraints', async t => {
  const f = fixture(t);
  await f.session(ADMIN);
  assert.throws(() => f.DB.sqlite.prepare("UPDATE users SET role='superuser'").run(), /CHECK/);
  assert.throws(() => f.DB.sqlite.prepare("INSERT INTO admin_bootstrap VALUES(2,?,'now')").run(ADMIN.id), /CHECK/);
  assert.throws(() => f.DB.sqlite.prepare("INSERT INTO admin_bootstrap VALUES(1,'missing','now')").run(), /UNIQUE|FOREIGN KEY/);
  await status(await f.save(ADMIN, f.product()), 200);
  assert.throws(() => f.DB.sqlite.prepare('UPDATE products SET version=0').run(), /CHECK/);
  assert.throws(() => f.DB.sqlite.prepare("UPDATE products SET status='removed'").run(), /CHECK/);
  assert.throws(() => f.DB.sqlite.prepare("UPDATE products SET image_media_id='missing'").run(), /FOREIGN KEY/);
  assert.throws(() => f.DB.sqlite.prepare("UPDATE products SET product_json='not-json'").run(), /CHECK/);
});

test('explicit admin seed is idempotent and never overwrites edits; lists enforce published/owner visibility', async t => {
  const f = fixture(t);
  await f.grant(MERCHANT);
  await status(await f.call('/admin/seed', { method: 'POST', user: BUYER, body: {} }), 403);
  await status(await f.call('/admin/seed', { method: 'POST', user: MERCHANT, body: {} }), 403);
  const initial = await (await status(await f.call('/admin/seed', { method: 'POST', user: ADMIN, body: {} }), 200)).json();
  assert.equal(initial.inserted, 6);
  assert.equal(initial.products.length, 6);
  assert.ok(initial.products.every(product => product.version === 1));
  const edited = { ...initial.products[0], name: '管理员修改', status: 'offline' };
  await status(await f.save(ADMIN, edited, 1), 200);
  const seededAgain = await (await f.call('/admin/seed', { method: 'POST', user: ADMIN, body: {} })).json();
  assert.equal(seededAgain.inserted, 0);
  assert.equal(seededAgain.products.find(item => item.id === edited.id).name, '管理员修改');
  assert.equal(seededAgain.products.find(item => item.id === edited.id).version, 2);
  assert.equal((await (await f.call('/products')).json()).products.length, 5);
  await status(await f.save(MERCHANT, f.product('merchant-draft')), 200);
  assert.deepEqual((await (await f.call('/admin/products', { user: MERCHANT })).json()).products.map(product => product.id), ['merchant-draft']);
  assert.equal((await (await f.call('/admin/products', { user: ADMIN })).json()).products.length, 7);
  assert.equal((await (await f.call('/products')).json()).products.length, 5);
});

test('merchant ownership and atomic optimistic versions prevent cross-account writes and lost updates', async t => {
  const f = fixture(t);
  await f.grant(MERCHANT); await f.grant(OTHER);
  const created = await (await status(await f.save(MERCHANT, f.product()), 200)).json();
  assert.equal(created.version, 1);
  assert.equal(created.product.version, 1);
  await status(await f.save(OTHER, { ...created.product, name: '越权修改' }, 1), 403);
  await status(await f.save(MERCHANT, created.product, 0), 409);
  await status(await f.save(MERCHANT, f.product('missing-product'), 1), 409);
  const results = await Promise.all([
    f.save(MERCHANT, { ...created.product, name: '并发编辑甲' }, 1),
    f.save(MERCHANT, { ...created.product, name: '并发编辑乙' }, 1)
  ]);
  assert.deepEqual(results.map(response => response.status).sort(), [200, 409]);
  const stored = f.DB.sqlite.prepare('SELECT owner_id,version,updated_by,created_at,updated_at FROM products WHERE id=?').get(created.product.id);
  assert.equal(stored.owner_id, MERCHANT.id);
  assert.equal(stored.version, 2);
  assert.equal(stored.updated_by, MERCHANT.id);
  assert.ok(stored.created_at && stored.updated_at);
  const latest = (await (await f.call('/admin/products', { user: ADMIN })).json()).products[0];
  await status(await f.save(ADMIN, { ...latest, name: '管理员全局管理' }, latest.version), 200);
  assert.equal(f.DB.sqlite.prepare('SELECT owner_id FROM products WHERE id=?').get(latest.id).owner_id, MERCHANT.id);
});

test('product writes strictly reject malformed fields, forged owners, arbitrary URLs and invalid prices', async t => {
  const f = fixture(t); await f.grant(MERCHANT);
  const badProducts = [
    { ...f.product(), ownerId: ADMIN.id }, { ...f.product(), role: 'admin' },
    { ...f.product(), image: 'https://outside.test/apple.png' }, { ...f.product(), image: 'assets/unshipped.jpg' },
    { ...f.product(), image: 'assets/../secret.jpg' }, { ...f.product(), video: 'assets/arbitrary.mp4' },
    { ...f.product(), status: 'deleted' }, { ...f.product(), category: 'anything' },
    { ...f.product(), name: '字'.repeat(41) }, { ...f.product(), version: 2 },
    { ...f.product(), imageMediaId: 'MEDIA-LOCAL-1' }, { ...f.product(), imageMediaId: null },
    { ...f.product(), tags: [1] }, { ...f.product(), facts: [['extra', 'value', 'bad']] },
    { ...f.product(), harvestSteps: [{ title: 'ok', text: 'ok', owner: ADMIN.id }] },
    { ...f.product(), variants: f.product().variants.map(variant => ({ ...variant, price: '100' })) },
    { ...f.product(), variants: f.product().variants.map(variant => ({ ...variant, price: 1.5 })) },
    { ...f.product(), variants: f.product().variants.map(variant => ({ ...variant, price: 0 })) },
    { ...f.product(), variants: f.product().variants.map(variant => ({ ...variant, id: 'small' })) }
  ];
  const incomplete = f.product(); delete incomplete.videoNote; badProducts.push(incomplete);
  for (const product of badProducts) await status(await f.save(MERCHANT, product), 400);
  await status(await f.call('/admin/products/another-id', { method: 'PUT', user: MERCHANT, body: { product: f.product(), expectedVersion: 0 } }), 400);
  await status(await f.call('/admin/products/own-product', { method: 'PUT', user: MERCHANT, body: { product: f.product(), expectedVersion: 0, userId: ADMIN.id } }), 400);
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) AS n FROM products').get().n, 0);
});

test('mutations require same-origin requests and the correct content type; unavailable storage never reports success', async t => {
  const f = fixture(t); await f.grant(MERCHANT);
  await status(await f.save(MERCHANT, f.product(), 0, { origin: null }), 403);
  await status(await f.save(MERCHANT, f.product(), 0, { origin: 'https://evil.test' }), 403);
  await status(await f.save(MERCHANT, f.product(), 0, { headers: { 'Content-Type': 'text/plain' } }), 415);
  await status(await f.call('/admin/products/own-product', { method: 'PUT', user: MERCHANT, body: '{bad-json', headers: { 'Content-Type': 'application/json' } }), 400);
  await status(await f.call('/orders'), 401);
  await status(await f.call('/session', { method: 'POST', body: {} }), 405);
  await status(await f.call('/media?kind=image', { method: 'OPTIONS' }), 405);
  f.DB.failSQL = sql => /INSERT INTO products/.test(sql);
  const failed = await status(await f.save(MERCHANT, f.product()), 503);
  const error = await failed.text();
  assert.ok(!error.includes('SQL') && !error.includes('private database'));
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) AS n FROM products').get().n, 0);
});

test('uploads verify kind, signatures, attribution, ownership and bounded streaming before R2 writes', async t => {
  const f = fixture(t); await f.grant(MERCHANT);
  await status(await f.upload(BUYER), 403);
  await status(await f.call('/media?kind=anything', { method: 'POST', user: MERCHANT, body: PNG }), 400);
  await status(await f.upload(MERCHANT, 'image', VIDEO), 415);
  await status(await f.upload(MERCHANT, 'image', PNG, { headers: { 'Content-Type': 'image/svg+xml' } }), 415);
  for (const headers of [
    { 'X-Media-Source': '' }, { 'X-Media-Source': '%' },
    { 'X-Media-Source': encodeURIComponent('字'.repeat(501)) },
    { 'X-File-Name': encodeURIComponent('../secret.png') }
  ]) await status(await f.upload(MERCHANT, 'image', PNG, { headers }), 400);

  let reads = 0, cancelled = false;
  const declaredTooLarge = new ReadableStream({ pull(controller) { reads++; controller.enqueue(PNG); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
  await status(await f.upload(MERCHANT, 'image', declaredTooLarge, { headers: { 'Content-Length': String(5 * 1024 * 1024 + 1) } }), 413);
  assert.equal(reads, 0, 'reject a declared oversize upload before consuming its body');
  await declaredTooLarge.cancel();
  reads = 0; cancelled = false;
  const actualTooLarge = new ReadableStream({ pull(controller) { reads++; controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
  await status(await f.upload(MERCHANT, 'image', actualTooLarge), 413);
  assert.equal(cancelled, true);
  assert.ok(reads <= 6, 'stop streaming immediately after the configured image limit');
  assert.equal(f.BUCKET.puts, 0);

  const uploaded = await (await status(await f.upload(MERCHANT), 201)).json();
  assert.match(uploaded.id, /^CLOUD-/);
  assert.equal(uploaded.url, `/api/v1/media/${uploaded.id}`);
  assert.equal(uploaded.kind, 'image');
  assert.equal(uploaded.size, PNG.byteLength);
  assert.match(uploaded.source, /测试自有/);
  const row = f.DB.sqlite.prepare('SELECT * FROM media WHERE id=?').get(uploaded.id);
  assert.equal(row.owner_id, MERCHANT.id);
  assert.equal(row.source, uploaded.source);
  assert.ok(row.created_at);
});

test('failed object/database writes clean up safely and never publish an orphan upload', async t => {
  const f = fixture(t); await f.grant(MERCHANT);
  f.BUCKET.failPut = true;
  await status(await f.upload(MERCHANT), 503);
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) AS n FROM media').get().n, 0);
  f.BUCKET.failPut = false;
  f.DB.failSQL = sql => /INSERT INTO media/.test(sql);
  await status(await f.upload(MERCHANT), 503);
  assert.equal(f.BUCKET.objects.size, 0);
  assert.equal(f.BUCKET.deletes, 1);
  f.BUCKET.failDelete = true;
  await status(await f.upload(MERCHANT), 503);
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) AS n FROM media').get().n, 0);
  assert.equal(f.BUCKET.objects.size, 1, 'cleanup failure may leave an object but never a publicly addressable row');
  const id = [...f.BUCKET.objects.keys()][0].split('/').at(-1);
  await status(await f.call(`/media/${id}`), 404);
});

test('draft/offline media stays private; ownership and kind checks precede publishing and Range/HEAD reads', async t => {
  const f = fixture(t); await f.grant(MERCHANT); await f.grant(OTHER);
  const image = await (await f.upload(MERCHANT)).json();
  const video = await (await f.upload(MERCHANT, 'video', VIDEO)).json();
  await status(await f.call(`/media/${video.id}`), 404);
  await status(await f.call(`/media/${video.id}`, { method: 'HEAD', headers: { Range: 'bytes=999999-' } }), 404);
  await status(await f.call(`/media/${video.id}`, { user: OTHER }), 404);
  await status(await f.call(`/media/${video.id}`, { user: MERCHANT }), 200);
  await status(await f.call(`/media/${video.id}`, { user: ADMIN }), 200);
  await status(await f.save(OTHER, f.product('foreign-bind', { imageMediaId: image.id })), 403);
  await status(await f.save(MERCHANT, f.product('wrong-kind', { imageMediaId: video.id })), 403);
  const draft = f.product('own-media', { imageMediaId: image.id, videoMediaId: video.id });
  await status(await f.save(MERCHANT, draft), 200);
  await status(await f.call(`/media/${video.id}`), 404);
  const published = await (await status(await f.save(MERCHANT, { ...draft, status: 'published' }, 1), 200)).json();
  const full = await status(await f.call(`/media/${video.id}`), 200);
  assert.equal(full.headers.get('Content-Type'), 'video/mp4');
  assert.equal(full.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.deepEqual(new Uint8Array(await full.arrayBuffer()), VIDEO);
  for (const [range, start, end] of [
    ['bytes=0-31', 0, 31], ['bytes=4000-', 4000, VIDEO.length - 1],
    ['bytes=-16', VIDEO.length - 16, VIDEO.length - 1],
    ['Bytes=4090-99999999999999999999999', 4090, VIDEO.length - 1]
  ]) {
    const response = await status(await f.call(`/media/${video.id}`, { headers: { Range: range } }), 206);
    assert.equal(response.headers.get('Content-Range'), `bytes ${start}-${end}/${VIDEO.length}`);
    assert.equal(Number(response.headers.get('Content-Length')), end - start + 1);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), VIDEO.slice(start, end + 1));
  }
  for (const range of ['bytes=999999999999999999999999-', 'bytes=3-1', 'bytes=-0']) {
    const response = await status(await f.call(`/media/${video.id}`, { headers: { Range: range } }), 416);
    assert.equal(response.headers.get('Content-Range'), `bytes */${VIDEO.length}`);
  }
  const head = await status(await f.call(`/media/${video.id}`, { method: 'HEAD', headers: { Range: 'bytes=0-1' } }), 200);
  assert.equal(await head.text(), '');
  assert.equal(Number(head.headers.get('Content-Length')), VIDEO.length);
  assert.equal(head.headers.get('Content-Range'), null);
  for (const headers of [{ Range: 'bytes=0-0,2-2' }, { Range: 'items=0-1' }, { Range: 'bytes=0-1', 'If-Range': '"stale"' }]) {
    const response = await status(await f.call(`/media/${video.id}`, { headers }), 200);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), VIDEO);
  }
  await status(await f.save(MERCHANT, { ...published.product, status: 'offline' }, 2), 200);
  await status(await f.call(`/media/${video.id}`), 404);
});
