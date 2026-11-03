/**
 * HTTP + WebSocket server. Serves the built HUD (dist/) and exposes the HUD
 * protocol at /ws, backed by either an AgentSession (mock or any LLM provider)
 * or the OpenAI Realtime relay.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { parseClientEvent, type ServerEvent } from '../src/protocol.js';
import { AgentSession } from './session.js';
import { RealtimeRelay } from './relay.js';
import { createProvider, type ProviderConfig } from './providers.js';
import { createTools } from './tools.js';

export type BackendMode = 'agent' | 'realtime';

export interface ServerOptions {
  port: number;
  host?: string;
  mode: BackendMode;
  provider?: ProviderConfig;
  realtime?: { apiKey: string; model?: string; voice?: string };
  /** Directory with the built HUD. If missing, only /ws and /health are served. */
  staticDir?: string;
  systemPrompt?: string;
  log?: (msg: string) => void;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

/** Resolve a URL path to a file inside root, refusing traversal. Exported for tests. */
export function resolveStatic(root: string, urlPath: string): string | null {
  let p: string;
  try {
    p = decodeURIComponent(urlPath.split('?')[0] ?? '/');
  } catch {
    return null;
  }
  if (p.includes('\0')) return null;
  const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
  const full = path.resolve(root, rel);
  const base = path.resolve(root);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}

export function startServer(opts: ServerOptions): Promise<{ server: http.Server; port: number; close(): Promise<void> }> {
  const log = opts.log ?? ((m: string) => console.log(m));
  // Validate configuration once up front so errors surface at startup.
  const provider = opts.mode === 'agent' ? createProvider(opts.provider ?? { provider: 'mock' }) : null;
  if (opts.mode === 'realtime' && !opts.realtime?.apiKey) {
    throw new Error('OPENAI_API_KEY is required for realtime mode');
  }

  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, mode: opts.mode, provider: provider?.id ?? 'openai-realtime' }));
      return;
    }
    if (!opts.staticDir || !fs.existsSync(opts.staticDir)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('HUD build not found. Run "npm run build" or use "npm run dev".');
      return;
    }
    let file = resolveStatic(opts.staticDir, url);
    if (!file) {
      res.writeHead(400).end();
      return;
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(opts.staticDir, 'index.html');
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
    });
    fs.createReadStream(file).pipe(res);
  });

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 2 * 1024 * 1024 });
  wss.on('connection', (socket: WebSocket) => {
    const emit = (ev: ServerEvent) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(ev));
    };
    const tools = createTools();
    let handler: { handle(ev: ReturnType<typeof parseClientEvent> & object): unknown; close?(): void };
    if (opts.mode === 'realtime') {
      handler = new RealtimeRelay({ ...opts.realtime!, tools, emit, instructions: opts.systemPrompt });
    } else {
      const session = new AgentSession({ provider: provider!, tools, emit, systemPrompt: opts.systemPrompt });
      session.start();
      handler = session;
    }
    log(`[jarvis-hud] client connected (${opts.mode})`);
    socket.on('message', (data) => {
      const ev = parseClientEvent(String(data));
      if (!ev) {
        emit({ type: 'error', message: 'Malformed client message' });
        return;
      }
      void handler.handle(ev);
    });
    socket.on('close', () => handler.close?.());
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host ?? '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port;
      resolve({
        server,
        port,
        close: () =>
          new Promise<void>((r) => {
            for (const c of wss.clients) c.terminate();
            wss.close();
            server.close(() => r());
          }),
      });
    });
  });
}
