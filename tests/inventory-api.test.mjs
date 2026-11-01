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
    this.adapter.maxBindings = Math.max(this.adapter.maxBindings || 0, this.values.length);
    assert.ok(this.values.length <= 100, 'D1 statement binding limit exceeded');
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
const ADMIN = { id: 'inventory-admin', email: 'owner@example.test' };
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
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()).product;
  };
  const quote = async (items = ITEMS, address = 'gansu', user = BUYER) => {
    const response = await call('/orders/quote', { method: 'POST', user, body: { items, address } });
    assert.equal(response.status, 200, await response.clone().text()); return (await response.json()).quote;
  };
  const payload = async (overrides = {}) => {
    const items = overrides.items || ITEMS, address = overrides.address || 'gansu';
    const q = await quote(items, address, overrides.user || BUYER);
    return { items, address, expectedTotal: q.total, productVersions: q.productVersions, inventoryVersions: q.inventoryVersions, idempotencyKey: crypto.randomUUID(), ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'user')) };
  };
  const create = (body, user = BUYER) => call('/orders', { method: 'POST', user, body });
  const mutation = (path, body, user = BUYER) => call(path, { method: 'POST', user, body });
  const setup = async () => { await session(ADMIN); await merchant(SELLER); await merchant(OTHER_SELLER); await publish(SELLER); await publish(SELLER, 'goji'); };
  const inventories = async (user = SELLER, publicRead = false) => (await data(await call(publicRead ? '/inventory' : '/admin/inventory', { user }))).inventories;
  const inventory = async id => (await inventories()).find(item => item.productId === id);
  const configure = async (id = 'jingtai-apple', overrides = {}, user = SELLER) => {
    const current = (await inventories(ADMIN)).find(item => item.productId === id);
    const body = { expectedVersion: current.version, stocks: {small:10,family:10},batchCode:'TEST-BATCH',harvestDate:'2026-10-31',note:'模拟采摘资料',reason:'测试配置',...overrides };
    return (await data(await call('/admin/inventory/'+id,{method:'PUT',user,body}))).inventory;
  };
  const history = async (id = 'jingtai-apple', user = SELLER) => (await data(await call('/admin/inventory/'+id+'/history',{user}))).events;
  const stockSetup = async () => { await setup(); await configure(); await configure('goji'); };
  const single = [{productId:'jingtai-apple',variant:'small',quantity:1}];
  return { DB, call, session, merchant, publish, quote, payload, create, mutation, setup, inventories, inventory, configure, history, stockSetup, single };
}
async function data(response, expected = 200) {
  assert.equal(response.status, expected, await response.clone().text());
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  return response.json();
}

test('inventory starts unconfigured and zero; public and management lists respect product visibility and ownership', async t => {
  const f=fixture(t); await f.setup(); await f.publish(OTHER_SELLER,'pear');
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) n FROM product_inventory').get().n,0);
  const publicRows=await f.inventories(null,true);
  assert.equal(publicRows.length,3); assert.ok(publicRows.every(row=>!row.configured&&row.version===0&&row.stocks.small===0&&row.batchId===''));
  assert.equal((await f.inventories()).length,2); assert.equal((await f.inventories(ADMIN)).length,3);
  await data(await f.call('/admin/inventory',{user:null}),401);
  await data(await f.call('/admin/inventory',{user:BUYER}),403);
  await data(await f.call('/admin/inventory/pear/history',{user:SELLER}),404);
  const denied=await data(await f.call('/orders/quote',{method:'POST',user:BUYER,body:{items:f.single,address:'gansu'}}),409);
  assert.equal(denied.error.code,'stock_insufficient');
  await f.publish(OTHER_SELLER,'pear',{version:1,status:'offline'});
  assert.equal((await f.inventories(null,true)).length,2);
  f.DB.sqlite.prepare("UPDATE merchant_accounts SET status='disabled' WHERE user_id=?").run(SELLER.id);
  assert.deepEqual(await f.inventories(null,true),[]);
  await data(await f.call('/admin/inventory',{user:SELLER}),403);
});

