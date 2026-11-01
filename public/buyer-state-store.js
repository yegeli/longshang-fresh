import { ADDRESSES } from './model.js';
import { apiRequest, getCloudState, CloudError } from './cloud-client.js';

const ENDPOINT = '/api/v1/me/shopping';
const PRODUCT_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;
const ORDER_ID = /^DEMO-[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}$/;
const ADDRESS_IDS = new Set(ADDRESSES.map(address => address.id));
const clone = value => structuredClone(value);
const empty = () => ({ cart: [], favorites: [], recent: [], preferredAddress: 'gansu' });
const state = { ...empty(), accountId: '', ready: false, loading: false, saving: false, error: '', version: 0, lastSyncedAt: '' };
let generation = 0, revision = 0, readSequence = 0, writeEpoch = 0, pendingWrites = 0, queue = Promise.resolve();
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const invalid = () => { throw new CloudError('云端购物资料格式异常，请重新读取。', 0, 'INVALID_RESPONSE'); };

function domain(value, reject = invalid) {
  if (!exact(value, ['cart', 'favorites', 'recent', 'preferredAddress']) || !Array.isArray(value.cart) || value.cart.length > 12 || !ADDRESS_IDS.has(value.preferredAddress)) reject();
  const seen = new Set(), cart = value.cart.map(row => {
    if (!exact(row, ['productId', 'variant', 'quantity', 'selected']) || typeof row.productId !== 'string' || !PRODUCT_ID.test(row.productId)
      || !['small', 'family'].includes(row.variant) || !Number.isSafeInteger(row.quantity) || row.quantity < 1 || row.quantity > 10 || typeof row.selected !== 'boolean'
      || seen.has(`${row.productId}::${row.variant}`)) reject();
    seen.add(`${row.productId}::${row.variant}`);
    return { productId: row.productId, variant: row.variant, quantity: row.quantity, selected: row.selected };
  });
  const list = value => {
    if (!Array.isArray(value) || value.length > 20 || value.some(id => typeof id !== 'string' || !PRODUCT_ID.test(id)) || new Set(value).size !== value.length) reject();
    return [...value];
  };
  return { cart, favorites: list(value.favorites), recent: list(value.recent), preferredAddress: value.preferredAddress };
}
function response(value, consuming = false) {
  if (!object(value) || Object.keys(value).some(key => !['state', 'version', 'updatedAt', 'consumed'].includes(key))
    || !Number.isSafeInteger(value.version) || value.version < 0 || !(value.updatedAt === null || typeof value.updatedAt === 'string')
    || (consuming && value.consumed !== true) || (!consuming && value.consumed !== undefined)) invalid();
  return { ...domain(value.state), version: value.version, lastSyncedAt: value.updatedAt || new Date().toISOString() };
}
function account() {
  const cloud = getCloudState();
  return cloud.mode === 'cloud' && !cloud.error && typeof cloud.session?.user?.id === 'string' ? cloud.session.user.id : '';
}
function reset(accountId = '') {
  generation++; revision++; readSequence++; writeEpoch++; pendingWrites = 0; queue = Promise.resolve();
  Object.assign(state, empty(), { accountId, ready: false, loading: false, saving: false, error: '', version: 0, lastSyncedAt: '' });
}
function synchronizeAccount() {
  const current = account();
  if (current !== state.accountId) reset(current);
  return current;
}
function current(scope) { synchronizeAccount(); return scope.accountId === state.accountId && scope.generation === generation && !!state.accountId; }
function requireCurrent(scope) {
  if (!current(scope)) throw new CloudError('登录账户已变化，本次操作未应用到新账户。请重新读取后操作。', 409, 'account_changed');
}
function apply(next) {
  Object.assign(state, next, { ready: true, error: '' }); revision++;
}
export function clearBuyerState() { reset(); }
export function getBuyerState() { synchronizeAccount(); return clone(state); }

