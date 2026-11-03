import { describe, expect, it } from 'vitest';
import { mapRealtimeEvent } from '../src/adapters/openai-realtime';
import { RealtimeRelay, buildSessionUpdate, type RealtimeSocket } from '../server/relay';
import { createTools } from '../server/tools';
import type { ServerEvent } from '../src/protocol';

describe('mapRealtimeEvent', () => {
  it('maps session.created to meta', () => {
    const { events } = mapRealtimeEvent({ type: 'session.created', session: { model: 'gpt-realtime' } });
    expect(events[0]).toMatchObject({ type: 'meta', backend: 'OpenAI Realtime', model: 'gpt-realtime', simulated: false });
  });

  it('maps VAD events to listening/thinking', () => {
    expect(mapRealtimeEvent({ type: 'input_audio_buffer.speech_started' }).events).toEqual([{ type: 'state', state: 'listening' }]);
    expect(mapRealtimeEvent({ type: 'input_audio_buffer.speech_stopped' }).events).toEqual([{ type: 'state', state: 'thinking' }]);
  });

  it('handles GA and beta transcript delta names identically', () => {
    const ga = mapRealtimeEvent({ type: 'response.output_audio_transcript.delta', item_id: 'i1', delta: 'Hi' }).events;
    const beta = mapRealtimeEvent({ type: 'response.audio_transcript.delta', item_id: 'i1', delta: 'Hi' }).events;
    expect(ga).toEqual(beta);
    expect(ga).toContainEqual({ type: 'transcript', id: 'a-i1', role: 'assistant', text: 'Hi', delta: true });
  });

  it('passes audio deltas through', () => {
    expect(mapRealtimeEvent({ type: 'response.output_audio.delta', delta: 'AAAA' }).events).toEqual([
      { type: 'audio', data: 'AAAA', sampleRate: 24000 },
    ]);
  });

  it('maps user transcription completion', () => {
    const { events } = mapRealtimeEvent({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'u9',
      transcript: 'what time is it',
    });
    expect(events).toEqual([{ type: 'transcript', id: 'u-u9', role: 'user', text: 'what time is it', final: true }]);
  });

  it('surfaces function calls with parsed args', () => {
    const r = mapRealtimeEvent({
      type: 'response.function_call_arguments.done',
      call_id: 'c1',
      name: 'calculate',
      arguments: '{"expression":"2+2"}',
    });
    expect(r.functionCall).toEqual({ callId: 'c1', name: 'calculate', args: { expression: '2+2' } });
    expect(r.events[0]).toMatchObject({ type: 'tool_call', id: 'c1', name: 'calculate' });
    expect(mapRealtimeEvent({ type: 'response.function_call_arguments.done', call_id: 'c', arguments: '{bad' }).functionCall?.args).toEqual({
      raw: '{bad',
    });
  });

  it('maps errors and ignores unknown events', () => {
    expect(mapRealtimeEvent({ type: 'error', error: { message: 'bad key' } }).events).toEqual([{ type: 'error', message: 'bad key' }]);
    expect(mapRealtimeEvent({ type: 'rate_limits.updated' }).events).toEqual([]);
    expect(mapRealtimeEvent(null).events).toEqual([]);
  });
});

class FakeSocket implements RealtimeSocket {
  sent: Array<Record<string, unknown>> = [];
  handlers: Record<string, (arg?: unknown) => void> = {};
  send(d: string) {
    this.sent.push(JSON.parse(d));
  }
  close() {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(ev: string, cb: (...args: any[]) => void) {
    this.handlers[ev] = cb;
  }
}

describe('RealtimeRelay', () => {
  it('configures the session, queues until open, and runs function calls locally', async () => {
    const sock = new FakeSocket();
    const out: ServerEvent[] = [];
    let seenUrl = '';
    let seenHeaders: Record<string, string> = {};
    const relay = new RealtimeRelay({
      apiKey: 'sk-test',
      tools: createTools(),
      emit: (e) => out.push(e),
      connect: (url, headers) => {
        seenUrl = url;
        seenHeaders = headers;
        return sock;
      },
    });
    expect(seenUrl).toContain('model=gpt-realtime');
    expect(seenHeaders.Authorization).toBe('Bearer sk-test');

    relay.handle({ type: 'audio', data: 'AAAA', sampleRate: 24000 });
    expect(sock.sent).toHaveLength(0); // queued
    sock.handlers.open!();
    expect(sock.sent[0]!.type).toBe('session.update');
    expect(sock.sent[1]).toEqual({ type: 'input_audio_buffer.append', audio: 'AAAA' });

    sock.handlers.message!(
      JSON.stringify({ type: 'response.function_call_arguments.done', call_id: 'c7', name: 'calculate', arguments: '{"expression":"6*7"}' }),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(out).toContainEqual(expect.objectContaining({ type: 'tool_result', id: 'c7', status: 'ok', result: { expression: '6*7', result: 42 } }));
    const item = sock.sent.find((m) => m.type === 'conversation.item.create') as { item: { call_id: string; output: string } };
    expect(item.item.call_id).toBe('c7');
    expect(JSON.parse(item.item.output)).toEqual({ expression: '6*7', result: 42 });
    expect(sock.sent[sock.sent.length - 1]).toEqual({ type: 'response.create' });

    relay.handle({ type: 'interrupt' });
    expect(sock.sent[sock.sent.length - 1]).toEqual({ type: 'response.cancel' });
  });

  it('builds a session.update with tools as functions', () => {
    const u = buildSessionUpdate(createTools(), 'be brief', 'marin') as { session: { tools: Array<{ type: string; name: string }>; instructions: string } };
    expect(u.session.instructions).toBe('be brief');
    expect(u.session.tools.map((t) => t.name)).toEqual(['get_time', 'calculate', 'system_status', 'save_note']);
    expect(u.session.tools.every((t) => t.type === 'function')).toBe(true);
  });
});
