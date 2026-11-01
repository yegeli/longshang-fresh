import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeCloudMode } from '../public/cloud-client.js';
import { loadCloudOrder, loadCloudOrders, mutateCloudOrder } from '../public/order-store.js';
import { BASE_CATALOG, createOrder, shipOrder, receiveOrder, setCatalog } from '../public/model.js';

const originalFetch = globalThis.fetch;
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const session = async (role = 'buyer', id = 'receipt-buyer') => {
  globalThis.fetch = async () => json({ user: { id }, role, canManage: role === 'admin', ...(role === 'admin' ? { permissions: ['products', 'orders', 'aftersales'] } : {}) });
  await initializeCloudMode({ force: true });
};
function order(received = false) {
  setCatalog(BASE_CATALOG);
  const initial = createOrder({ productId: 'jingtai-apple', variant: 'small', quantity: 1, address: 'gansu' }, 'DEMO-RECEIPT-CLIENT', '2026-10-30T00:00:00.000Z');
  const shipped = shipOrder(initial, '模拟物流', 'DEMO-RECEIPT', '2026-10-30T01:00:00.000Z');
  return { ...(received ? receiveOrder(shipped, '2026-10-31T00:00:00.000Z') : shipped), version: received ? 2 : 1, updatedAt: '2026-10-31T00:00:00.000Z' };
}
test.afterEach(() => { globalThis.fetch = originalFetch; setCatalog(BASE_CATALOG); });

test('buyer receipt uses its own versioned API while manager receipt sends no request', async () => {
  await session();
  const payload = { expectedVersion: 1 }, calls = [];
  globalThis.fetch = async (path, options) => {
    calls.push({ path, method: options.method, body: JSON.parse(options.body) });
    return json({ order: order(true) });
  };
  const received = await mutateCloudOrder('DEMO-RECEIPT-CLIENT', 'receive', payload);
  assert.equal(received.receipt.status, 'received');
  assert.deepEqual(calls, [{ path: '/api/v1/orders/DEMO-RECEIPT-CLIENT/receive', method: 'POST', body: payload }]);
  assert.deepEqual(payload, { expectedVersion: 1 });
  await session('admin', 'receipt-admin');
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('not allowed'); };
  await assert.rejects(mutateCloudOrder('DEMO-RECEIPT-CLIENT', 'receive', payload, { manager: true }), error => error.status === 403);
  assert.equal(requests, 0);
});

test('cloud reads preserve valid receipt and legacy orders but reject forged or backwards receipt metadata', async () => {
  await session();
  for (const value of [order(), order(true)]) {
    globalThis.fetch = async () => json({ order: value });
    assert.deepEqual((await loadCloudOrder(value.id)).receipt, value.receipt);
    globalThis.fetch = async () => json({ orders: [value], nextCursor: null });
    assert.deepEqual((await loadCloudOrders()).orders[0].receipt, value.receipt);
  }
  const valid = order(true);
  for (const value of [{ ...valid, receipt: null }, { ...valid, status: 'cancelled' }, { ...valid, fulfillment: undefined },
    { ...valid, receipt: { status: 'received', receivedAt: 'bad' } },
    { ...valid, receipt: { status: 'received', receivedAt: '2026-10-30T00:30:00.000Z' } },
    { ...valid, receipt: { ...valid.receipt, buyerId: 'forged' } },
    { ...valid, createdAt: '2026-11-01T00:00:00.000Z' }]) {
    globalThis.fetch = async () => json({ order: value });
    await assert.rejects(loadCloudOrder(value.id), error => error.code === 'invalid_order_response');
  }
});

test('receipt network failures and account changes never turn into a local confirmation', async () => {
  await session();
  const payload = { expectedVersion: 1 };
  globalThis.fetch = async () => { throw new Error('network lost'); };
  await assert.rejects(mutateCloudOrder('DEMO-RECEIPT-CLIENT', 'receive', payload), error => error.code === 'NETWORK_ERROR');
  assert.deepEqual(payload, { expectedVersion: 1 });
  let release;
  globalThis.fetch = () => new Promise(resolve => { release = resolve; });
  const pending = mutateCloudOrder('DEMO-RECEIPT-CLIENT', 'receive', payload);
  await session('buyer', 'other-buyer');
  release(json({ order: order(true) }));
  await assert.rejects(pending, error => error.code === 'account_changed');
});
