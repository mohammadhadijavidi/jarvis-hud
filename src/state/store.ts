import type { AssistantState, MetaEvent, Role, ServerEvent, ToolStatus } from '../protocol.js';

export interface Utterance {
  id: string;
  role: Role;
  text: string;
  final: boolean;
  at: number;
}

export interface ToolCard {
  id: string;
  name: string;
  args: unknown;
  status: ToolStatus;
  result?: unknown;
  ms?: number;
  startedAt: number;
}

export type ConnectionStatus = 'connecting' | 'open' | 'closed';

export interface HudState {
  connection: ConnectionStatus;
  assistant: AssistantState;
  meta: MetaEvent | null;
  transcript: Utterance[];
  tools: ToolCard[];
  /** Assistant level pushed by the backend (0..1). */
  remoteLevel: number;
  lastError: string | null;
  turns: number;
}

export const MAX_UTTERANCES = 60;
export const MAX_TOOLS = 12;

export function initialState(): HudState {
  return {
    connection: 'connecting',
    assistant: 'idle',
    meta: null,
    transcript: [],
    tools: [],
    remoteLevel: 0,
    lastError: null,
    turns: 0,
  };
}

/**
 * Pure reducer: (state, event) -> new state. All HUD panels render from this,
 * which keeps the UI deterministic and testable without a browser.
 */
export function reduce(state: HudState, ev: ServerEvent, now = Date.now()): HudState {
  switch (ev.type) {
    case 'meta':
      return { ...state, meta: ev };
    case 'state': {
      const turns = ev.state === 'thinking' && state.assistant !== 'thinking' ? state.turns + 1 : state.turns;
      return {
        ...state,
        assistant: ev.state,
        turns,
        remoteLevel: ev.state === 'speaking' ? state.remoteLevel : 0,
      };
    }
    case 'transcript': {
      const idx = state.transcript.findIndex((u) => u.id === ev.id);
      let transcript: Utterance[];
      if (idx === -1) {
        transcript = [...state.transcript, { id: ev.id, role: ev.role, text: ev.text, final: !!ev.final, at: now }];
      } else {
        const prev = state.transcript[idx]!;
        const next: Utterance = {
          ...prev,
          text: ev.delta ? prev.text + ev.text : ev.text,
          final: !!ev.final || prev.final,
        };
        transcript = state.transcript.slice();
        transcript[idx] = next;
      }
      if (transcript.length > MAX_UTTERANCES) transcript = transcript.slice(-MAX_UTTERANCES);
      return { ...state, transcript };
    }
    case 'tool_call': {
      const exists = state.tools.some((t) => t.id === ev.id);
      const card: ToolCard = { id: ev.id, name: ev.name, args: ev.args, status: 'running', startedAt: now };
      let tools = exists ? state.tools.map((t) => (t.id === ev.id ? { ...t, ...card } : t)) : [...state.tools, card];
      if (tools.length > MAX_TOOLS) tools = tools.slice(-MAX_TOOLS);
      return { ...state, tools };
    }
    case 'tool_result': {
      const tools = state.tools.map((t) =>
        t.id === ev.id
          ? { ...t, status: ev.status, result: ev.result, ms: ev.ms ?? Math.max(0, now - t.startedAt) }
          : t,
      );
      return { ...state, tools };
    }
    case 'level':
      return { ...state, remoteLevel: ev.value };
    case 'audio':
      return state;
    case 'error':
      return { ...state, lastError: ev.message };
    default:
      return state;
  }
}

export function setConnection(state: HudState, connection: ConnectionStatus): HudState {
  return connection === 'closed'
    ? { ...state, connection, assistant: 'idle', remoteLevel: 0 }
    : { ...state, connection };
}

/** Compact one-line rendering of tool args/results for cards. */
export function summarize(value: unknown, max = 140): string {
  if (value === undefined || value === null) return '';
  let s: string;
  if (typeof value === 'string') s = value;
  else {
    try {
      s = JSON.stringify(value);
    } catch {
      s = String(value);
    }
  }
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/**
 * Flat key/value rows for a tool card, at most `limit` entries.
 * Keys whose value merely echoes the call arguments (`omit`) are skipped.
 */
export function rows(value: unknown, limit = 4, omit?: unknown): Array<[string, string]> {
  if (value === null || value === undefined) return [];
  if (typeof value !== 'object' || Array.isArray(value)) return [['value', summarize(value, 60)]];
  const echo = omit && typeof omit === 'object' ? (omit as Record<string, unknown>) : {};
  return Object.entries(value as Record<string, unknown>)
    .filter(([k, v]) => !(k in echo && summarize(echo[k]) === summarize(v)))
    .slice(0, limit)
    .map(([k, v]) => [k, summarize(v, 60)]);
}