test('stock adjustments are versioned, audited, and changing batch code or harvest date creates a new stable batch', async t => {
  const f=fixture(t); await f.setup();
  let item=await f.configure(); const first=item.batchId;
  assert.equal(item.version,1); assert.match(first,/^BATCH-[A-F0-9-]{36}$/);
  item=await f.configure('jingtai-apple',{stocks:{small:7,family:12},note:'修改说明'});
  assert.equal(item.batchId,first); assert.equal(item.version,2);
  const stale=await f.call('/admin/inventory/jingtai-apple',{method:'PUT',user:SELLER,body:{expectedVersion:1,stocks:{small:99,family:99},batchCode:'TEST-BATCH',harvestDate:'2026-10-31',note:'',reason:'过期'}});
  await data(stale,409); assert.equal((await f.history()).length,2);
  let events=await f.history(); assert.equal(events[0].action,'adjusted'); assert.equal(events[0].before.stocks.small,10); assert.equal(events[0].after.stocks.small,7); assert.equal(events[1].before,null);
  item=await f.configure('jingtai-apple',{batchCode:'SECOND-BATCH'}); assert.notEqual(item.batchId,first);
  const second=item.batchId; item=await f.configure('jingtai-apple',{batchCode:'SECOND-BATCH',harvestDate:'2026-11-01'}); assert.notEqual(item.batchId,second);
  assert.equal((await f.inventories(null,true)).find(row=>row.productId==='jingtai-apple').batchId,item.batchId);
});

test('inventory input rejects forged scope, unsafe counts, invalid dates, unknown fields and cross-origin writes', async t => {
  const f=fixture(t); await f.setup();
  const input={expectedVersion:0,stocks:{small:1,family:2},batchCode:'BATCH',harvestDate:'2026-10-31',note:'模拟',reason:'配置'};
  for(const patch of [{stocks:{small:-1,family:2}},{stocks:{small:0.5,family:2}},{stocks:{small:1000000,family:2}},{stocks:{small:2,family:2,extra:1}},{stocks:{small:2}},{batchCode:''},{harvestDate:'2026-02-30'},{harvestDate:'01/01/2026'},{note:'x\u0000'},{reason:''},{ownerId:OTHER_SELLER.id},{expectedVersion:-1},{batchId:'forged'}]) {
    await data(await f.call('/admin/inventory/jingtai-apple',{method:'PUT',user:SELLER,body:{...input,...patch}}),400);
  }
  await data(await f.call('/admin/inventory/jingtai-apple',{method:'PUT',user:OTHER_SELLER,body:input}),404);
  await data(await f.call('/admin/inventory/jingtai-apple',{method:'PUT',user:SELLER,origin:'https://evil.example.test',body:input}),403);
  await data(await f.call('/admin/inventory/jingtai-apple',{method:'PUT',user:SELLER,body:input,headers:{'Content-Type':'text/plain'}}),415);
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) n FROM product_inventory').get().n,0);
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) n FROM inventory_events').get().n,0);
});

test('audit failure rolls back stock creation and edits, and final writes recheck revoked product permissions', async t => {
  const f=fixture(t); await f.setup();
  f.DB.failSQL=sql=>sql.includes('INSERT INTO inventory_events');
  const input={expectedVersion:0,stocks:{small:1,family:2},batchCode:'BATCH',harvestDate:'',note:'',reason:'配置'};
  await data(await f.call('/admin/inventory/jingtai-apple',{method:'PUT',user:SELLER,body:input}),503);
  assert.equal((await f.inventory('jingtai-apple')).configured,false);
  f.DB.failSQL=null; await f.configure();
  f.DB.failSQL=sql=>sql.includes('INSERT INTO inventory_events');
  await data(await f.call('/admin/inventory/jingtai-apple',{method:'PUT',user:SELLER,body:{...input,expectedVersion:1}}),503);
  f.DB.failSQL=null; assert.equal((await f.inventory('jingtai-apple')).stocks.small,10); assert.equal((await f.history()).length,1);
  f.DB.beforeSQL=sql=>{if(!sql.startsWith('UPDATE product_inventory SET small_stock=?'))return; f.DB.beforeSQL=null;f.DB.sqlite.prepare("UPDATE merchant_accounts SET permissions_json='[\"orders\"]' WHERE user_id=?").run(SELLER.id);};
  await data(await f.call('/admin/inventory/jingtai-apple',{method:'PUT',user:SELLER,body:{...input,expectedVersion:1}}),409);
  assert.equal(f.DB.sqlite.prepare("SELECT small_stock FROM product_inventory WHERE product_id='jingtai-apple'").get().small_stock,10);
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) n FROM inventory_events').get().n,1);
});

