// Explicit mode discovery: only the static server's marked 404 enables local demo mode.
const state = { mode: 'uninitialized', session: null, error: '', lastSyncedAt: '' };
let initialization;
let sessionGeneration = 0;
const MANAGEMENT_PERMISSIONS = ['products', 'orders', 'aftersales'];

export class CloudError extends Error {
  constructor(message, status = 0, code = '') { super(message); this.name = 'CloudError'; this.status = status; this.code = code; }
}
export function getCloudState() { return { ...state, session: state.session ? structuredClone(state.session) : null }; }
export function isCloudMode() { return state.mode === 'cloud'; }
export function markCloudSynced(value = new Date().toISOString()) { state.lastSyncedAt = value || new Date().toISOString(); state.error = ''; }
export function requireManager() {
  if (state.mode === 'cloud' && (!state.session?.user || state.session.canManage !== true || state.error)) throw new CloudError('请先登录有管理权限的账户，再重新读取。', 403, 'FORBIDDEN');
}
export function hasPermission(name) {
  if (!MANAGEMENT_PERMISSIONS.includes(name)) return false;
  if (state.mode === 'local') return true;
  const session = state.session;
  return state.mode === 'cloud' && !state.error && !!session?.user && session.canManage === true
    && (session.role === 'admin' || (session.role === 'merchant' && session.permissions?.includes(name)));
}
export function requirePermission(name) {
  requireManager();
  if (!hasPermission(name)) throw new CloudError('当前账号没有此项管理权限，请联系管理员。', 403, 'permission_denied');
}
export function managementScopeKey() {
  const session = state.session;
  return JSON.stringify([state.mode, session?.user?.id || '', session?.role || '', session?.canManage === true,
    MANAGEMENT_PERMISSIONS.filter(hasPermission), session?.merchant?.id || '', session?.merchant?.status || '', session?.merchant?.version ?? 0, !!state.error]);
}
export function requireUnchangedScope(scope) {
  if (scope !== managementScopeKey()) throw new CloudError('账号或管理权限已变化，请重新读取后操作。', 409, 'account_changed');
}
export function authHref(value) {
  if (typeof value !== 'string' || !value) return '';
  try { const url = new URL(value, globalThis.location?.origin || 'http://localhost'); return ['http:', 'https:'].includes(url.protocol) ? value : ''; } catch { return ''; }
}
async function responseData(response) {
  let data;
  try { data = await response.json(); } catch { throw new CloudError('云端响应格式异常，请稍后重新读取。', response.status, 'INVALID_RESPONSE'); }
  if (!response.ok) throw new CloudError(data?.error?.message || data?.message || `云端请求未完成（${response.status}）`, response.status, data?.error?.code || 'REQUEST_FAILED');
  return data;
}
export async function apiRequest(path, options = {}) {
  if (typeof path !== 'string' || !path.startsWith('/api/v1/')) throw new CloudError('无效的云端接口地址');
  let response;
  try { response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options }); }
  catch { throw new CloudError('无法连接云端，请检查网络后重试；没有切换到本机演示。', 0, 'NETWORK_ERROR'); }
  return responseData(response);
}
export async function initializeCloudMode({ force = false } = {}) {
  if (!force && initialization) return initialization;
  const wasCloud = state.mode === 'cloud';
  const generation = ++sessionGeneration;
  const current = () => { if (generation !== sessionGeneration) throw new CloudError('登录状态已由较新的请求更新。', 409, 'session_superseded'); };
  const task = (async () => {
    let response;
    try { response = await fetch('/api/v1/session', { credentials: 'same-origin', cache: 'no-store' }); }
    catch { current(); state.mode = 'cloud'; state.session = null; state.error = '无法连接云端，请检查网络后重试。'; throw new CloudError(state.error, 0, 'NETWORK_ERROR'); }
    current();
    if (response.status === 404 && !wasCloud) {
      let marker; try { marker = await response.json(); } catch { /* An unmarked 404 must fail closed. */ }
      current();
      if (marker?.mode === 'local-demo') { state.mode = 'local'; state.session = null; state.error = ''; return getCloudState(); }
      state.mode = 'cloud'; state.session = null; state.error = '云端登录接口不可用，未切换到本机演示。';
      throw new CloudError(state.error, 404, 'SESSION_UNAVAILABLE');
    }
    state.mode = 'cloud';
    try {
      const session = await responseData(response);
      current();
      if (!session || !Object.hasOwn(session, 'user') || typeof session.canManage !== 'boolean' || (session.user !== null && (typeof session.user !== 'object' || typeof session.user.id !== 'string' || !session.user.id))) throw new CloudError('登录状态响应异常，请重新登录。', 0, 'INVALID_SESSION');
      if (session.permissions !== undefined && (!Array.isArray(session.permissions) || session.permissions.some(name => !MANAGEMENT_PERMISSIONS.includes(name)) || new Set(session.permissions).size !== session.permissions.length)) throw new CloudError('管理权限响应异常，请重新登录。', 0, 'INVALID_SESSION');
      session.permissions = session.role === 'admin' ? [...MANAGEMENT_PERMISSIONS] : session.role === 'merchant' ? [...(session.permissions || [])] : [];
      if (session.role === 'merchant' && (!session.permissions.length || session.merchant?.status === 'disabled')) session.canManage = false;
      state.session = session; state.error = ''; return getCloudState();
    } catch (error) { current(); state.session = null; state.error = error.message; throw error; }
  })();
  initialization = task;
  try { return await task; } catch (error) { if (initialization === task) initialization = undefined; throw error; }
}
export function cloudMediaUrl(id) { return `/api/v1/media/${encodeURIComponent(id)}`; }
