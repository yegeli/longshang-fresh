import { apiRequest, getCloudState, managementScopeKey, requirePermission, requireUnchangedScope, CloudError } from './cloud-client.js';

// Inventory is authoritative cloud data; neither public counts nor private history
// are written to localStorage or copied into editable catalog product records.
function cloudOnly() {
  if (getCloudState().mode !== 'cloud') throw new CloudError('库存与批次管理需要连接云端。', 403, 'FORBIDDEN');
}
function productScope() { cloudOnly(); requirePermission('products'); return managementScopeKey(); }
function validInventory(value) {
  return value && typeof value === 'object' && typeof value.productId === 'string' && typeof value.configured === 'boolean'
    && value.stocks && ['small', 'family'].every(key => Number.isSafeInteger(value.stocks[key]) && value.stocks[key] >= 0)
    && Number.isSafeInteger(value.version) && value.version >= 0
    && ['batchId', 'batchCode', 'harvestDate', 'note'].every(key => typeof value[key] === 'string');
}
function inventory(value) {
  if (!validInventory(value)) throw new CloudError('库存资料格式异常，请重新读取。', 0, 'INVALID_RESPONSE');
  return value;
}
const endpoint = productId => `/api/v1/admin/inventory/${encodeURIComponent(productId)}`;
export async function loadInventories({ admin = false } = {}) {
  cloudOnly();
  const scope = admin ? productScope() : null;
  const data = await apiRequest(`/api/v1/${admin ? 'admin/' : ''}inventory`);
  if (admin) { requirePermission('products'); requireUnchangedScope(scope); }
  if (!Array.isArray(data.inventories) || data.inventories.length > 200 || new Set(data.inventories.map(value => value?.productId)).size !== data.inventories.length) throw new CloudError('库存列表格式异常，请重新读取。', 0, 'INVALID_RESPONSE');
  data.inventories.forEach(inventory);
  return data;
}
export async function saveInventory(productId, input, { expectedVersion } = {}) {
  const scope = productScope();
  const body = { expectedVersion, stocks: { small: input.stocks.small, family: input.stocks.family }, batchCode: input.batchCode, harvestDate: input.harvestDate, note: input.note, reason: input.reason };
  const data = await apiRequest(endpoint(productId), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  requirePermission('products'); requireUnchangedScope(scope);
  return inventory(data.inventory);
}
export async function loadInventoryHistory(productId) {
  const scope = productScope();
  const data = await apiRequest(`${endpoint(productId)}/history`);
  requirePermission('products'); requireUnchangedScope(scope);
  if (!Array.isArray(data.events) || data.events.length > 50) throw new CloudError('库存记录格式异常，请重新读取。', 0, 'INVALID_RESPONSE');
  return data.events;
}
