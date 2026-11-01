import { apiRequest, getCloudState, managementScopeKey, CloudError } from './cloud-client.js';

// Merchant records are private cloud data. Never persist them in browser storage.
function adminScope() {
  const cloud = getCloudState();
  if (cloud.mode !== 'cloud' || cloud.error || cloud.session?.role !== 'admin' || cloud.session?.canManage !== true || !cloud.session?.user) throw new CloudError('商家账号需要云端管理员登录后管理。', 403, 'FORBIDDEN');
  return managementScopeKey();
}
async function request(path, options) {
  const scope = adminScope();
  const data = await apiRequest(path, options);
  if (adminScope() !== scope) throw new CloudError('登录账号或权限已变化，请重新读取商家资料。', 409, 'account_changed');
  return data;
}
const endpoint = id => `/api/v1/admin/merchants/${encodeURIComponent(id)}`;
export async function loadMerchants() {
  const data = await request('/api/v1/admin/merchants');
  if (!Array.isArray(data.merchants) || data.merchants.length > 200) throw new CloudError('商家列表格式异常，请重新读取。', 0, 'INVALID_RESPONSE');
  return data;
}
export async function loadMerchant(id) { return (await request(endpoint(id))).merchant; }
export async function saveMerchant(input, { id = '', expectedVersion } = {}) {
  const body = { name: input.name, email: input.email, region: input.region, permissions: input.permissions, status: input.status, ...(id ? { expectedVersion } : {}) };
  return (await request(id ? endpoint(id) : '/api/v1/admin/merchants', { method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).merchant;
}
export async function loadMerchantAudit(id) {
  const data = await request(`${endpoint(id)}/audit`);
  if (!Array.isArray(data.events)) throw new CloudError('操作记录格式异常，请重新读取。', 0, 'INVALID_RESPONSE');
  return data.events;
}
