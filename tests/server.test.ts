import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import path from 'node:path';
import { calculate, createTools } from '../server/tools';
import { planTools, mockChat } from '../server/mock';
import { AgentSession } from '../server/session';
import { createProvider, configFromEnv, toAnthropicMessages, toOpenAIMessages, type FetchLike } from '../server/providers';
import { resolveStatic, startServer } from '../server/server';
import type { ServerEvent } from '../src/protocol';

describe('calculate', () => {
  it('respects precedence, parentheses, unary minus and power', () => {
    expect(calculate('2 + 3 * 4')).toBe(14);
    expect(calculate('(2 + 3) * 4')).toBe(20);
    expect(calculate('-3 + 5')).toBe(2);
    expect(calculate('2^10')).toBe(1024);
    expect(calculate('4250 * 0.18 + 1299')).toBe(2064);
    expect(calculate('10 % 4')).toBe(2);
    expect(calculate('3 x 4')).toBe(12);
  });
  it('rejects unsafe or invalid input', () => {
    expect(() => calculate('process.exit()')).toThrow();
    expect(() => calculate('1/0')).toThrow('Division by zero');
    expect(() => calculate('1..2')).toThrow();
    expect(() => calculate('')).toThrow();
    expect(() => calculate('(1+2')).toThrow();
  });
});

describe('tools', () => {
  const fixed = { now: () => new Date('2026-01-15T08:30:00Z') };
  it('get_time honours time zones', async () => {
    const t = createTools(fixed).find((x) => x.name === 'get_time')!;
    const r = (await t.run({ timezone: 'Asia/Dubai' })) as { local: string; iso: string };
    expect(r.local).toContain('12:30');
    expect(r.iso).toBe('2026-01-15T08:30:00.000Z');
    expect(() => t.run({ timezone: 'Mars/Olympus' })).toThrow(/Unknown time zone/);
  });
  it('system_status reports real numbers', async () => {
    const r = (await createTools().find((x) => x.name === 'system_status')!.run({})) as Record<string, number>;
    expect(r.memory_used_pct).toBeGreaterThan(0);
    expect(r.memory_used_pct).toBeLessThanOrEqual(100);
  });
  it('save_note accumulates per tool set', async () => {
    const t = createTools().find((x) => x.name === 'save_note')!;
    await t.run({ text: 'one' });
    expect(await t.run({ text: 'two' })).toEqual({ saved: 'two', total: 2 });
    expect(() => t.run({ text: ' ' })).toThrow();
  });
});

describe('mock provider', () => {
  it('plans tools from keywords', () => {
    expect(planTools('what time is it in Tokyo').map((c) => [c.name, c.args])).toEqual([['get_time', { timezone: 'Asia/Tokyo' }]]);
    expect(planTools('what is 12 * 3?')[0]).toMatchObject({ name: 'calculate', args: { expression: '12 * 3' } });
    expect(planTools('run diagnostics')[0]!.name).toBe('system_status');
    expect(planTools('remember that the demo is Thursday.')[0]).toMatchObject({ name: 'save_note', args: { text: 'the demo is Thursday' } });
    expect(planTools('tell me a joke')).toEqual([]);
  });
  it('phrases replies from tool results', () => {
    const r = mockChat([
      { role: 'user', content: 'x' },
      { role: 'tool', toolCallId: '1', name: 'calculate', content: '{"expression":"6*7","result":42}' },
    ]);
    expect(r.text).toBe('6*7 comes to 42.');
  });
});

function collect() {
  const events: ServerEvent[] = [];
  return { events, emit: (e: ServerEvent) => events.push(e) };
}