test('new orders capture batch details, atomically deduct all selected variants and preserve snapshots after replacement', async t => {
  const f=fixture(t); await f.stockSetup();
  const input=await f.payload({items:[...f.single,{productId:'jingtai-apple',variant:'family',quantity:2}]});
  assert.deepEqual(input.inventoryVersions,{'jingtai-apple':1});
  const {order}=await data(await f.create(input),201);
  assert.equal(order.items[0].batchCode,'TEST-BATCH'); assert.equal(order.items[0].harvestDate,'2026-10-31'); assert.equal(order.items[0].batchNote,'模拟采摘资料');
  let current=await f.inventory('jingtai-apple'); assert.deepEqual(current.stocks,{small:9,family:8}); assert.equal(current.version,2);
  let events=await f.history(); assert.equal(events[0].action,'reserved'); assert.equal(events[0].orderId,order.id); assert.deepEqual(events[0].before.stocks,{small:10,family:10}); assert.deepEqual(events[0].after.stocks,current.stocks);
  await f.configure('jingtai-apple',{batchCode:'LATER-BATCH',harvestDate:'2026-11-01',note:'之后的批次'});
  const saved=(await data(await f.call('/orders/'+order.id,{user:BUYER}))).order;
  assert.equal(saved.items[0].batchCode,'TEST-BATCH'); assert.equal(saved.items[0].batchNote,'模拟采摘资料');
});

test('two buyers racing for one unit create exactly one order, with no negative stock or duplicate movement', async t => {
  const f=fixture(t); await f.stockSetup(); await f.configure('jingtai-apple',{stocks:{small:1,family:0}});
  const first=await f.payload({items:f.single}), second={...first,idempotencyKey:crypto.randomUUID()};
  const responses=await Promise.all([f.create(first),f.create(second,OTHER_BUYER)]);
  assert.deepEqual(responses.map(response=>response.status).sort(),[201,409]);
  assert.equal((await f.inventory('jingtai-apple')).stocks.small,0);
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) n FROM orders').get().n,1);
  assert.equal((await f.history()).filter(event=>event.action==='reserved').length,1);
  const success=await responses.find(response=>response.status===201).json();
  const winner=responses[0].status===201 ? BUYER : OTHER_BUYER;
  const input=winner===BUYER ? first : second;
  const repeat=await data(await f.create(input,winner)); assert.equal(repeat.order.id,success.order.id); assert.equal(repeat.replayed,true);
  assert.equal((await f.inventory('jingtai-apple')).stocks.small,0);
});

test('same-key concurrent creates deduct once and stale quotes cannot consume changed stock or product state', async t => {
  const f=fixture(t); await f.stockSetup();
  const input=await f.payload({items:f.single}); const responses=await Promise.all([f.create(input),f.create(input)]);
  assert.deepEqual(responses.map(response=>response.status).sort(),[200,201]);
  assert.equal((await f.inventory('jingtai-apple')).stocks.small,9);
  const pending=await f.payload({items:f.single}); await f.configure('jingtai-apple',{stocks:{small:5,family:10}});
  const conflict=await data(await f.create(pending),409); assert.equal(conflict.error.code,'quote_changed');
  assert.equal((await f.inventory('jingtai-apple')).stocks.small,5);
  const fresh=await f.payload();
  f.DB.beforeSQL=sql=>{if(!sql.startsWith('INSERT INTO orders'))return;f.DB.beforeSQL=null;f.DB.sqlite.prepare("UPDATE product_inventory SET small_stock=0,version=version+1 WHERE product_id='jingtai-apple'").run();};
  await data(await f.create(fresh),409);
  assert.equal((await f.inventory('goji')).stocks.family,10,'a failed combined order must not deduct another product');
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) n FROM orders').get().n,1);
});

