import http from 'node:http';
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishDrill, drillBundle } from './lib/drill.mjs';

export async function createDrillServer({ directory = '.drill-state', port = 8788 } = {}) {
  await mkdir(directory, { recursive: true });
  const keyPath = path.join(directory, 'private-key.pem');
  let privateKey;
  try { privateKey = createPrivateKey(await readFile(keyPath)); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (await readFile(path.join(directory, 'state.json')).then(() => true, e => { if (e.code !== 'ENOENT') throw e; return false; })) throw new Error('演練帳本存在但金鑰遺失，請使用新的演練資料夾');
    privateKey = generateKeyPairSync('ed25519').privateKey;
    await writeFile(keyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }), { flag: 'wx', mode: 0o600 });
  }
  const publicKey = createPublicKey(privateKey);
  let state;
  try { state = JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; state = { version: 0, events: [] }; }
  let queue = Promise.resolve();
  const server = http.createServer(async (req, res) => {
    const origin = `http://${req.headers.host}`;
    const expected = new Set([`127.0.0.1:${server.address().port}`, `localhost:${server.address().port}`]);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    if (!expected.has(req.headers.host)) return send(403, { error: '僅允許本機存取' });
    try {
      if (req.method === 'GET' && req.url === '/favicon.ico') { res.writeHead(204); return res.end(); }
      if (req.method === 'GET' && req.url === '/api/state') return send(200, { ...state, exercise: true });
      if (req.method === 'GET' && req.url === '/api/bundle') return send(200, drillBundle(state, privateKey, publicKey));
      if (req.method === 'POST' && req.url === '/api/events') {
        if (req.headers.origin !== origin || req.headers['x-drill-console'] !== '1' || !req.headers['content-type']?.startsWith('application/json')) return send(403, { error: '請從本機演練介面發布' });
        const parts = []; let size = 0;
        for await (const part of req) { size += part.length; if (size > 16384) return send(413, { error: '資料過大' }); parts.push(part); }
        const input = JSON.parse(Buffer.concat(parts).toString('utf8'));
        const operation = queue.then(async () => {
          const next = publishDrill(state, input, privateKey);
          const tmp = path.join(directory, 'state.json.tmp');
          await writeFile(tmp, JSON.stringify(next));
          await rename(tmp, path.join(directory, 'state.json'));
          state = next;
          return state;
        });
        queue = operation.catch(() => {});
        return send(201, await operation);
      }
      const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
      const file = files[req.url];
      if (req.method !== 'GET' || !file) return send(404, { error: '找不到頁面' });
      res.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8` });
      res.end(await readFile(new URL(`./drill-ui/${file[0]}`, import.meta.url)));
    } catch (error) { if (!res.headersSent) send(400, { error: error.message }); else res.end(); }
  });
  server.requestTimeout = 10000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await createDrillServer();
  console.log(`演練工作台：http://127.0.0.1:${server.address().port}（演練資料，非政府公告）`);
}
