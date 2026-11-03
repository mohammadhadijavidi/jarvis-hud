import { describe, expect, it } from 'vitest';
import {
  Envelope,
  base64ToBytes,
  base64ToPcm16,
  bytesToBase64,
  floatToPcm16,
  pcm16ToBase64,
  pcm16ToFloat,
  resample,
  rms,
  rmsToLevel,
  speechEnvelope,
} from '../src/audio/level';

describe('levels', () => {
  it('computes RMS', () => {
    expect(rms([])).toBe(0);
    expect(rms([1, -1, 1, -1])).toBeCloseTo(1);
    expect(rms([0.5, 0.5])).toBeCloseTo(0.5);
  });

  it('maps RMS to a 0..1 dB scale', () => {
    expect(rmsToLevel(0)).toBe(0);
    expect(rmsToLevel(1)).toBe(1);
    expect(rmsToLevel(0.001)).toBe(0); // -60 dB
    expect(rmsToLevel(0.0316)).toBeCloseTo(0.5, 1); // about -30 dB
  });

  it('envelope attacks fast and releases slowly', () => {
    const e = new Envelope(0.5, 0.1);
    expect(e.next(1)).toBeCloseTo(0.5);
    expect(e.next(0)).toBeCloseTo(0.45);
    e.reset();
    expect(e.value).toBe(0);
  });
});

describe('pcm + base64', () => {
  it('base64 matches Node Buffer for all remainders', () => {
    for (const n of [0, 1, 2, 3, 4, 5, 255]) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37) & 255);
      const b64 = bytesToBase64(bytes);
      expect(b64).toBe(Buffer.from(bytes).toString('base64'));
      expect(Array.from(base64ToBytes(b64))).toEqual(Array.from(bytes));
    }
  });

  it('round-trips PCM16 through base64', () => {
    const pcm = Int16Array.from([0, 1, -1, 32767, -32768, 1234, -4321]);
    expect(Array.from(base64ToPcm16(pcm16ToBase64(pcm)))).toEqual(Array.from(pcm));
  });

  it('converts float to pcm with clamping', () => {
    expect(Array.from(floatToPcm16([0, 1, -1, 2, -2]))).toEqual([0, 32767, -32768, 32767, -32768]);
    const back = pcm16ToFloat(Int16Array.from([32767, -32768]));
    expect(back[0]).toBeCloseTo(1);
    expect(back[1]).toBeCloseTo(-1);
  });

  it('resamples 48k to 24k by halving length', () => {
    const input = Float32Array.from({ length: 480 }, (_, i) => Math.sin(i / 10));
    const out = resample(input, 48000, 24000);
    expect(out.length).toBe(240);
    expect(out[10]).toBeCloseTo(input[20]!, 5);
    expect(resample(input, 24000, 24000)).not.toBe(input);
  });
});

describe('speechEnvelope', () => {
  it('produces pulses for vowels and silence for punctuation', () => {
    const env = speechEnvelope('Hello. Hi', 40, 160);
    expect(env.length).toBeGreaterThan(0);
    expect(Math.max(...env)).toBeLessThanOrEqual(1);
    expect(env.some((v) => v === 0)).toBe(true);
    expect(speechEnvelope('...')).toEqual(new Array(24).fill(0));
  });

  it('is deterministic', () => {
    expect(speechEnvelope('The time in Tokyo')).toEqual(speechEnvelope('The time in Tokyo'));
  });
});
