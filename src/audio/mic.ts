/**
 * Microphone capture: level + spectrum for the visualization, and optional
 * PCM16 streaming (24 kHz) for speech-to-speech backends.
 */
import { floatToPcm16, pcm16ToBase64, resample, rms, rmsToLevel } from './level';

const WORKLET = `
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('jarvis-tap', Tap);
`;

export class Mic {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private analyser: AnalyserNode | null = null;
  private node: AudioWorkletNode | null = null;
  private buf = new Float32Array(0);
  private freq = new Uint8Array(0);
  private pending: Float32Array[] = [];
  active = false;

  constructor(private onChunk?: (b64: string) => void) {}

  async start(streamPcm: boolean): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.ctx = new AudioContext();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.7;
    src.connect(this.analyser);
    this.buf = new Float32Array(this.analyser.fftSize);
    this.freq = new Uint8Array(this.analyser.frequencyBinCount);
    if (streamPcm && this.onChunk) {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
      await this.ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      this.node = new AudioWorkletNode(this.ctx, 'jarvis-tap');
      const rate = this.ctx.sampleRate;
      this.node.port.onmessage = (ev: MessageEvent<Float32Array>) => {
        this.pending.push(ev.data);
        // ~100 ms frames
        const total = this.pending.reduce((n, a) => n + a.length, 0);
        if (total < rate / 10) return;
        const joined = new Float32Array(total);
        let o = 0;
        for (const a of this.pending) {
          joined.set(a, o);
          o += a.length;
        }
        this.pending = [];
        this.onChunk?.(pcm16ToBase64(floatToPcm16(resample(joined, rate, 24000))));
      };
      src.connect(this.node);
    }
    this.active = true;
  }

  level(): number {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.buf);
    return rmsToLevel(rms(this.buf), -55);
  }

  spectrum(): Uint8Array | null {
    if (!this.analyser) return null;
    this.analyser.getByteFrequencyData(this.freq);
    return this.freq;
  }

  stop(): void {
    this.active = false;
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.ctx = null;
    this.analyser = null;
    this.node = null;
    this.stream = null;
  }
}
