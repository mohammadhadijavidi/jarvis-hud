/** Gapless playback of streamed PCM16 chunks, with an analyser for the voice level. */
import { base64ToPcm16, pcm16ToFloat, rms, rmsToLevel } from './level';

export class Player {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private at = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private buf = new Float32Array(1024);
  private freq = new Uint8Array(512);

  private ensure(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  enqueue(b64: string, sampleRate = 24000): void {
    const ctx = this.ensure();
    const pcm = pcm16ToFloat(base64ToPcm16(b64));
    if (!pcm.length) return;
    const buffer = ctx.createBuffer(1, pcm.length, sampleRate);
    buffer.getChannelData(0).set(pcm);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.analyser!);
    this.at = Math.max(this.at, ctx.currentTime + 0.03);
    src.start(this.at);
    this.at += buffer.duration;
    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
  }

  get playing(): boolean {
    return this.sources.size > 0;
  }

  level(): number {
    if (!this.analyser || !this.playing) return 0;
    this.analyser.getFloatTimeDomainData(this.buf);
    return rmsToLevel(rms(this.buf), -50);
  }

  spectrum(): Uint8Array | null {
    if (!this.analyser || !this.playing) return null;
    this.analyser.getByteFrequencyData(this.freq);
    return this.freq;
  }

  flush(): void {
    for (const s of this.sources) s.stop();
    this.sources.clear();
    this.at = 0;
  }
}
