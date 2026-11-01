import { handleApi } from '../server/cloud-api.js';

// Separate deployment: this public API does not inherit the private Sites
// dispatch gate. Authentication always uses server-verified WeChat sessions.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1','localhost'].includes(url.hostname))) return new Response('HTTPS required', { status: 400, headers: { 'Cache-Control': 'no-store' } });
    if (!url.pathname.startsWith('/api/v1/')) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
    const headers = new Headers(request.headers);
    for (const key of [...headers.keys()]) if (key.toLowerCase().startsWith('oai-authenticated-')) headers.delete(key);
    const response = await handleApi(new Request(request, { headers }), { ...env, AUTH_MODE: 'wechat' });
    const result = new Response(response.body, response);
    result.headers.set('Vary', 'Authorization');
    return result;
  }
};