describe('AgentSession', () => {
  it('runs a full turn with tool call, streamed answer and state changes', async () => {
    const { events, emit } = collect();
    const s = new AgentSession({ provider: createProvider({ provider: 'mock' }), tools: createTools(), emit, wordDelayMs: 0, thinkDelayMs: 0 });
    s.start();
    await s.handle({ type: 'user_text', text: 'what is 6 * 7' });
    const types = events.map((e) => (e.type === 'state' ? `state:${e.state}` : e.type));
    expect(types[0]).toBe('meta');
    expect(types).toContain('state:thinking');
    expect(types.indexOf('tool_call')).toBeLessThan(types.indexOf('tool_result'));
    expect(types.indexOf('tool_result')).toBeLessThan(types.indexOf('state:speaking'));
    expect(types[types.length - 1]).toBe('state:idle');
    const text = events
      .filter((e): e is Extract<ServerEvent, { type: 'transcript' }> => e.type === 'transcript' && e.role === 'assistant')
      .map((e) => e.text)
      .join('');
    expect(text).toBe('6 * 7 comes to 42.');
    expect(events.some((e) => e.type === 'level' && e.value > 0)).toBe(true);
    expect(events.find((e) => e.type === 'meta')).toMatchObject({ simulated: true });
  });

  it('reports tool errors as error cards and keeps going', async () => {
    const { events, emit } = collect();
    const s = new AgentSession({ provider: createProvider({ provider: 'mock' }), tools: createTools(), emit, wordDelayMs: 0, thinkDelayMs: 0 });
    await s.handle({ type: 'user_text', text: 'calculate 5 / 0 please' });
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_result', status: 'error', result: { error: 'Division by zero' } }));
    expect(events[events.length - 1]).toEqual({ type: 'state', state: 'idle' });
  });

  it('turns provider failures into error events', async () => {
    const { events, emit } = collect();
    const s = new AgentSession({
      provider: { id: 'x', model: 'm', simulated: false, chat: async () => Promise.reject(new Error('upstream 500')) },
      tools: [],
      emit,
      wordDelayMs: 0,
      thinkDelayMs: 0,
    });
    await s.handle({ type: 'user_text', text: 'hi' });
    expect(events).toContainEqual({ type: 'error', message: 'upstream 500' });
    expect(s.isBusy).toBe(false);
  });
});

describe('providers', () => {
  const fakeFetch = (reply: unknown, capture: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }>): FetchLike =>
    async (url, init) => {
      capture.push({ url, body: JSON.parse(init.body), headers: init.headers });
      return { ok: true, status: 200, json: async () => reply, text: async () => '' };
    };

  it('reads config from env with presets', () => {
    expect(configFromEnv({})).toMatchObject({ provider: 'mock' });
    expect(configFromEnv({ JARVIS_PROVIDER: 'groq', GROQ_API_KEY: 'g' })).toMatchObject({ provider: 'groq', apiKey: 'g' });
    expect(configFromEnv({ JARVIS_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'a', JARVIS_MODEL: 'm' })).toMatchObject({ apiKey: 'a', model: 'm' });
  });

  it('fails fast without keys or with unknown provider', () => {
    expect(() => createProvider({ provider: 'openai' })).toThrow(/OPENAI_API_KEY/);
    expect(() => createProvider({ provider: 'anthropic' })).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => createProvider({ provider: 'skynet' })).toThrow(/Unknown provider/);
    expect(createProvider({ provider: 'ollama' }).model).toBe('llama3.1');
  });

  it('openai-compatible: sends tools and parses tool_calls', async () => {
    const cap: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
    const p = createProvider({
      provider: 'openrouter',
      apiKey: 'k',
      fetch: fakeFetch(
        { choices: [{ message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'get_time', arguments: '{"timezone":"Asia/Tokyo"}' } }] } }] },
        cap,
      ),
    });
    const r = await p.chat([{ role: 'user', content: 'time?' }], createTools());
    expect(cap[0]!.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(cap[0]!.headers.authorization).toBe('Bearer k');
    expect((cap[0]!.body.tools as unknown[]).length).toBe(4);
    expect(r.toolCalls).toEqual([{ id: 'c1', name: 'get_time', args: { timezone: 'Asia/Tokyo' } }]);
  });

  it('anthropic: separates system and parses tool_use', async () => {
    const cap: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
    const p = createProvider({
      provider: 'anthropic',
      apiKey: 'a',
      fetch: fakeFetch({ content: [{ type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 't1', name: 'calculate', input: { expression: '1+1' } }] }, cap),
    });
    const r = await p.chat([{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }], []);
    expect(cap[0]!.headers['x-api-key']).toBe('a');
    expect(cap[0]!.body.system).toBe('sys');
    expect(r).toEqual({ text: 'Checking.', toolCalls: [{ id: 't1', name: 'calculate', args: { expression: '1+1' } }] });
  });

  it('surfaces HTTP errors', async () => {
    const p = createProvider({
      provider: 'groq',
      apiKey: 'k',
      fetch: async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => 'invalid key' }),
    });
    await expect(p.chat([{ role: 'user', content: 'x' }], [])).rejects.toThrow('HTTP 401');
  });

  it('converts tool history for both APIs', () => {
    const hist = [
      { role: 'user' as const, content: 'q' },
      { role: 'assistant' as const, content: '', toolCalls: [{ id: 'c', name: 'n', args: { a: 1 } }] },
      { role: 'tool' as const, toolCallId: 'c', name: 'n', content: '{"ok":true}' },
    ];
    const oa = toOpenAIMessages(hist) as Array<Record<string, unknown>>;
    expect(oa[1]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'c', function: { name: 'n', arguments: '{"a":1}' } }] });
    expect(oa[2]).toEqual({ role: 'tool', tool_call_id: 'c', content: '{"ok":true}' });
    const an = toAnthropicMessages(hist);
    expect(an.messages).toHaveLength(3);
    expect((an.messages[2] as { content: Array<{ type: string }> }).content[0]!.type).toBe('tool_result');
  });
});

