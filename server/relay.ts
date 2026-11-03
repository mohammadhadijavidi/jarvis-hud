/**
 * OpenAI Realtime relay.
 *
 * Browser (HUD protocol, PCM16 mic audio) <-> this relay <-> OpenAI Realtime API.
 * The API key stays on the server. Realtime events are mapped to HUD events by
 * {@link mapRealtimeEvent}; function calls are executed with the local tools and
 * their results are sent back to the model.
 */
import WebSocket from 'ws';
import type { ClientEvent, ServerEvent } from '../src/protocol.js';
import { mapRealtimeEvent } from '../src/adapters/openai-realtime.js';
import type { Tool } from './tools.js';
import { DEFAULT_SYSTEM_PROMPT } from './session.js';

export interface RelayOptions {
  apiKey: string;
  model?: string;
  voice?: string;
  url?: string;
  tools: Tool[];
  instructions?: string;
  emit: (ev: ServerEvent) => void;
  /** Injected for tests. */
  connect?: (url: string, headers: Record<string, string>) => RealtimeSocket;
}

export interface RealtimeSocket {
  send(data: string): void;
  close(): void;
  on(event: 'open', cb: () => void): void;
  on(event: 'message', cb: (data: unknown) => void): void;
  on(event: 'close', cb: () => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
}

/** session.update payload for the Realtime API. Exported for tests. */
export function buildSessionUpdate(tools: Tool[], instructions: string, voice: string): Record<string, unknown> {
  return {
    type: 'session.update',
    session: {
      type: 'realtime',
      instructions,
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24000 },
          transcription: { model: 'gpt-4o-mini-transcribe' },
          turn_detection: { type: 'server_vad' },
        },
        output: { format: { type: 'audio/pcm', rate: 24000 }, voice },
      },
      tools: tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters })),
    },
  };
}

export class RealtimeRelay {
  private ws: RealtimeSocket;
  private queue: string[] = [];
  private open = false;

  constructor(private o: RelayOptions) {
    const model = o.model ?? 'gpt-realtime';
    const url = o.url ?? `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
    const headers = { Authorization: `Bearer ${o.apiKey}` };
    const connect =
      o.connect ?? ((u: string, h: Record<string, string>) => new WebSocket(u, { headers: h }) as unknown as RealtimeSocket);
    this.ws = connect(url, headers);
    // Announce immediately so the HUD streams mic audio before session.created arrives.
    o.emit({ type: 'meta', backend: 'OpenAI Realtime', provider: 'openai', model, simulated: false, accepts: ['audio', 'text'] });
    this.ws.on('open', () => {
      this.open = true;
      this.ws.send(
        JSON.stringify(buildSessionUpdate(o.tools, o.instructions ?? DEFAULT_SYSTEM_PROMPT, o.voice ?? 'marin')),
      );
      for (const m of this.queue.splice(0)) this.ws.send(m);
    });
    this.ws.on('message', (data) => void this.onUpstream(String(data)));
    this.ws.on('error', (err) => o.emit({ type: 'error', message: `Realtime connection error: ${err.message}` }));
    this.ws.on('close', () => o.emit({ type: 'state', state: 'idle' }));
  }

  private send(obj: unknown): void {
    const s = JSON.stringify(obj);
    if (this.open) this.ws.send(s);
    else this.queue.push(s);
  }

  private async onUpstream(raw: string): Promise<void> {
    let ev: unknown;
    try {
      ev = JSON.parse(raw);
    } catch {
      return;
    }
    const mapped = mapRealtimeEvent(ev);
    for (const e of mapped.events) this.o.emit(e);
    const call = mapped.functionCall;
    if (!call) return;
    const tool = this.o.tools.find((t) => t.name === call.name);
    const t0 = Date.now();
    let output: unknown;
    try {
      if (!tool) throw new Error(`Unknown tool "${call.name}"`);
      output = await tool.run((call.args ?? {}) as Record<string, unknown>);
      this.o.emit({ type: 'tool_result', id: call.callId, status: 'ok', result: output, ms: Date.now() - t0 });
    } catch (err) {
      output = { error: err instanceof Error ? err.message : String(err) };
      this.o.emit({ type: 'tool_result', id: call.callId, status: 'error', result: output, ms: Date.now() - t0 });
    }
    this.send({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: call.callId, output: JSON.stringify(output) },
    });
    this.send({ type: 'response.create' });
  }

  handle(ev: ClientEvent): void {
    switch (ev.type) {
      case 'audio':
        this.send({ type: 'input_audio_buffer.append', audio: ev.data });
        break;
      case 'audio_commit':
        // Turn detection is server-side (server_vad): the API commits the buffer and
        // starts a response on its own when the user stops talking. Committing again
        // here would fail on an empty buffer, so stopping the mic needs no message.
        break;
      case 'user_text':
        this.o.emit({ type: 'transcript', id: `ut-${Date.now()}`, role: 'user', text: ev.text, final: true });
        this.send({
          type: 'conversation.item.create',
          item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: ev.text }] },
        });
        this.send({ type: 'response.create' });
        break;
      case 'interrupt':
        this.send({ type: 'response.cancel' });
        break;
      default:
        break;
    }
  }

  close(): void {
    this.ws.close();
  }
}
