import { describe, expect, it } from 'vitest';
import { MAX_TOOLS, MAX_UTTERANCES, initialState, reduce, rows, setConnection, summarize } from '../src/state/store';
import type { ServerEvent } from '../src/protocol';

const run = (events: ServerEvent[], now = 1000) => events.reduce((s, e) => reduce(s, e, now), initialState());

describe('reduce', () => {
  it('streams transcript deltas into one utterance', () => {
    const s = run([
      { type: 'transcript', id: 'a1', role: 'assistant', text: 'Hello' },
      { type: 'transcript', id: 'a1', role: 'assistant', text: ' there', delta: true },
      { type: 'transcript', id: 'a1', role: 'assistant', text: '', delta: true, final: true },
    ]);
    expect(s.transcript).toHaveLength(1);
    expect(s.transcript[0]).toMatchObject({ text: 'Hello there', final: true });
  });

  it('replaces text when not a delta (e.g. final transcription)', () => {
    const s = run([
      { type: 'transcript', id: 'u', role: 'user', text: 'helo', delta: true },
      { type: 'transcript', id: 'u', role: 'user', text: 'hello', final: true },
    ]);
    expect(s.transcript[0]!.text).toBe('hello');
  });

  it('counts a turn each time thinking starts', () => {
    const s = run([
      { type: 'state', state: 'thinking' },
      { type: 'state', state: 'thinking' },
      { type: 'state', state: 'speaking' },
      { type: 'state', state: 'idle' },
      { type: 'state', state: 'thinking' },
    ]);
    expect(s.turns).toBe(2);
  });

  it('tracks tool lifecycle and computes duration if missing', () => {
    let s = reduce(initialState(), { type: 'tool_call', id: 't', name: 'calculate', args: { expression: '1+1' } }, 100);
    expect(s.tools[0]!.status).toBe('running');
    s = reduce(s, { type: 'tool_result', id: 't', status: 'ok', result: { result: 2 } }, 175);
    expect(s.tools[0]).toMatchObject({ status: 'ok', ms: 75, result: { result: 2 } });
  });

  it('ignores results for unknown tool ids', () => {
    const s = run([{ type: 'tool_result', id: 'ghost', status: 'ok' }]);
    expect(s.tools).toHaveLength(0);
  });

  it('caps history sizes', () => {
    const evs: ServerEvent[] = [];
    for (let i = 0; i < MAX_UTTERANCES + 10; i++) evs.push({ type: 'transcript', id: `u${i}`, role: 'user', text: 'x' });
    for (let i = 0; i < MAX_TOOLS + 5; i++) evs.push({ type: 'tool_call', id: `t${i}`, name: 'n' });
    const s = run(evs);
    expect(s.transcript).toHaveLength(MAX_UTTERANCES);
    expect(s.transcript[0]!.id).toBe('u10');
    expect(s.tools).toHaveLength(MAX_TOOLS);
  });

  it('resets level when leaving speaking and on disconnect', () => {
    let s = run([{ type: 'state', state: 'speaking' }, { type: 'level', value: 0.8 }]);
    expect(s.remoteLevel).toBe(0.8);
    s = reduce(s, { type: 'state', state: 'idle' });
    expect(s.remoteLevel).toBe(0);
    s = setConnection(reduce(s, { type: 'state', state: 'speaking' }), 'closed');
    expect(s).toMatchObject({ connection: 'closed', assistant: 'idle' });
  });

  it('stores meta and errors', () => {
    const s = run([
      { type: 'meta', backend: 'Mock backend', simulated: true },
      { type: 'error', message: 'boom' },
    ]);
    expect(s.meta?.simulated).toBe(true);
    expect(s.lastError).toBe('boom');
  });
});

describe('formatting helpers', () => {
  it('summarize truncates and flattens', () => {
    expect(summarize({ a: 'x\n\ny' })).toBe('{"a":"x\\n\\ny"}');
    expect(summarize('a'.repeat(200), 10)).toHaveLength(10);
    expect(summarize(undefined)).toBe('');
  });

  it('rows skips values that echo the arguments', () => {
    const r = rows({ expression: '2*3', result: 6 }, 4, { expression: '2*3' });
    expect(r).toEqual([['result', '6']]);
    expect(rows(5)).toEqual([['value', '5']]);
    expect(rows(null)).toEqual([]);
  });
});
