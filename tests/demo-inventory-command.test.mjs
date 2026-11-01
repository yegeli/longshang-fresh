import test from 'node:test';
import assert from 'node:assert/strict';
import { configureDemoInventory, validateSetupConfig } from '../scripts/configure-demo-inventory.mjs';

const config = { url: 'https://demo.example.chatgpt.site', mode: 'apply', siteServiceToken: 'fixture-service-token', setupToken: 'a'.repeat(64) };
const empty = { productId: 'jingtai-apple', configured: false, stocks: { small: 0, family: 0 }, version: 0, harvestDate: '', note: '' };
const seeded = { ...empty, configured: true, stocks: { small: 20, family: 12 }, version: 1, note: '一次性模拟库存', batchCode: 'DEMO-SETUP' };

test('setup command refuses credential-bearing URLs, redirects targets, untrusted hosts and implicit write modes', () => {
  assert.equal(validateSetupConfig(config), config.url);
  for (const patch of [
    { url: 'https://example.com' }, { url: 'http://demo.example.chatgpt.site' },
    { url: config.url + '/api/v1/' }, { url: config.url + '?secret=x' },
    { url: 'https://user:pass@demo.example.chatgpt.site' }, { url: config.url + '#x' },
    { url: config.url + ':444' }, { mode: undefined }, { setupToken: 'weak' }, { arbitrary: true }
  ]) assert.throws(() => validateSetupConfig({ ...config, ...patch }));
});

function service({ verify = false, mutateProduct = false } = {}) {
  let applied = false, productReads = 0;
  const requests = [];
  return { requests, fetcher: async (url, options) => {
    const path = new URL(url).pathname;
    requests.push({ path, options });
    assert.equal(new URL(url).origin, config.url);
    assert.equal(options.redirect, 'error');
    assert.equal(Object.keys(options.headers).some(key => key.startsWith('oai-authenticated')), false);
    assert.equal(options.headers['OAI-Sites-Authorization'], 'Bearer fixture-service-token');
    let status = 200, data;
    if (path.endsWith('/session')) data = { user: null, canManage: false };
    else if (path === '/api/v1/products') data = { products: [{ id: 'jingtai-apple', price: ++productReads > 1 && mutateProduct ? 999 : 4880 }] };
    else if (path === '/api/v1/inventory') data = { inventories: [applied || verify ? seeded : empty] };
    else if (path === '/api/v1/maintenance/demo-inventory') {
      assert.equal(options.method, 'POST');
      assert.equal(options.body, '{}');
      assert.equal(options.headers.Origin, config.url);
      if (verify) { assert.equal(options.headers['X-Demo-Setup-Token'], config.setupToken); status = 404; data = { error: { code: 'not_found' } }; }
      else { assert.equal(options.headers['X-Demo-Setup-Token'], config.setupToken); applied = true; data = { seededIds: ['jingtai-apple'], skippedIds: [], replayed: false }; }
    } else { status = 401; data = { error: { code: 'sign_in_required' } }; }
    return new Response(JSON.stringify(data), { status });
  } };
}

test('CLI configures bounded stock without visitor identity and verifies product preservation and management denial', async () => {
  const mock = service();
  const result = await configureDemoInventory(config, mock.fetcher);
  assert.deepEqual(result.seededIds, ['jingtai-apple']);
  assert.equal(result.productDataPreserved, true);
  assert.deepEqual(result.inventories[0].stocks, { small: 20, family: 12 });
  assert.equal(mock.requests.filter(row => row.options.method === 'POST').length, 1);
  assert.equal(JSON.stringify(result).includes(config.setupToken), false);
  assert.equal(JSON.stringify(result).includes(config.siteServiceToken), false);
});

test('CLI verify confirms even the formerly valid setup credential is disabled', async () => {
  const mock = service({ verify: true });
  const result = await configureDemoInventory({ ...config, mode: 'verify' }, mock.fetcher);
  assert.equal(result.setupEndpointDisabled, true);
});

test('CLI never silently follows redirects or ignores product changes', async () => {
  const mock = service({ mutateProduct: true });
  await assert.rejects(configureDemoInventory(config, mock.fetcher), /Product data changed/);
  let calls = 0;
  await assert.rejects(configureDemoInventory(config, async (_url, options) => {
    calls++; assert.equal(options.redirect, 'error');
    return new Response('', { status: 307, headers: { Location: 'https://untrusted.example' } });
  }), /Unexpected HTTP status/);
  assert.equal(calls, 1);
});
