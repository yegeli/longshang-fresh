import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createStaticServer, readListenOptions } from '../scripts/server.mjs';

function request(port, path, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    // A raw origin-form target deliberately avoids fetch/URL dot-segment normalization.
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers, agent: false }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.once('error', reject);
    });
    req.setTimeout(5_000, () => req.destroy(new Error('HTTP request timed out')));
    req.once('error', reject);
    req.end();
  });
}

async function listen(server, port = 0) {
  server.listen({ host: '127.0.0.1', port });
  await once(server, 'listening');
  return server.address().port;
}

async function close(server) {
  if (!server.listening) return;
  const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  server.closeAllConnections();
  await closed;
}

test('HOST/PORT defaults and documented configuration reject malformed addresses and out-of-range ports', () => {
  assert.deepEqual(readListenOptions({}), { host: '127.0.0.1', port: 5173 });
  for (const host of ['localhost', '0.0.0.0', '192.168.1.10', '::1', '::']) {
    assert.deepEqual(readListenOptions({ HOST: host, PORT: '65535' }), { host, port: 65535 });
  }
  assert.equal(readListenOptions({ PORT: '1' }).port, 1);
  for (const host of ['', 'http://localhost', 'example.com', '[::1]', '127.0.0.999', ' localhost']) {
    assert.throws(() => readListenOptions({ HOST: host }), /HOST/);
  }
  for (const port of ['', '0', '-1', '65536', '1.5', '5e3', ' 5173', '5173 ', 'abc']) {
    assert.throws(() => readListenOptions({ PORT: port }), /PORT/);
  }
});

test('the real application serves buyer/admin entry points and static assets', async t => {
  const server = await createStaticServer();
  t.after(() => close(server));
  const port = await listen(server);
  const index = await readFile(new URL('../public/index.html', import.meta.url));
  const admin = await readFile(new URL('../public/admin.html', import.meta.url));

  await t.test('entry aliases and query strings return the actual HTML, with safe MIME headers', async () => {
    for (const [path, expected] of [['/', index], ['/?v=4', index], ['/index.html', index], ['/admin', admin], ['/admin.html?v=4', admin]]) {
      const response = await request(port, path);
      assert.equal(response.status, 200, path);
      assert.deepEqual(response.body, expected, path);
      assert.equal(Number(response.headers['content-length']), expected.length);
      assert.equal(response.headers['content-type'], 'text/html; charset=utf-8');
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
    }
    const js = await request(port, '/app.js');
    assert.equal(js.status, 200);
    assert.equal(js.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.deepEqual(js.body, await readFile(new URL('../public/app.js', import.meta.url)));
    const css = await request(port, '/admin.css?v=4');
    assert.equal(css.status, 200);
    assert.equal(css.headers['content-type'], 'text/css; charset=utf-8');
    assert.equal((await request(port, '/assets/apples.jpg')).headers['content-type'], 'image/jpeg');
  });

  await t.test('missing resources and unsupported methods never return an HTML fallback', async () => {
    for (const path of ['/missing', '/assets/', '/package.json', '/scripts/server.mjs']) {
      const response = await request(port, path);
      assert.equal(response.status, 404, path);
      assert.equal(response.headers['content-type'], 'text/plain; charset=utf-8');
    }
    const response = await request(port, '/', { method: 'POST' });
    assert.equal(response.status, 405);
    assert.equal(response.headers.allow, 'GET, HEAD');
  });
});

test('owned binary fixtures exercise video MIME, HEAD and HTTP byte ranges without redistributing a media file', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'longshang-range-'));
  const movie = Buffer.from(Array.from({ length: 8192 }, (_, index) => index % 251));
  const index = Buffer.from('owned fixture home');
  await writeFile(join(directory, 'index.html'), index);
  // The .mp4 suffix tests HTTP MIME/range delivery; these owned bytes are not a playable video.
  await writeFile(join(directory, 'fixture.mp4'), movie);
  const server = await createStaticServer({ root: directory });
  t.after(async () => { await close(server); await rm(directory, { recursive: true, force: true }); });
  const port = await listen(server);

  await t.test('HEAD describes the full resource without a response body, including when Range is present', async () => {
    for (const [path, bytes, type] of [['/', index, 'text/html; charset=utf-8'], ['/fixture.mp4', movie, 'video/mp4']]) {
      const response = await request(port, path, { method: 'HEAD', headers: { Range: 'bytes=0-15' } });
      assert.equal(response.status, 200);
      assert.equal(response.body.length, 0);
      assert.equal(Number(response.headers['content-length']), bytes.length);
      assert.equal(response.headers['content-type'], type);
      assert.equal(response.headers['accept-ranges'], 'bytes');
      assert.equal(response.headers['content-range'], undefined);
    }
    const missing = await request(port, '/missing', { method: 'HEAD' });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.length, 0);
  });

  await t.test('closed, open-ended, suffix, and oversized-end Range requests return exact fixture bytes', async () => {
    const cases = [
      ['bytes=0-255', 0, 255], ['Bytes=1000-1063', 1000, 1063],
      [`bytes=${movie.length - 64}-`, movie.length - 64, movie.length - 1],
      ['bytes=-32', movie.length - 32, movie.length - 1],
      ['bytes=-999999999999999999999', 0, movie.length - 1],
      [`bytes=${movie.length - 10}-999999999999999999999`, movie.length - 10, movie.length - 1]
    ];
    for (const [range, start, end] of cases) {
      const response = await request(port, '/fixture.mp4', { headers: { Range: range } });
      assert.equal(response.status, 206, range);
      assert.equal(response.headers['content-type'], 'video/mp4');
      assert.equal(response.headers['content-range'], `bytes ${start}-${end}/${movie.length}`);
      assert.equal(Number(response.headers['content-length']), end - start + 1);
      assert.deepEqual(response.body, movie.subarray(start, end + 1));
    }
  });

  await t.test('unsatisfiable/invalid single byte ranges return 416 with the full file size', async () => {
    for (const range of [`bytes=${movie.length}-`, 'bytes=999999999999999999999-', 'bytes=9-1', 'bytes=-0', 'bytes=-', 'bytes=abc-def']) {
      const response = await request(port, '/fixture.mp4', { headers: { Range: range } });
      assert.equal(response.status, 416, range);
      assert.equal(response.headers['content-range'], `bytes */${movie.length}`);
      assert.notDeepEqual(response.body, movie);
    }
  });
});

