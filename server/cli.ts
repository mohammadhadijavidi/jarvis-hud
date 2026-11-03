/**
 * jarvis-hud CLI
 *
 *   jarvis-hud mock    [--port 8787] [--open]   offline scripted backend (no API key)
 *   jarvis-hud serve   [--port 8787]            agent backend using JARVIS_PROVIDER (OpenAI-compatible, Anthropic, mock)
 *   jarvis-hud relay   [--port 8787]            OpenAI Realtime speech-to-speech relay (OPENAI_API_KEY)
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { startServer } from './server.js';
import { configFromEnv } from './providers.js';

function loadDotEnv(file: string): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]!] !== undefined) continue;
    process.env[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, '$2');
  }
}

function findRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  return start;
}

const HELP = `jarvis-hud - cinematic HUD for voice AI assistants

Usage:
  jarvis-hud mock  [--port 8787] [--host 127.0.0.1] [--open]
  jarvis-hud serve [--port 8787] [--host 127.0.0.1] [--open]
  jarvis-hud relay [--port 8787] [--host 127.0.0.1] [--open]

mock   Offline scripted backend. No API key. Responses are simulated.
serve  Agent backend. Set JARVIS_PROVIDER=openai|openrouter|groq|ollama|lmstudio|openai-compatible|anthropic|mock
relay  OpenAI Realtime speech-to-speech relay. Requires OPENAI_API_KEY.
`;

async function main(argv: string[]): Promise<void> {
  const [cmd = 'help', ...rest] = argv;
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(HELP);
    return;
  }
  const flag = (name: string) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const root = findRoot(path.dirname(fileURLToPath(import.meta.url)));
  loadDotEnv(path.join(process.cwd(), '.env'));
  const port = Number(flag('port') ?? process.env.PORT ?? 8787);
  const host = flag('host') ?? process.env.HOST ?? '127.0.0.1';
  const staticDir = path.join(root, 'dist');
  const systemPrompt = process.env.JARVIS_SYSTEM_PROMPT || undefined;

  let mode: 'agent' | 'realtime' = 'agent';
  let providerCfg = configFromEnv();
  if (cmd === 'mock') providerCfg = { provider: 'mock' };
  else if (cmd === 'relay') mode = 'realtime';
  else if (cmd !== 'serve') {
    process.stderr.write(`Unknown command "${cmd}"\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }

  const { port: actual } = await startServer({
    port,
    host,
    mode,
    provider: providerCfg,
    realtime:
      mode === 'realtime'
        ? {
            apiKey: process.env.OPENAI_API_KEY ?? '',
            model: process.env.OPENAI_REALTIME_MODEL,
            voice: process.env.OPENAI_REALTIME_VOICE,
          }
        : undefined,
    staticDir,
    systemPrompt,
  });
  const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${actual}`;
  const label = mode === 'realtime' ? 'OpenAI Realtime relay' : `agent backend, provider=${providerCfg.provider}`;
  console.log(`[jarvis-hud] ${label}`);
  console.log(`[jarvis-hud] HUD:       ${url}`);
  console.log(`[jarvis-hud] WebSocket: ${url.replace('http', 'ws')}/ws`);
  if (!fs.existsSync(staticDir)) console.log('[jarvis-hud] dist/ not found: run "npm run build" or "npm run dev".');
  if (rest.includes('--open')) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    spawn(opener, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).on('error', () => {});
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(`[jarvis-hud] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
