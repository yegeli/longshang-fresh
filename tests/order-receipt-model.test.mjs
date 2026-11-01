import test from 'node:test';
import assert from 'node:assert/strict';
import { BASE_CATALOG, setCatalog, createOrder, shipOrder, receiveOrder, validOrderReceipt, validOrders, createAfterSale, updateAfterSale, resolveAfterSale } from '../public/model.js';

const createdAt = '2026-10-31T00:00:00.000Z';
const shippedAt = '2026-10-31T01:00:00.000Z';
const receivedAt = '2026-11-01T02:00:00.000Z';
const afterInput = { type: 'replacement', reason: 'damaged', description: '模拟收货后发现包装问题', hasEvidence: false };
function order() {
  setCatalog(BASE_CATALOG);
  return createOrder({ productId: 'jingtai-apple', variant: 'small', quantity: 1, address: 'gansu' }, 'DEMO-RECEIPT-MODEL', createdAt);
}
const shipped = () => shipOrder(order(), '模拟物流', 'DEMO-RECEIPT', shippedAt);

test('receiving completes a shipped simulation without changing its snapshot or fulfillment', () => {
  const original = shipped(), before = structuredClone(original);
  const received = receiveOrder(original, receivedAt);
  assert.deepEqual(original, before, 'The caller record must not mutate before persistence succeeds.');
  assert.deepEqual(received, { ...original, receipt: { status: 'received', receivedAt } });
  assert.equal(received.status, 'created');
  assert.equal(received.fulfillment.status, 'shipped');
  assert.equal(validOrderReceipt(received), true);
  assert.deepEqual(validOrders([received])[0].receipt, received.receipt);
  assert.throws(() => receiveOrder(received, '2026-11-02T00:00:00.000Z'), /已确认收货/);
  assert.equal(received.receipt.receivedAt, receivedAt);
  assert.throws(() => shipOrder(received, '模拟物流', 'DEMO-AGAIN', receivedAt), /已确认收货/);
});

test('receipt requires shipping and rejects cancelled, pending after-sale and refunded orders', () => {
  const base = shipped();
  const pending = createAfterSale(base, afterInput, 'AFTER-RECEIPT', '2026-10-31T02:00:00.000Z');
  const refunded = resolveAfterSale({ ...pending, afterSale: { ...pending.afterSale, type: 'refund' } }, '模拟退款', '2026-10-31T03:00:00.000Z');
  for (const invalid of [order(), { ...base, status: 'cancelled' }, pending, refunded]) {
    const before = structuredClone(invalid);
    assert.throws(() => receiveOrder(invalid, receivedAt));
    assert.deepEqual(invalid, before);
  }
  const withdrawn = updateAfterSale(pending, 'withdrawn', '2026-10-31T03:00:00.000Z');
  assert.equal(receiveOrder(withdrawn, receivedAt).receipt.status, 'received');
  assert.equal(receiveOrder(resolveAfterSale(pending, '模拟处理完成', '2026-10-31T03:00:00.000Z'), receivedAt).receipt.status, 'received');
});

test('receipt timestamps cannot precede shipment or an order whose shipment predates creation', () => {
  for (const invalidTime of ['not-a-date', 123, '2026-10-30T23:00:00.000Z', '2026-10-31T00:30:00.000Z']) {
    assert.throws(() => receiveOrder(shipped(), invalidTime), /时间无效/);
  }
  assert.throws(() => receiveOrder({ ...shipped(), createdAt: '2026-11-01T00:00:00.000Z' }, receivedAt), /时间无效/);
  assert.equal(receiveOrder(shipped(), shippedAt).receipt.receivedAt, shippedAt, 'Equality is safe for a fast simulation.');
});

test('confirmed receipt survives later after-sale applications, withdrawals and simulated refunds', () => {
  const received = receiveOrder(shipped(), receivedAt);
  const pending = createAfterSale(received, { ...afterInput, type: 'refund' }, 'AFTER-POST-RECEIPT', '2026-11-01T03:00:00.000Z');
  assert.deepEqual(pending.receipt, received.receipt);
  const withdrawn = updateAfterSale(pending, 'withdrawn', '2026-11-01T04:00:00.000Z');
  assert.deepEqual(validOrders([withdrawn])[0].receipt, received.receipt);
  const refunded = resolveAfterSale(pending, '模拟完成，实际退款0元', '2026-11-01T04:00:00.000Z');
  assert.equal(validOrderReceipt(refunded), true, 'Later after-sale outcomes must not erase receipt history.');
  assert.deepEqual(validOrders([refunded])[0].receipt, received.receipt);
});

test('legacy orders remain readable while malformed receipt data fails closed', () => {
  for (const old of [order(), shipped()]) {
    assert.equal(validOrders([old]).length, 1);
    assert.equal(validOrders([old])[0].receipt, undefined);
  }
  for (const receipt of [null, [], {}, { status: 'pending', receivedAt }, { status: 'received' }, { status: 'received', receivedAt: 1 },
    { status: 'received', receivedAt: 'invalid' }, { status: 'received', receivedAt, buyerId: 'forged' },
    { status: 'received', receivedAt: '2026-10-31T00:00:00.000Z' }]) {
    assert.deepEqual(validOrders([{ ...shipped(), receipt }]), []);
  }
  assert.deepEqual(validOrders([{ ...order(), receipt: { status: 'received', receivedAt } }]), []);
  assert.deepEqual(validOrders([{ ...shipped(), status: 'cancelled', receipt: { status: 'received', receivedAt } }]), []);
  assert.deepEqual(validOrders([{ ...shipped(), createdAt: receivedAt, receipt: { status: 'received', receivedAt } }]), []);
});