test('a failure after order insert rolls back every stock movement and safely retries with the original idempotency key', async t => {
  const f=fixture(t); await f.stockSetup(); const input=await f.payload();
  for(const failure of ['INSERT INTO inventory_events','UPDATE product_inventory']) {
    f.DB.failSQL=sql=>sql.startsWith(failure);
    const result=await data(await f.create(input),503); assert.ok(!JSON.stringify(result).includes('private SQL'));
    assert.equal(f.DB.sqlite.prepare('SELECT count(*) n FROM orders').get().n,0);
    f.DB.failSQL=null; assert.deepEqual((await f.inventory('jingtai-apple')).stocks,{small:10,family:10}); assert.equal((await f.history()).length,1);
  }
  await data(await f.create(input),201); assert.equal((await f.inventory('jingtai-apple')).stocks.small,8);
});

test('parallel cancellations release the original batch once and never expose internal release tokens', async t => {
  const f=fixture(t); await f.stockSetup(); const {order}=await data(await f.create(await f.payload()),201);
  const responses=await Promise.all([f.mutation('/orders/'+order.id+'/cancel',{expectedVersion:1}),f.mutation('/orders/'+order.id+'/cancel',{expectedVersion:1})]);
  assert.deepEqual(responses.map(response=>response.status).sort(),[200,409]);
  const cancelled=(await responses.find(response=>response.status===200).json()).order;
  assert.equal(cancelled.stockRelease.status,'released'); assert.equal(cancelled._stockReleaseToken,undefined);
  assert.deepEqual((await f.inventory('jingtai-apple')).stocks,{small:10,family:10}); assert.equal((await f.inventory('goji')).stocks.family,10);
  assert.equal((await f.history()).filter(event=>event.action==='released').length,1);
  await data(await f.mutation('/orders/'+order.id+'/cancel',{expectedVersion:2}),409);
  assert.equal((await f.inventory('jingtai-apple')).stocks.small,10);
});

test('cancel after a batch change succeeds with review and never adds old units to any current batch', async t => {
  const f=fixture(t); await f.stockSetup(); const {order}=await data(await f.create(await f.payload()),201);
  await f.configure('jingtai-apple',{batchCode:'NEW-BATCH',stocks:{small:3,family:4}});
  const cancelled=(await data(await f.mutation('/orders/'+order.id+'/cancel',{expectedVersion:1}))).order;
  assert.equal(cancelled.status,'cancelled'); assert.equal(cancelled.stockRelease.status,'review');
  assert.deepEqual((await f.inventory('jingtai-apple')).stocks,{small:3,family:4}); assert.equal((await f.inventory('goji')).stocks.family,9,'entire order awaits review; no partial automatic release');
  assert.equal((await f.history()).filter(event=>event.action==='release_review').length,1);
});

test('cancel audit failure rolls back order state and stock; safety overflow goes to review without blocking cancellation', async t => {
  const f=fixture(t); await f.stockSetup(); const {order}=await data(await f.create(await f.payload({items:f.single})),201);
  f.DB.failSQL=sql=>sql.startsWith('INSERT INTO inventory_events');
  await data(await f.mutation('/orders/'+order.id+'/cancel',{expectedVersion:1}),503);
  f.DB.failSQL=null; assert.equal((await data(await f.call('/orders/'+order.id,{user:BUYER}))).order.status,'created'); assert.equal((await f.inventory('jingtai-apple')).stocks.small,9);
  await f.configure('jingtai-apple',{stocks:{small:999999,family:10}});
  const released=(await data(await f.mutation('/orders/'+order.id+'/cancel',{expectedVersion:1}))).order;
  assert.equal(released.stockRelease.status,'released'); assert.equal((await f.inventory('jingtai-apple')).stocks.small,1000000);
  const {order:second}=await data(await f.create(await f.payload({items:f.single})),201);
  f.DB.sqlite.prepare("UPDATE product_inventory SET small_stock=? WHERE product_id='jingtai-apple'").run(Number.MAX_SAFE_INTEGER);
  const reviewed=(await data(await f.mutation('/orders/'+second.id+'/cancel',{expectedVersion:1}))).order;
  assert.equal(reviewed.stockRelease.status,'review'); assert.equal((await f.inventory('jingtai-apple')).stocks.small,Number.MAX_SAFE_INTEGER);
});

