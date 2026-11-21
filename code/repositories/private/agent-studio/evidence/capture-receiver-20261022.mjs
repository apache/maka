import http from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const stage = resolve(root, 'capture-20261022');
await mkdir(stage, { recursive: true });
// ponytail: 独立本机接收器只落盘已净化业务JSON，不接收或代理认证信息。
http.createServer(async (req, res) => {
  const headers = {'Access-Control-Allow-Origin':'https://itest.clife.net', 'Access-Control-Allow-Methods':'GET,POST,OPTIONS', 'Access-Control-Allow-Headers':'Content-Type', 'Access-Control-Allow-Private-Network':'true', 'Cache-Control':'no-store'};
  try {
    const url = new URL(req.url, 'http://127.0.0.1:4174');
    if (req.method === 'OPTIONS') { res.writeHead(204, headers); return res.end(); }
    if (req.method === 'GET' && url.pathname === '/collector.js') {
      res.writeHead(200, {...headers,'Content-Type':'text/javascript;charset=utf-8'});
      return res.end(await readFile(resolve(root, 'capture-browser-20261022.js')));
    }
    const match = /^\/capture\/([a-zA-Z0-9._-]+\.json)$/.exec(url.pathname);
    if (!match) { res.writeHead(404, headers); return res.end(); }
    const target = resolve(stage, match[1]);
    if (!target.startsWith(stage + sep)) throw new Error('Invalid path');
    if (req.method === 'GET') {
      const body = await readFile(target);
      res.writeHead(200, {...headers,'Content-Type':'application/json;charset=utf-8'});
      return res.end(body);
    }
    if (req.method !== 'POST') { res.writeHead(405, headers); return res.end(); }
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (Buffer.byteLength(body) > 80 * 1024 * 1024) throw new Error('Capture too large');
    }
    const value = JSON.parse(body);
    await writeFile(target + '.partial', JSON.stringify(value, null, 2));
    const { rename } = await import('node:fs/promises');
    await rename(target + '.partial', target);
    res.writeHead(200, {...headers,'Content-Type':'application/json'});
    res.end(JSON.stringify({saved:match[1], bytes:(await stat(target)).size}));
  } catch (error) {
    res.writeHead(error.code === 'ENOENT' ? 404 : 400, {...headers,'Content-Type':'application/json'});
    res.end(JSON.stringify({error:error.message}));
  }
}).listen(4174, '127.0.0.1', () => console.log('Sanitized capture receiver: http://127.0.0.1:4174'));