export async function refreshBuyerState() {
  const accountId = synchronizeAccount();
  if (!accountId) {
    Object.assign(state, empty(), { ready: false, loading: false, saving: false, error: '请先登录，再同步购物车与收藏。', version: 0, lastSyncedAt: '' });
    return getBuyerState();
  }
  const scope = { accountId, generation }, startedRevision = revision, sequence = ++readSequence;
  state.loading = true;
  try {
    const next = response(await apiRequest(ENDPOINT));
    if (!current(scope) || sequence !== readSequence || revision !== startedRevision) return getBuyerState();
    if (next.version >= state.version) apply(next);
  } catch (error) {
    if (!current(scope) || sequence !== readSequence || revision !== startedRevision) return getBuyerState();
    Object.assign(state, empty(), { ready: false, error: error?.message || '云端购物资料暂不可读取，请重试。', version: 0, lastSyncedAt: '' });
    revision++;
  } finally { if (current(scope) && sequence === readSequence) state.loading = false; }
  return getBuyerState();
}

function enqueue(operation) {
  const accountId = synchronizeAccount(), scope = { accountId, generation }, epoch = writeEpoch;
  if (!accountId) return Promise.reject(new CloudError('请先登录，再同步购物车与收藏。', 401, 'sign_in_required'));
  pendingWrites++; state.saving = true;
  const task = queue.catch(() => {}).then(async () => {
    requireCurrent(scope);
    if (epoch !== writeEpoch) throw new CloudError('上一项操作未完成，请核对已读取的云端资料后重做。', 409, 'shopping_queue_cancelled');
    if (!state.ready) throw new CloudError('请先重新读取云端购物资料，再进行修改。', 409, 'shopping_not_ready');
    try {
      const next = await operation(); requireCurrent(scope);
      if (next.version >= state.version) apply(next);
      return getBuyerState();
    } catch (error) {
      if (!current(scope)) throw new CloudError('登录账户已变化，本次操作未应用到新账户。', 409, 'account_changed');
      writeEpoch++;
      if (error?.status === 409 || error?.status === 0 || error?.status >= 500) {
        const refreshed = await refreshBuyerState(); requireCurrent(scope);
        const message = error?.status === 409
          ? '购物资料已变化；已重新读取，请核对其他设备的修改后重做本次操作。'
          : '本次保存结果尚需核对；已尝试重新读取云端资料，请先确认本次操作是否已生效，再决定是否重做。';
        state.error = refreshed.ready ? message : `${message} 当前读取失败，请先点击重新读取。`;
        throw new CloudError(state.error, error.status || 0, error.code || 'shopping_uncertain');
      }
      state.error = error?.message || '购物资料未保存，请重新读取后重试。';
      throw error;
    }
  });
  queue = task.catch(() => {});
  return task.finally(() => { if (current(scope)) { pendingWrites--; state.saving = pendingWrites > 0; } });
}

export function mutateBuyerState(transform) {
  if (typeof transform !== 'function') return Promise.reject(new CloudError('请提供有效的购物资料修改操作。', 400, 'shopping_invalid'));
  return enqueue(async () => {
    const draft = clone({ cart: state.cart, favorites: state.favorites, recent: state.recent, preferredAddress: state.preferredAddress });
    const result = transform(draft);
    if (result && typeof result.then === 'function') throw new CloudError('购物资料修改必须同步完成，请重试。', 400, 'shopping_invalid');
    const next = domain(result === undefined ? draft : result, () => { throw new CloudError('购物资料格式无效，本次修改尚未发送。', 400, 'shopping_invalid'); }), expectedVersion = state.version;
    return response(await apiRequest(ENDPOINT, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion, state: next }) }));
  });
}

export function consumeBuyerOrder(orderId) {
  if (typeof orderId !== 'string' || !ORDER_ID.test(orderId)) return Promise.reject(new CloudError('请先确认一笔有效的云端模拟订单。', 400, 'order_invalid'));
  return enqueue(async () => response(await apiRequest(`${ENDPOINT}/consume-order`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderId, expectedVersion: state.version })
  }), true));
}
