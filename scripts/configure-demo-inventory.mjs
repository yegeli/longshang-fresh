#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const DEMO_IDS = ['jingtai-apple', 'goji', 'pear', 'potato', 'corn', 'onion'];

// Secrets arrive through hidden stdin, never command arguments, query strings,
// checked-in files, logs or simulated visitor-identity headers.
export function validateSetupConfig(config) {
  assert.ok(config && typeof config === 'object' && !Array.isArray(config), 'Expected configuration object.');
  assert.ok(Object.keys(config).every(key => ['url', 'siteServiceToken', 'setupToken', 'mode'].includes(key)), 'Unknown configuration key.');
  const url = new URL(config.url);
  const local = url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  const hosted = url.protocol === 'https:' && /^[a-z0-9-]+\.[a-z0-9-]+\.chatgpt\.site$/.test(url.hostname) && !url.port;
  assert.ok(local || hosted, 'Use the exact hosted Site origin or HTTP loopback.');
  assert.equal(url.username + url.password + url.search + url.hash, '', 'Origin must not contain credentials, a query or fragment.');
  assert.equal(url.pathname, '/', 'Use a root origin.');
  assert.ok(['apply', 'verify'].includes(config.mode), 'Choose apply or verify explicitly.');
  assert.ok(typeof config.siteServiceToken === 'string' && config.siteServiceToken.length > 0 && !/[\r\n]/.test(config.siteServiceToken), 'Site service credential required.');
  assert.match(config.setupToken || '', /^[a-f0-9]{64}$/, 'Temporary setup credential required; verify uses the revoked credential.');
  return url.origin;
}

export async function configureDemoInventory(config, fetcher = fetch) {
  const origin = validateSetupConfig(config);
  const call = async (path, { method = 'GET', setup = false, expected = 200 } = {}) => {
    const headers = { Accept: 'application/json', 'OAI-Sites-Authorization': `Bearer ${config.siteServiceToken}`, 'Cache-Control': 'no-cache' };
    if (method === 'POST') Object.assign(headers, { Origin: origin, 'Content-Type': 'application/json' });
    if (setup) headers['X-Demo-Setup-Token'] = config.setupToken;
    const response = await fetcher(origin + path, { method, headers, redirect: 'error', signal: AbortSignal.timeout(30000), ...(method === 'POST' ? { body: '{}' } : {}) });
    // Do not echo remote bodies or credentials on failure.
    assert.equal(response.status, expected, `${method} ${path}: unexpected HTTP status.`);
    const data = await response.json();
    assert.ok(data && typeof data === 'object', 'Expected JSON response.');
    return data;
  };
  const session = await call('/api/v1/session');
  assert.equal(session.user, null, 'Service access must not impersonate a visitor.');
  assert.equal(session.canManage, false);
  const beforeProducts = await call('/api/v1/products');
  const before = (await call('/api/v1/inventory')).inventories;
  let setupResult;
  if (config.mode === 'apply') {
    setupResult = await call('/api/v1/maintenance/demo-inventory', { method: 'POST', setup: true });
    assert.ok(Array.isArray(setupResult.seededIds) && Array.isArray(setupResult.skippedIds));
    assert.ok(setupResult.seededIds.every(id => DEMO_IDS.includes(id)), 'Setup returned an unexpected product.');
  } else {
    await call('/api/v1/maintenance/demo-inventory', { method: 'POST', setup: true, expected: 404 });
  }
  const products = await call('/api/v1/products');
  const after = (await call('/api/v1/inventory')).inventories;
  assert.deepEqual(products, beforeProducts, 'Product data changed during configuration; inspect before continuing.');
  if (config.mode === 'apply' && !setupResult.replayed) {
    for (const id of setupResult.seededIds) {
      const row = after.find(item => item.productId === id);
      assert.ok(row?.configured, 'Seeded product is not visible or configured.');
      assert.deepEqual(row.stocks, { small: 20, family: 12 });
      assert.equal(row.version, 1);
      assert.equal(row.harvestDate, '');
      assert.match(row.note, /模拟/);
    }
    for (const row of before.filter(item => !setupResult.seededIds.includes(item.productId))) {
      assert.deepEqual(after.find(item => item.productId === row.productId), row, 'An unrelated inventory changed.');
    }
  }
  for (const path of ['/admin/products', '/admin/inventory', '/admin/orders', '/me/shopping']) await call('/api/v1' + path, { expected: 401 });
  return {
    mode: config.mode, ...(setupResult ? { seededIds: setupResult.seededIds, skippedIds: setupResult.skippedIds, replayed: setupResult.replayed } : { setupEndpointDisabled: true }),
    inventories: after.filter(item => DEMO_IDS.includes(item.productId)).map(({ productId, configured, stocks, version, batchCode }) => ({ productId, configured, stocks, version, batchCode })),
    productDataPreserved: true, anonymousManagementDenied: true
  };
}

async function main() {
  const tty = Boolean(process.stdin.isTTY);
  let hidden = false;
  try {
    if (tty) {
      const result = spawnSync('stty', ['-echo'], { stdio: ['inherit', 'ignore', 'ignore'] });
      assert.equal(result.status, 0, 'Unable to hide input; refusing to read credentials.');
      hidden = true;
    }
    console.log('Ready for Site inventory configuration JSON on stdin (input hidden on TTY).');
    const reader = createInterface({ input: process.stdin, terminal: false });
    let line;
    for await (const value of reader) { line = value; reader.close(); break; }
    const config = JSON.parse(line || '{}');
    if (hidden) { spawnSync('stty', ['echo'], { stdio: ['inherit', 'ignore', 'ignore'] }); hidden = false; }
    console.log(JSON.stringify(await configureDemoInventory(config)));
  } catch {
    console.error('Inventory configuration or verification failed. No credentials were logged. Inspect the service state before retrying.');
    process.exitCode = 1;
  } finally {
    if (hidden) spawnSync('stty', ['echo'], { stdio: ['inherit', 'ignore', 'ignore'] });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