describe('HTTP + WebSocket server', () => {
  let close: (() => Promise<void>) | null = null;
  afterEach(async () => {
    await close?.();
    close = null;
  });

  it('refuses path traversal', () => {
    const root = path.resolve('/srv/hud');
    expect(resolveStatic(root, '/')).toBe(path.join(root, 'index.html'));
    expect(resolveStatic(root, '/assets/a.js?v=1')).toBe(path.join(root, 'assets/a.js'));
    expect(resolveStatic(root, '/../etc/passwd')).toBeNull();
    expect(resolveStatic(root, '/%2e%2e/%2e%2e/etc/passwd')).toBeNull();
    expect(resolveStatic(root, '/%E0%A4%A')).toBeNull();
  });

  it('serves the protocol end to end with the mock backend', async () => {
    const srv = await startServer({ port: 0, mode: 'agent', provider: { provider: 'mock' }, log: () => {} });
    close = srv.close;
    const health = await fetch(`http://127.0.0.1:${srv.port}/health`).then((r) => r.json());
    expect(health).toEqual({ ok: true, mode: 'agent', provider: 'mock' });

    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
    const events: ServerEvent[] = [];
    const done = new Promise<void>((resolve) => {
      ws.on('message', (d) => {
        const ev = JSON.parse(String(d)) as ServerEvent;
        events.push(ev);
        if (ev.type === 'state' && ev.state === 'idle' && events.some((e) => e.type === 'tool_result')) resolve();
      });
    });
    await new Promise((r) => ws.on('open', r));
    ws.send('garbage');
    ws.send(JSON.stringify({ type: 'user_text', text: 'what time is it in London' }));
    await done;
    ws.close();
    expect(events[0]).toMatchObject({ type: 'meta', backend: 'Mock backend', simulated: true });
    expect(events).toContainEqual({ type: 'error', message: 'Malformed client message' });
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_call', name: 'get_time', args: { timezone: 'Europe/London' } }));
  }, 15000);

  it('requires a key for realtime mode', () => {
    expect(() => startServer({ port: 0, mode: 'realtime', realtime: { apiKey: '' } })).toThrow(/OPENAI_API_KEY/);
  });
});
