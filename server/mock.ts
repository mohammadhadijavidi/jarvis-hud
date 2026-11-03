/**
 * Mock provider: deterministic, offline "model" used for demos and tests.
 * It routes requests to the built-in tools with simple keyword rules and
 * phrases replies from the real tool results. It is NOT a language model and
 * the HUD labels every session using it as "simulated".
 */
import type { ChatMessage, ProviderReply, ToolCallRequest } from './providers.js';

let counter = 0;
const nextId = () => `mock_call_${++counter}`;

const TZ_ALIASES: Record<string, string> = {
  dubai: 'Asia/Dubai',
  tehran: 'Asia/Tehran',
  london: 'Europe/London',
  paris: 'Europe/Paris',
  berlin: 'Europe/Berlin',
  tokyo: 'Asia/Tokyo',
  'new york': 'America/New_York',
  'san francisco': 'America/Los_Angeles',
  cairo: 'Africa/Cairo',
  istanbul: 'Europe/Istanbul',
  sydney: 'Australia/Sydney',
};

/** Pick tool calls for a user utterance. Exported for tests. */
export function planTools(text: string): ToolCallRequest[] {
  const t = text.toLowerCase();
  const calls: ToolCallRequest[] = [];
  if (/\b(time|clock|date|today)\b/.test(t)) {
    const city = Object.keys(TZ_ALIASES).find((c) => t.includes(c));
    calls.push({ id: nextId(), name: 'get_time', args: city ? { timezone: TZ_ALIASES[city] } : {} });
  }
  const math = t.match(/[-(]*\d[\d\s.+\-*/%^()x×÷]*[+\-*/%^x×÷][\d\s.+\-*/%^()x×÷]*\d\)*/);
  if (math) calls.push({ id: nextId(), name: 'calculate', args: { expression: math[0].trim() } });
  if (/\b(status|diagnostic|diagnostics|cpu|memory|system|server)\b/.test(t)) {
    calls.push({ id: nextId(), name: 'system_status', args: {} });
  }
  const note = text.match(/\b(?:remember|note|save a note)\b(?:\s+that)?[:\s]+(.+)/i);
  if (note?.[1]) calls.push({ id: nextId(), name: 'save_note', args: { text: note[1].trim().replace(/[.!]$/, '') } });
  return calls;
}

function describe(name: string, content: string): string {
  let r: Record<string, unknown>;
  try {
    r = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return '';
  }
  if (r.error) return `The ${name.replace(/_/g, ' ')} tool reported an error: ${String(r.error)}.`;
  switch (name) {
    case 'get_time':
      return `It is ${String(r.local)} in ${String(r.timezone).replace(/_/g, ' ')}.`;
    case 'calculate':
      return `${String(r.expression)} comes to ${Number(r.result).toLocaleString('en-US')}.`;
    case 'system_status':
      return `Diagnostics are in. CPU load is ${String(r.cpu_load_pct)} percent, memory is at ${String(
        r.memory_used_pct,
      )} percent, and the host has been up for ${String(r.uptime_h)} hours.`;
    case 'save_note':
      return `Noted. I will keep "${String(r.saved)}" for this session.`;
    default:
      return '';
  }
}

export function mockChat(messages: ChatMessage[]): ProviderReply {
  const last = messages[messages.length - 1];
  if (!last) return { text: 'Standing by.', toolCalls: [] };
  if (last.role === 'tool') {
    // Collect the tool results of the latest assistant turn.
    const results: ChatMessage[] = [];
    for (let i = messages.length - 1; i >= 0 && messages[i]!.role === 'tool'; i--) results.unshift(messages[i]!);
    const text = results
      .map((m) => (m.role === 'tool' ? describe(m.name, m.content) : ''))
      .filter(Boolean)
      .join(' ');
    return { text: text || 'Done.', toolCalls: [] };
  }
  if (last.role !== 'user') return { text: 'Standing by.', toolCalls: [] };
  const calls = planTools(last.content);
  if (calls.length) return { text: '', toolCalls: calls };
  const t = last.content.toLowerCase();
  if (/\b(hello|hi|hey|good (morning|evening|afternoon))\b/.test(t)) {
    return { text: 'Hello. All systems are online. Ask me for the time, a calculation, or a system check.', toolCalls: [] };
  }
  if (/\b(who|what) are you\b/.test(t)) {
    return {
      text: 'I am the mock backend for Jarvis HUD. Connect a real provider to talk to a language model.',
      toolCalls: [],
    };
  }
  return {
    text: 'This is the offline mock backend, so I only understand a few commands: time, math, system status, and notes.',
    toolCalls: [],
  };
}
