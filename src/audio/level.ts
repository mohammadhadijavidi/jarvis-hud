/** Pure audio helpers shared by the browser HUD and the Node backends. */

/** Root-mean-square of a block of float samples (-1..1). */
export function rms(samples: ArrayLike<number>): number {
  const n = samples.length;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = samples[i] ?? 0;
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

/**
 * Map a raw RMS value to a perceptual 0..1 level using a dB scale.
 * floorDb is treated as silence, 0 dBFS as full scale.
 */
export function rmsToLevel(value: number, floorDb = -60): number {
  if (!(value > 0)) return 0;
  const db = 20 * Math.log10(value);
  if (db <= floorDb) return 0;
  return Math.min(1, (db - floorDb) / -floorDb);
}

/**
 * Asymmetric envelope follower: fast attack, slow release, so the visual
 * jumps with a syllable and decays smoothly afterwards.
 */
export class Envelope {
  value = 0;
  constructor(
    private attack = 0.55,
    private release = 0.08,
  ) {}
  next(target: number): number {
    const t = Math.min(1, Math.max(0, target));
    const k = t > this.value ? this.attack : this.release;
    this.value += (t - this.value) * k;
    if (this.value < 1e-4) this.value = 0;
    return this.value;
  }
  reset(): void {
    this.value = 0;
  }
}

/** Float32 (-1..1) -> PCM16 little-endian. Values are clamped. */
export function floatToPcm16(input: ArrayLike<number>): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i] ?? 0));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

/** PCM16 -> Float32 (-1..1). */
export function pcm16ToFloat(input: Int16Array): Float32Array {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = (input[i] ?? 0) / ((input[i] ?? 0) < 0 ? 0x8000 : 0x7fff);
  return out;
}

/** Linear-interpolating resampler (good enough for speech to 16/24 kHz). */
export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || input.length === 0) return input.slice();
  const ratio = fromRate / toRate;
  const outLen = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(input.length - 1, i0 + 1);
    const frac = pos - i0;
    out[i] = (input[i0] ?? 0) * (1 - frac) + (input[i1] ?? 0) * frac;
  }
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Bytes -> base64 without relying on Buffer or btoa (works in both runtimes). */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i]! << 16;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + '==';
  } else if (rem === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + '=';
  }
  return out;
}

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const len = Math.floor((clean.length * 3) / 4);
  const out = new Uint8Array(len);
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = B64.indexOf(clean[i] ?? 'A');
    const b = B64.indexOf(clean[i + 1] ?? 'A');
    const c = i + 2 < clean.length ? B64.indexOf(clean[i + 2]!) : -1;
    const d = i + 3 < clean.length ? B64.indexOf(clean[i + 3]!) : -1;
    const n = (a << 18) | (b << 12) | ((c < 0 ? 0 : c) << 6) | (d < 0 ? 0 : d);
    if (o < len) out[o++] = (n >> 16) & 255;
    if (c >= 0 && o < len) out[o++] = (n >> 8) & 255;
    if (d >= 0 && o < len) out[o++] = n & 255;
  }
  return out.subarray(0, o);
}

export function pcm16ToBase64(pcm: Int16Array): string {
  // PCM16 is little-endian on the wire; normalise in case the host is big-endian.
  const bytes = new Uint8Array(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i]!;
    bytes[i * 2] = v & 0xff;
    bytes[i * 2 + 1] = (v >> 8) & 0xff;
  }
  return bytesToBase64(bytes);
}

export function base64ToPcm16(b64: string): Int16Array {
  const bytes = base64ToBytes(b64);
  const out = new Int16Array(Math.floor(bytes.length / 2));
  for (let i = 0; i < out.length; i++) {
    const v = bytes[i * 2]! | (bytes[i * 2 + 1]! << 8);
    out[i] = v >= 0x8000 ? v - 0x10000 : v;
  }
  return out;
}

/**
 * Synthesize a speech-like loudness envelope for text, for backends that
 * produce text but no audio. Each vowel group becomes a short "syllable" pulse,
 * punctuation becomes a pause. Returns levels sampled every `stepMs`.
 * This drives the visualization only; it is not audio.
 */
export function speechEnvelope(text: string, stepMs = 40, syllableMs = 170): number[] {
  const out: number[] = [];
  const tokens = text.toLowerCase().match(/[aeiouy]+|[.,!?;:]|\s+|[^aeiouy\s.,!?;:]+/g) ?? [];
  const steps = Math.max(1, Math.round(syllableMs / stepMs));
  let seed = 7;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (const tok of tokens) {
    if (/^[aeiouy]+$/.test(tok)) {
      const peak = 0.45 + rand() * 0.5;
      for (let i = 0; i < steps; i++) {
        const x = i / (steps - 1 || 1);
        out.push(peak * Math.sin(Math.PI * x) ** 0.7);
      }
    } else if (/^[.!?;:]$/.test(tok)) {
      for (let i = 0; i < steps * 2; i++) out.push(0);
    } else if (tok === ',') {
      for (let i = 0; i < steps; i++) out.push(0);
    }
  }
  return out;
}
