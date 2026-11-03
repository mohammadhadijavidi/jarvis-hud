import type { ServerEvent } from '../protocol.js';

/**
 * Translate OpenAI Realtime API server events into HUD protocol events.
 *
 * Handles both the GA event names (`response.output_audio.delta`,
 * `response.output_audio_transcript.delta`) and the older beta names
 * (`response.audio.delta`, `response.audio_transcript.delta`).
 *
 * Function calls are surfaced as `tool_call`; the caller is responsible for
 * executing the tool and emitting the matching `tool_result`.
 */
export interface RealtimeFunctionCall {
  callId: string;
  name: string;
  args: unknown;
}

export interface MappedRealtime {
  events: ServerEvent[];
  functionCall?: RealtimeFunctionCall;
}

type Raw = Record<string, unknown>;

const s = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

function parseArgs(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? {};
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

export function mapRealtimeEvent(input: unknown): MappedRealtime {
  if (typeof input !== 'object' || input === null) return { events: [] };
  const ev = input as Raw;
  const type = s(ev.type);
  switch (type) {
    case 'session.created': {
      const session = (ev.session ?? {}) as Raw;
      return {
        events: [
          {
            type: 'meta',
            backend: 'OpenAI Realtime',
            provider: 'openai',
            model: s(session.model) || undefined,
            simulated: false,
            accepts: ['audio', 'text'],
          },
          { type: 'state', state: 'idle' },
        ],
      };
    }
    case 'input_audio_buffer.speech_started':
      return { events: [{ type: 'state', state: 'listening' }] };
    case 'input_audio_buffer.speech_stopped':
    case 'input_audio_buffer.committed':
      return { events: [{ type: 'state', state: 'thinking' }] };
    case 'conversation.item.input_audio_transcription.delta':
      return {
        events: [{ type: 'transcript', id: 'u-' + s(ev.item_id), role: 'user', text: s(ev.delta), delta: true }],
      };
    case 'conversation.item.input_audio_transcription.completed':
      return {
        events: [{ type: 'transcript', id: 'u-' + s(ev.item_id), role: 'user', text: s(ev.transcript), final: true }],
      };
    case 'response.created':
      return { events: [{ type: 'state', state: 'thinking' }] };
    case 'response.output_audio_transcript.delta':
    case 'response.audio_transcript.delta':
      return {
        events: [
          { type: 'state', state: 'speaking' },
          { type: 'transcript', id: 'a-' + s(ev.item_id), role: 'assistant', text: s(ev.delta), delta: true },
        ],
      };
    case 'response.output_audio_transcript.done':
    case 'response.audio_transcript.done':
      return {
        events: [
          { type: 'transcript', id: 'a-' + s(ev.item_id), role: 'assistant', text: s(ev.transcript), final: true },
        ],
      };
    case 'response.output_text.delta':
    case 'response.text.delta':
      return {
        events: [{ type: 'transcript', id: 'a-' + s(ev.item_id), role: 'assistant', text: s(ev.delta), delta: true }],
      };
    case 'response.output_audio.delta':
    case 'response.audio.delta':
      return { events: [{ type: 'audio', data: s(ev.delta), sampleRate: 24000 }] };
    case 'response.function_call_arguments.done': {
      const callId = s(ev.call_id) || s(ev.item_id);
      const name = s(ev.name, 'function');
      const args = parseArgs(ev.arguments);
      return { events: [{ type: 'tool_call', id: callId, name, args }], functionCall: { callId, name, args } };
    }
    case 'response.done':
      return { events: [{ type: 'state', state: 'idle' }] };
    case 'error': {
      const err = (ev.error ?? {}) as Raw;
      return { events: [{ type: 'error', message: s(err.message, 'Realtime API error') }] };
    }
    default:
      return { events: [] };
  }
}
