// Explicit mode discovery: only the static server's marked 404 enables local demo mode.
const state = { mode: 'uninitialized', session: null, error: '', lastSyncedAt: '' };
let initialization;

export class CloudError extends Error {
  constructor(message, status = 0, code = '') { super(message); this.name = 'CloudError'; this.status = status; this.code = code; }
}
export function getCloudState() { return { ...state, session: state.session ? { ...state.session } : null }; }
export function isCloudMode() { return state.mode === 'cloud'; }
export function markCloudSynced(value = new Date().toISOString()) { state.lastSyncedAt = value || new Date().toISOString(); state.error = ''; }
export function requireManager() {
  if (state.mode === 'cloud' && (!state.session?.user || state.session.canManage !== true || state.error)) throw new CloudError('请先登录有管理权限的账户，再重新读取。', 403, 'FORBIDDEN');
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
  initialization = (async () => {
    let response;
    try { response = await fetch('/api/v1/session', { credentials: 'same-origin', cache: 'no-store' }); }
    catch { state.mode = 'cloud'; state.session = null; state.error = '无法连接云端，请检查网络后重试。'; throw new CloudError(state.error, 0, 'NETWORK_ERROR'); }
    if (response.status === 404 && !wasCloud) {
      let marker; try { marker = await response.json(); } catch { /* An unmarked 404 must fail closed. */ }
      if (marker?.mode === 'local-demo') { state.mode = 'local'; state.session = null; state.error = ''; return getCloudState(); }
      state.mode = 'cloud'; state.session = null; state.error = '云端登录接口不可用，未切换到本机演示。';
      throw new CloudError(state.error, 404, 'SESSION_UNAVAILABLE');
    }
    state.mode = 'cloud';
    try {
      const session = await responseData(response);
      if (!session || !Object.hasOwn(session, 'user') || typeof session.canManage !== 'boolean' || (session.user !== null && (typeof session.user !== 'object' || typeof session.user.id !== 'string' || !session.user.id))) throw new CloudError('登录状态响应异常，请重新登录。', 0, 'INVALID_SESSION');
      state.session = session; state.error = ''; return getCloudState();
    } catch (error) { state.session = null; state.error = error.message; throw error; }
  })();
  try { return await initialization; } catch (error) { initialization = undefined; throw error; }
}
export function cloudMediaUrl(id) { return `/api/v1/media/${encodeURIComponent(id)}`; }
