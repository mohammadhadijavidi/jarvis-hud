/**
 * Built-in demo tools. All are local and deterministic-or-real (no network),
 * so tool-call cards in the HUD always show genuine results.
 */
import os from 'node:os';
import type { ToolSpec } from './providers.js';

export interface Tool extends ToolSpec {
  run(args: Record<string, unknown>): Promise<unknown> | unknown;
}

/** Safe arithmetic evaluator: + - * / % ^, parentheses, unary minus. No eval. */
export function calculate(expression: string): number {
  const src = expression.replace(/\s+/g, '').replace(/[x×]/g, '*').replace(/÷/g, '/');
  if (!src) throw new Error('Empty expression');
  if (src.length > 200) throw new Error('Expression too long');
  let i = 0;
  const peek = () => src[i];
  const expect = (c: string) => {
    if (src[i] !== c) throw new Error(`Expected "${c}" at position ${i}`);
    i++;
  };
  const number = (): number => {
    const start = i;
    while (i < src.length && /[0-9.]/.test(src[i]!)) i++;
    const raw = src.slice(start, i);
    if (!raw || raw.split('.').length > 2) throw new Error(`Invalid number at position ${start}`);
    return Number(raw);
  };
  const primary = (): number => {
    const c = peek();
    if (c === '(') {
      i++;
      const v = expr();
      expect(')');
      return v;
    }
    if (c === '-') {
      i++;
      return -primary();
    }
    if (c === '+') {
      i++;
      return primary();
    }
    return number();
  };
  const power = (): number => {
    const base = primary();
    if (peek() === '^') {
      i++;
      return base ** unary();
    }
    return base;
  };
  const unary = (): number => power();
  const term = (): number => {
    let v = unary();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = src[i++];
      const r = unary();
      if (op === '*') v *= r;
      else if (op === '/') {
        if (r === 0) throw new Error('Division by zero');
        v /= r;
      } else v %= r;
    }
    return v;
  };
  const expr = (): number => {
    let v = term();
    while (peek() === '+' || peek() === '-') {
      const op = src[i++];
      const r = term();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  const result = expr();
  if (i !== src.length) throw new Error(`Unexpected "${src[i]}" at position ${i}`);
  if (!Number.isFinite(result)) throw new Error('Result is not finite');
  return Math.round(result * 1e10) / 1e10;
}

export interface Clock {
  now(): Date;
}

export function createTools(clock: Clock = { now: () => new Date() }): Tool[] {
  const notes: string[] = [];
  return [
    {
      name: 'get_time',
      description: 'Get the current date and time, optionally in an IANA time zone such as "Asia/Dubai".',
      parameters: {
        type: 'object',
        properties: { timezone: { type: 'string', description: 'IANA time zone, e.g. Europe/London' } },
      },
      run(args) {
        const tz = typeof args.timezone === 'string' && args.timezone ? args.timezone : undefined;
        const d = clock.now();
        let local: string;
        try {
          local = new Intl.DateTimeFormat('en-GB', {
            dateStyle: 'medium',
            timeStyle: 'short',
            timeZone: tz,
          }).format(d);
        } catch {
          throw new Error(`Unknown time zone "${tz}"`);
        }
        return { timezone: tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone, local, iso: d.toISOString() };
      },
    },
    {
      name: 'calculate',
      description: 'Evaluate an arithmetic expression (+ - * / % ^ and parentheses).',
      parameters: {
        type: 'object',
        properties: { expression: { type: 'string' } },
        required: ['expression'],
      },
      run(args) {
        const expression = String(args.expression ?? '');
        return { expression, result: calculate(expression) };
      },
    },
    {
      name: 'system_status',
      description: 'Report real CPU load, memory and uptime of the machine running the backend.',
      parameters: { type: 'object', properties: {} },
      run() {
        const total = os.totalmem();
        const free = os.freemem();
        const load = os.loadavg()[0] ?? 0;
        const cpus = os.cpus().length || 1;
        return {
          host: os.hostname(),
          cpu_load_pct: Math.round((load / cpus) * 1000) / 10,
          memory_used_pct: Math.round(((total - free) / total) * 1000) / 10,
          uptime_h: Math.round((os.uptime() / 3600) * 10) / 10,
          platform: `${os.platform()} ${os.arch()}`,
        };
      },
    },
    {
      name: 'save_note',
      description: 'Save a short note to the session memory and return all notes.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      run(args) {
        const text = String(args.text ?? '').trim();
        if (!text) throw new Error('Note text is empty');
        notes.push(text.slice(0, 280));
        return { saved: text.slice(0, 280), total: notes.length };
      },
    },
  ];
}
