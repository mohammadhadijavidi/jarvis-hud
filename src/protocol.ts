/**
 * The HUD event protocol.
 *
 * Every backend (mock, LLM agent, OpenAI Realtime relay, or your own server)
 * speaks this small JSON-over-WebSocket protocol. The HUD never needs to know
 * which model is behind it.
 *
 * Server -> HUD: {@link ServerEvent}
 * HUD -> Server: {@link ClientEvent}
 */

export const PROTOCOL_VERSION = 1;

export type AssistantState = 'idle' | 'listening' | 'thinking' | 'speaking';
export type Role = 'user' | 'assistant' | 'system';
export type ToolStatus = 'running' | 'ok' | 'error';

export interface MetaEvent {
  type: 'meta';
  /** Human-readable backend name, e.g. "Mock backend" or "OpenAI Realtime". */
  backend: string;
  provider?: string;
  model?: string;
  /** True when responses are scripted/simulated rather than produced by a real model. */
  simulated?: boolean;
  /** Which input modes the backend accepts. */
  accepts?: Array<'text' | 'audio'>;
}

export interface StateEvent {
  type: 'state';
  state: AssistantState;
}

export interface TranscriptEvent {
  type: 'transcript';
  /** Stable id of the utterance. Deltas with the same id are appended. */
  id: string;
  role: Role;
  text: string;
  /** When true, `text` is appended to the existing utterance instead of replacing it. */
  delta?: boolean;
  /** Marks the utterance as complete. */
  final?: boolean;
}

export interface ToolCallEvent {
  type: 'tool_call';
  id: string;
  name: string;
  args?: unknown;
}

export interface ToolResultEvent {
  type: 'tool_result';
  id: string;
  status: 'ok' | 'error';
  result?: unknown;
  /** Wall time in milliseconds, if the backend measured it. */
  ms?: number;
}

export interface LevelEvent {
  type: 'level';
  /** Assistant voice level 0..1 (used when the backend does not stream raw audio). */
  value: number;
}

export interface AudioEvent {
  type: 'audio';
  /** Base64 little-endian PCM16 mono. */
  data: string;
  sampleRate?: number;
}

export interface ErrorEvent {
  type: 'error';
  message: string;
}

export type ServerEvent =
  | MetaEvent
  | StateEvent
  | TranscriptEvent
  | ToolCallEvent
  | ToolResultEvent
  | LevelEvent
  | AudioEvent
  | ErrorEvent;

export type ClientEvent =
  | { type: 'hello'; client: string; protocol: number }
  | { type: 'user_text'; text: string }
  | { type: 'audio'; data: string; sampleRate: number }
  | { type: 'audio_commit' }
  | { type: 'interrupt' };

const STATES: readonly AssistantState[] = ['idle', 'listening', 'thinking', 'speaking'];
const ROLES: readonly Role[] = ['user', 'assistant', 'system'];

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
const isStr = (v: unknown): v is string => typeof v === 'string';

/**
 * Validate and normalize an incoming server event. Returns null for anything
 * that does not match the protocol, so a misbehaving backend can never crash the UI.
 */
export function parseServerEvent(input: unknown): ServerEvent | null {
  let v: unknown = input;
  if (isStr(v)) {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!isObj(v) || !isStr(v.type)) return null;
  switch (v.type) {
    case 'meta':
      if (!isStr(v.backend)) return null;
      return {
        type: 'meta',
        backend: v.backend,
        provider: isStr(v.provider) ? v.provider : undefined,
        model: isStr(v.model) ? v.model : undefined,
        simulated: v.simulated === true,
        accepts: Array.isArray(v.accepts)
          ? (v.accepts.filter((a) => a === 'text' || a === 'audio') as Array<'text' | 'audio'>)
          : undefined,
      };
    case 'state':
      return STATES.includes(v.state as AssistantState)
        ? { type: 'state', state: v.state as AssistantState }
        : null;
    case 'transcript':
      if (!isStr(v.id) || !isStr(v.text) || !ROLES.includes(v.role as Role)) return null;
      return {
        type: 'transcript',
        id: v.id,
        role: v.role as Role,
        text: v.text,
        delta: v.delta === true,
        final: v.final === true,
      };
    case 'tool_call':
      if (!isStr(v.id) || !isStr(v.name)) return null;
      return { type: 'tool_call', id: v.id, name: v.name, args: v.args };
    case 'tool_result':
      if (!isStr(v.id) || (v.status !== 'ok' && v.status !== 'error')) return null;
      return {
        type: 'tool_result',
        id: v.id,
        status: v.status,
        result: v.result,
        ms: typeof v.ms === 'number' && Number.isFinite(v.ms) ? v.ms : undefined,
      };
    case 'level': {
      const n = Number(v.value);
      if (!Number.isFinite(n)) return null;
      return { type: 'level', value: Math.min(1, Math.max(0, n)) };
    }
    case 'audio':
      if (!isStr(v.data)) return null;
      return {
        type: 'audio',
        data: v.data,
        sampleRate: typeof v.sampleRate === 'number' && v.sampleRate > 0 ? v.sampleRate : 24000,
      };
    case 'error':
      return { type: 'error', message: isStr(v.message) ? v.message : 'Unknown error' };
    default:
      return null;
  }
}

/** Validate a message sent from the HUD to a backend. */
export function parseClientEvent(input: unknown): ClientEvent | null {
  let v: unknown = input;
  if (isStr(v)) {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!isObj(v) || !isStr(v.type)) return null;
  switch (v.type) {
    case 'hello':
      return {
        type: 'hello',
        client: isStr(v.client) ? v.client : 'unknown',
        protocol: typeof v.protocol === 'number' ? v.protocol : PROTOCOL_VERSION,
      };
    case 'user_text': {
      if (!isStr(v.text)) return null;
      const text = v.text.trim();
      return text ? { type: 'user_text', text: text.slice(0, 4000) } : null;
    }
    case 'audio':
      if (!isStr(v.data)) return null;
      return { type: 'audio', data: v.data, sampleRate: typeof v.sampleRate === 'number' ? v.sampleRate : 24000 };
    case 'audio_commit':
      return { type: 'audio_commit' };
    case 'interrupt':
      return { type: 'interrupt' };
    default:
      return null;
  }
}