test('legacy retries survive upgrade without inventory versions and legacy cancellations cannot invent stock', async t => {
  const f=fixture(t); await f.stockSetup(); const input=await f.payload({items:f.single}); const {order}=await data(await f.create(input),201);
  const old={...input}; delete old.inventoryVersions;
  const legacyRequest=JSON.stringify({items:old.items,address:old.address,expectedTotal:old.expectedTotal,productVersions:old.productVersions});
  const row=f.DB.sqlite.prepare('SELECT order_json FROM orders WHERE id=?').get(order.id); const snapshot=JSON.parse(row.order_json);
  for(const item of snapshot.items) for(const key of ['batchId','batchCode','harvestDate','batchNote'])delete item[key];
  f.DB.sqlite.prepare('UPDATE orders SET request_json=?,order_json=? WHERE id=?').run(legacyRequest,JSON.stringify(snapshot),order.id);
  const replay=await data(await f.create(old)); assert.equal(replay.replayed,true); assert.equal(replay.order.id,order.id);
  await data(await f.create({...old,idempotencyKey:crypto.randomUUID()}),400);
  const cancelled=(await data(await f.mutation('/orders/'+order.id+'/cancel',{expectedVersion:1}))).order;
  assert.equal(cancelled.stockRelease,undefined); assert.equal((await f.inventory('jingtai-apple')).stocks.small,9);
});

test('aftersale and shipment do not return stock; disabled sellers may still have their buyers cancel safely', async t => {
  const f=fixture(t); await f.stockSetup(); let {order}=await data(await f.create(await f.payload({items:f.single})),201);
  order=(await data(await f.mutation('/admin/orders/'+order.id+'/ship',{expectedVersion:1,carrier:'模拟物流',tracking:'DEMO-INVENTORY'},SELLER))).order;
  order=(await data(await f.mutation('/orders/'+order.id+'/aftersale',{expectedVersion:order.version,type:'refund',reason:'damaged',description:'模拟',hasEvidence:false}))).order;
  order=(await data(await f.mutation('/admin/orders/'+order.id+'/aftersale/resolve',{expectedVersion:order.version,reply:'模拟退款'},SELLER))).order;
  assert.equal((await f.inventory('jingtai-apple')).stocks.small,9);
  await data(await f.mutation('/orders/'+order.id+'/cancel',{expectedVersion:order.version}),409);
  const {order:pending}=await data(await f.create(await f.payload({items:f.single})),201);
  f.DB.sqlite.prepare("UPDATE merchant_accounts SET status='disabled' WHERE user_id=?").run(SELLER.id);
  const cancelled=(await data(await f.mutation('/orders/'+pending.id+'/cancel',{expectedVersion:1}))).order;
  assert.equal(cancelled.stockRelease.status,'released');
  const adminRows=await f.inventories(ADMIN); assert.equal(adminRows.find(item=>item.productId==='jingtai-apple').stocks.small,9);
});



test('a maximum twelve-product order and cancellation stay below D1 binding limits', async t => {
  const f=fixture(t); await f.setup();
  const items=[];
  for(let index=0;index<12;index++) {
    const id=`inventory-limit-${index}`;
    await f.publish(SELLER,id); await f.configure(id,{stocks:{small:2,family:0}});
    items.push({productId:id,variant:'small',quantity:1});
  }
  const {order}=await data(await f.create(await f.payload({items})),201);
  const cancelled=(await data(await f.mutation('/orders/'+order.id+'/cancel',{expectedVersion:1}))).order;
  assert.equal(cancelled.stockRelease.status,'released');
  const inventories=await f.inventories();
  for(const item of items) assert.equal(inventories.find(row=>row.productId===item.productId).stocks.small,2);
  assert.ok(f.DB.maxBindings <= 100); assert.ok(f.DB.maxBindings > 60);
});
