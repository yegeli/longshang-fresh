import { createServer } from 'node:http';
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_ROOT = fileURLToPath(new URL('../dist/', import.meta.url));
const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'], ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'], ['.txt', 'text/plain; charset=utf-8'],
  ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'],
  ['.webp', 'image/webp'], ['.gif', 'image/gif'], ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'], ['.mp4', 'video/mp4'], ['.webm', 'video/webm'],
  ['.woff', 'font/woff'], ['.woff2', 'font/woff2']
]);
const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store'
};

// HOST accepts localhost or an IPv4/IPv6 literal (no URL, brackets or DNS name).
// PORT accepts a decimal integer from 1 to 65535; port 0 is reserved for tests.
export function readListenOptions(env = process.env) {
  const host = env.HOST ?? '127.0.0.1';
  const portText = env.PORT ?? '5173';
  if (typeof host !== 'string' || (host !== 'localhost' && !isIP(host))) {
    throw new Error('HOST must be localhost or a valid IPv4/IPv6 address, without brackets.');
  }
  if (typeof portText !== 'string' || !/^\d{1,5}$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) {
    throw new Error('PORT must be a decimal integer from 1 to 65535.');
  }
  return { host, port: Number(portText) };
}

function withinRoot(root, path) {
  const child = relative(root, path);
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function reply(req, res, status, message, headers = {}) {
  const body = Buffer.from(`${message}\n`);
  res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length, ...headers });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function requestPath(target) {
  // Do not run the URL parser first: it normalizes dot segments before we can reject them.
  if (typeof target !== 'string' || !target.startsWith('/') || target.startsWith('//')) return { status: 400 };
  let path;
  try { path = decodeURIComponent(target.split('?')[0]); } catch { return { status: 400 }; }
  if (/[\u0000-\u001f\u007f\\#]/u.test(path)) return { status: 400 };
  const segments = path.split('/');
  if (segments.some(segment => segment === '.' || segment === '..')) return { status: 403 };
  if (segments.some(segment => segment.startsWith('.'))) return { status: 404 };
  if (path === '/') path = '/index.html';
  if (path === '/admin') path = '/admin.html';
  return { path };
}

function byteRange(header, size) {
  if (!header || !/^bytes=/i.test(header) || header.includes(',')) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header);
  if (!match || (!match[1] && !match[2]) || size === 0) return false;
  // BigInt avoids precision loss for client-supplied offsets beyond Number.MAX_SAFE_INTEGER.
  const length = BigInt(size);
  let start, end;
  if (!match[1]) {
    const suffix = BigInt(match[2]);
    if (suffix === 0n) return false;
    start = suffix >= length ? 0n : length - suffix;
    end = length - 1n;
  } else {
    start = BigInt(match[1]);
    end = match[2] ? BigInt(match[2]) : length - 1n;
    if (start >= length || end < start) return false;
    if (end >= length) end = length - 1n;
  }
  return { start: Number(start), end: Number(end) };
}

async function serve(req, res, root) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    req.resume();
    reply(req, res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
    return;
  }
  const requested = requestPath(req.url);
  if (requested.status) {
    reply(req, res, requested.status, requested.status === 400 ? 'Bad request' : 'Not found');
    return;
  }
  const candidate = resolve(root, `.${requested.path}`);
  if (!withinRoot(root, candidate)) {
    reply(req, res, 403, 'Not found');
    return;
  }

  let file;
  try {
    const canonical = await realpath(candidate);
    if (!withinRoot(root, canonical)) {
      reply(req, res, 403, 'Not found');
      return;
    }
    file = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = await file.stat();
    if (!info.isFile() || !Number.isSafeInteger(info.size)) {
      reply(req, res, 404, 'Not found');
      return;
    }
    // Range only applies to GET; HEAD always describes the full representation.
    // Multi-range and unknown units are ignored, as permitted by HTTP semantics.
    // Without validators, an If-Range condition cannot match this representation.
    const range = req.method === 'GET' && !req.headers['if-range'] ? byteRange(req.headers.range, info.size) : null;
    if (range === false) {
      reply(req, res, 416, 'Range not satisfiable', { 'Content-Range': `bytes */${info.size}`, 'Accept-Ranges': 'bytes' });
      return;
    }
    const headers = {
      ...BASE_HEADERS,
      'Content-Type': MIME.get(extname(requested.path).toLowerCase()) ?? 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Content-Length': range ? range.end - range.start + 1 : info.size
    };
    if (range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${info.size}`;
    res.writeHead(range ? 206 : 200, headers);
    if (req.method === 'HEAD' || info.size === 0) res.end();
    else await pipeline(file.createReadStream({ ...(range ?? {}), autoClose: false }), res);
  } catch (error) {
    if (res.headersSent) res.destroy();
    else reply(req, res, ['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES', 'EPERM'].includes(error.code) ? 404 : 500, 'Not found');
  } finally {
    if (file) await file.close().catch(() => {});
  }
}

export async function createStaticServer({ root = DEFAULT_ROOT } = {}) {
  const publicRoot = await realpath(root);
  if (!(await stat(publicRoot)).isDirectory()) throw new Error('Static root must be a directory.');
  const server = createServer((req, res) => {
    serve(req, res, publicRoot).catch(() => res.destroy());
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or newer is required.');
  const options = readListenOptions();
  const server = await createStaticServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(options, () => { server.off('error', reject); resolveListen(); });
  });
  const displayHost = isIP(options.host) === 6 ? `[${options.host}]` : options.host;
  console.log(`Longshang Fresh: http://${displayHost}:${options.port}`);
  console.log('HOST: localhost or IPv4/IPv6 address; PORT: 1–65535. Press Ctrl+C to stop.');
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    const timer = setTimeout(() => server.closeAllConnections(), 5_000);
    timer.unref();
    server.close(() => clearTimeout(timer));
    server.closeIdleConnections();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(`Cannot start server: ${error.message}`); process.exitCode = 1; });
}
