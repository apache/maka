/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { createServer, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { AssistantWebError, type AssistantWebBackend } from './assistant-web-backend.js';

/** Opt-in web chat. Public access requires an authenticated reverse proxy. */
export async function startAssistantWebServer(options: {
  backend: AssistantWebBackend;
  assets: string;
  port: number;
  host?: string;
  publicOrigin?: string;
  onError?: (error: unknown) => void;
}) {
  const bindHost = options.host ?? '127.0.0.1';
  const publicUrl = options.publicOrigin ? new URL(options.publicOrigin) : undefined;
  if (publicUrl && (!['http:', 'https:'].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password))
    throw new Error('Assistant web origin must be an HTTP(S) origin without credentials');
  const publicOrigin = publicUrl?.origin;
  if (!['127.0.0.1', '::1', 'localhost'].includes(bindHost))
    throw new Error('Assistant web must bind to loopback; use an authenticated reverse proxy for remote access');
  const streams = new Set<ServerResponse>();
  let stopped = false;
  let lastState = '';
  let polling = false;
  const json = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(value));
  };
  const server = createServer(async (req, res) => {
    try {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : options.port;
      const localOrigins = ['127.0.0.1', 'localhost', '[::1]'].map((host) => new URL(`http://${host}:${port}`));
      const allowedHosts = new Set([...localOrigins.map((url) => url.host), ...(publicUrl ? [publicUrl.host] : [])]);
      const allowedOrigins = new Set([...localOrigins.map((url) => url.origin), ...(publicOrigin ? [publicOrigin] : [])]);
      // Host must be independently trusted: comparing Origin to the supplied Host
      // alone allows both headers to agree on a DNS-rebinding attacker's domain.
      if (!req.headers.host || !allowedHosts.has(req.headers.host.toLowerCase()))
        throw new AssistantWebError(403, '不允许的访问地址');
      if (!req.url?.startsWith('/') || req.url.startsWith('//'))
        throw new AssistantWebError(400, '无效的请求地址');
      const url = new URL(req.url, `http://${req.headers.host}`);
      // Do not let an unrelated website submit messages to a locally running assistant.
      if (
        req.headers.origin &&
        !allowedOrigins.has(req.headers.origin)
      )
        throw new AssistantWebError(403, '仅支持同源访问');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      if (url.pathname === '/api/events' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write('retry: 1500\n\n');
        streams.add(res);
        if (lastState) res.write(`data: ${lastState}\n\n`);
        req.on('close', () => streams.delete(res));
        void poll();
        return;
      }
      if (url.pathname === '/api/avatar' && req.method === 'GET') {
        const avatar = await options.backend.avatarImage(
          url.searchParams.get('conversationId') ?? '',
          url.searchParams.get('id') ?? '',
        );
        res.writeHead(200, {
          'Content-Type': avatar.mimeType,
          'Cache-Control': 'private, no-cache',
        });
        res.end(avatar.bytes);
        return;
      }
      if (url.pathname === '/api/history' && req.method === 'GET')
        return json(res, 200, await options.backend.history(url.searchParams));
      if (url.pathname === '/api/messages' && req.method === 'POST') {
        if (!req.headers['content-type']?.startsWith('application/json'))
          throw new AssistantWebError(415, '需要 JSON 请求');
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 128 * 1024) throw new AssistantWebError(413, '消息太长，请分段发送');
          chunks.push(Buffer.from(chunk));
        }
        let input: { id?: unknown; text?: unknown; conversationId?: unknown };
        try {
          input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          throw new AssistantWebError(400, '无效的消息');
        }
        if (
          !input ||
          typeof input.id !== 'string' ||
          !/^[a-zA-Z0-9-]{16,80}$/.test(input.id) ||
          typeof input.conversationId !== 'string' ||
          input.conversationId.length > 512 ||
          typeof input.text !== 'string' ||
          !input.text.trim() ||
          input.text.length > 32000
        )
          throw new AssistantWebError(400, '消息内容无效或过长');
        await options.backend.send(input as { id: string; text: string; conversationId: string });
        json(res, 200, { accepted: true });
        void poll();
        return;
      }
      if (url.pathname.startsWith('/api/')) throw new AssistantWebError(404, '接口不存在');
      if (req.method !== 'GET' && req.method !== 'HEAD')
        throw new AssistantWebError(405, '不支持的请求');
      const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
      const path = resolve(options.assets, `.${relative}`);
      if (!path.startsWith(resolve(options.assets) + sep))
        throw new AssistantWebError(404, '文件不存在');
      let body: Buffer;
      try {
        body = await readFile(path);
      } catch {
        throw new AssistantWebError(404, '页面尚未构建或文件不存在');
      }
      const types: Record<string, string> = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.woff2': 'font/woff2',
        '.woff': 'font/woff',
        '.ttf': 'font/ttf',
      };
      res.writeHead(200, {
        'Content-Type': types[extname(path)] ?? 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (error) {
      if (!(error instanceof AssistantWebError)) options.onError?.(error);
      if (!res.headersSent)
        json(res, error instanceof AssistantWebError ? error.status : 503, {
          error:
            error instanceof AssistantWebError ? error.message : '助手连接暂不可用，请稍后重试',
        });
      else res.end();
    }
  });
  async function poll() {
    if (polling || stopped || !streams.size) return;
    polling = true;
    try {
      let payload: unknown;
      try {
        payload = { state: await options.backend.state() };
      } catch (error) {
        payload = {
          error: error instanceof AssistantWebError ? error.message : '助手连接暂不可用，正在重连',
        };
      }
      const encoded = JSON.stringify(payload);
      const changed = lastState !== encoded;
      lastState = encoded;
      for (const stream of streams) {
        if (!stream.write(changed ? `data: ${encoded}\n\n` : ': keepalive\n\n')) {
          streams.delete(stream);
          stream.end();
        }
      }
    } finally {
      polling = false;
    }
  }
  const timer = setInterval(() => void poll(), 1000);
  timer.unref();
  try {
    await new Promise<void>((done, reject) => {
      server.once('error', reject);
      server.listen(options.port, options.host ?? '127.0.0.1', () => {
        server.off('error', reject);
        done();
      });
    });
  } catch (error) {
    clearInterval(timer);
    await options.backend.close();
    throw error;
  }
  const address = server.address();
  return {
    port: typeof address === 'object' && address ? address.port : options.port,
    async close() {
      stopped = true;
      clearInterval(timer);
      for (const stream of streams) stream.end();
      streams.clear();
      await Promise.all([
        options.backend.close(),
        new Promise<void>((done, reject) => {
          server.close((error) => (error ? reject(error) : done()));
          server.closeAllConnections();
        }),
      ]);
    },
  };
}
