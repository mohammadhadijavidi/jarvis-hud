import { describe, expect, it } from 'vitest';
import { parseClientEvent, parseServerEvent } from '../src/protocol';

describe('parseServerEvent', () => {
  it('accepts JSON strings and objects', () => {
    expect(parseServerEvent('{"type":"state","state":"thinking"}')).toEqual({ type: 'state', state: 'thinking' });
    expect(parseServerEvent({ type: 'state', state: 'speaking' })).toEqual({ type: 'state', state: 'speaking' });
  });

  it('rejects garbage without throwing', () => {
    for (const bad of ['', 'not json', '[]', 'null', { type: 'state', state: 'dancing' }, { type: 'nope' }, 42, null]) {
      expect(parseServerEvent(bad)).toBeNull();
    }
  });

  it('clamps level to 0..1', () => {
    expect(parseServerEvent({ type: 'level', value: 3 })).toEqual({ type: 'level', value: 1 });
    expect(parseServerEvent({ type: 'level', value: -1 })).toEqual({ type: 'level', value: 0 });
    expect(parseServerEvent({ type: 'level', value: 'x' })).toBeNull();
  });

  it('normalizes transcript flags and validates role', () => {
    expect(parseServerEvent({ type: 'transcript', id: 'a', role: 'assistant', text: 'hi', delta: 1 })).toEqual({
      type: 'transcript',
      id: 'a',
      role: 'assistant',
      text: 'hi',
      delta: false,
      final: false,
    });
    expect(parseServerEvent({ type: 'transcript', id: 'a', role: 'robot', text: 'hi' })).toBeNull();
  });

  it('parses meta with simulated flag and filters accepts', () => {
    const ev = parseServerEvent({ type: 'meta', backend: 'Mock', simulated: true, accepts: ['text', 'video'] });
    expect(ev).toMatchObject({ type: 'meta', backend: 'Mock', simulated: true, accepts: ['text'] });
  });

  it('defaults audio sample rate and drops non-finite ms', () => {
    expect(parseServerEvent({ type: 'audio', data: 'AAAA' })).toMatchObject({ sampleRate: 24000 });
    expect(parseServerEvent({ type: 'tool_result', id: 'x', status: 'ok', ms: Infinity })).toMatchObject({ ms: undefined });
    expect(parseServerEvent({ type: 'tool_result', id: 'x', status: 'maybe' })).toBeNull();
  });
});

describe('parseClientEvent', () => {
  it('trims and limits user text, drops empty', () => {
    expect(parseClientEvent({ type: 'user_text', text: '  hi  ' })).toEqual({ type: 'user_text', text: 'hi' });
    expect(parseClientEvent({ type: 'user_text', text: '   ' })).toBeNull();
    const long = parseClientEvent({ type: 'user_text', text: 'x'.repeat(5000) });
    expect(long && long.type === 'user_text' && long.text.length).toBe(4000);
  });

  it('accepts control events', () => {
    expect(parseClientEvent('{"type":"interrupt"}')).toEqual({ type: 'interrupt' });
    expect(parseClientEvent({ type: 'audio_commit' })).toEqual({ type: 'audio_commit' });
    expect(parseClientEvent({ type: 'hello' })).toMatchObject({ type: 'hello', client: 'unknown' });
    expect(parseClientEvent({ type: 'rm -rf' })).toBeNull();
  });
});