test('raw URL traversal, malformed encodings, dotfiles and outside-root symlinks cannot expose a sibling secret', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'longshang-server-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'public');
  await mkdir(join(root, 'nested'), { recursive: true });
  const secret = 'outside-private-secret';
  await writeFile(join(directory, 'secret.txt'), secret);
  await writeFile(join(root, '.env'), 'hidden-private-secret');
  await writeFile(join(root, 'index.html'), 'fixture home');
  await writeFile(join(root, 'nested', 'hello world.txt'), 'decoded safe path');
  await writeFile(join(root, 'empty.mp4'), '');
  await writeFile(join(root, 'unknown.bin'), Buffer.from([0, 1, 2, 255]));
  await symlink(join(directory, 'secret.txt'), join(root, 'leak.txt'));
  await symlink(directory, join(root, 'escape'), 'dir');
  const server = await createStaticServer({ root });
  t.after(() => close(server));
  const port = await listen(server);

  const forbidden = [
    '/../secret.txt', '/%2e%2e/secret.txt', '/nested/../../secret.txt',
    '/nested/%2e%2e/%2e%2e/secret.txt', '/%2e%2e%2fsecret.txt',
    '/nested%2f..%2f..%2fsecret.txt', '/nested/./hello%20world.txt',
    '/leak.txt', '/escape/secret.txt'
  ];
  for (const path of forbidden) {
    const response = await request(port, path);
    assert.equal(response.status, 403, path);
    assert.ok(!response.body.toString().includes(secret), path);
    assert.ok(!response.body.toString().includes(directory), 'do not echo filesystem paths');
  }
  for (const path of ['/%', '/%zz', '/%c0%ae', '/%E0%A4%A', '/%00secret', '/%5c..%5csecret.txt', '//outside/secret.txt']) {
    const response = await request(port, path);
    assert.equal(response.status, 400, path);
    assert.ok(!response.body.toString().includes(secret));
  }
  for (const path of ['/.env', '/%2eenv', '/%252e%252e/secret.txt']) {
    const response = await request(port, path);
    assert.equal(response.status, 404, path);
    assert.ok(!response.body.toString().includes('private-secret'));
  }
  const decoded = await request(port, '/nested/hello%20world.txt?cache=1');
  assert.equal(decoded.status, 200);
  assert.equal(decoded.body.toString(), 'decoded safe path');
  assert.equal(decoded.headers['content-type'], 'text/plain; charset=utf-8');
  const unknown = await request(port, '/unknown.bin');
  assert.equal(unknown.headers['content-type'], 'application/octet-stream');
  assert.equal(unknown.headers['x-content-type-options'], 'nosniff');
  const empty = await request(port, '/empty.mp4');
  assert.equal(empty.status, 200);
  assert.equal(empty.body.length, 0);
  assert.equal((await request(port, '/empty.mp4', { headers: { Range: 'bytes=0-' } })).status, 416);

  for (const headers of [{ Range: 'items=0-1' }, { Range: 'bytes=0-0,2-2' }, { Range: 'bytes=0-1', 'If-Range': '"old-validator"' }]) {
    const response = await request(port, '/index.html', { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-range'], undefined);
    assert.equal(response.body.toString(), 'fixture home');
  }
  // A closed listener must release its port; no detached server is left after tests.
  await close(server);
  assert.equal(server.listening, false);
  const replacement = await createStaticServer({ root });
  t.after(() => close(replacement));
  assert.equal(await listen(replacement, port), port);
  assert.equal((await request(port, '/')).body.toString(), 'fixture home');
});

test('the CLI rejects bad configuration and exits instead of leaving a server running', async () => {
  const script = fileURLToPath(new URL('../scripts/server.mjs', import.meta.url));
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: '65536' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
  try {
    const [code, signal] = await once(child, 'exit');
    assert.equal(code, 1);
    assert.equal(signal, null);
    assert.match(stderr, /PORT must be a decimal integer from 1 to 65535/);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

test('the CLI honors HOST/PORT from another working directory and SIGTERM releases its listener', async () => {
  const reservation = await createStaticServer();
  const port = await listen(reservation);
  await close(reservation);
  const script = fileURLToPath(new URL('../scripts/server.mjs', import.meta.url));
  const child = spawn(process.execPath, [script], {
    cwd: tmpdir(),
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const exited = once(child, 'exit');
  let output = '', stderr = '', timer;
  child.stderr.on('data', data => { stderr += data; });
  const started = new Promise(resolve => child.stdout.on('data', data => {
    output += data;
    if (output.includes(`http://127.0.0.1:${port}`) && output.includes('PORT: 1–65535')) resolve();
  }));
  try {
    await Promise.race([
      started,
      exited.then(([code]) => { throw new Error(`CLI exited before listening (${code}): ${stderr}`); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('CLI startup timed out')), 5_000); })
    ]);
    clearTimeout(timer);
    assert.match(output, /PORT: 1–65535/);
    const response = await request(port, '/admin');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, await readFile(new URL('../public/admin.html', import.meta.url)));
    child.kill('SIGTERM');
    const shutdownTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    try {
      const [code, signal] = await exited;
      assert.equal(code, 0);
      assert.equal(signal, null);
    } finally { clearTimeout(shutdownTimer); }
    const replacement = await createStaticServer();
    try { assert.equal(await listen(replacement, port), port); } finally { await close(replacement); }
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited.catch(() => {});
  }
});

test('static demo advertises an explicit local-only session marker without a success response', async t => {
  const server = await createStaticServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await request(server.address().port, '/api/v1/session');
  assert.equal(response.status, 404);
  assert.match(response.headers['content-type'], /^application\/json/);
  assert.deepEqual(JSON.parse(response.body.toString()), { mode: 'local-demo' });
});
