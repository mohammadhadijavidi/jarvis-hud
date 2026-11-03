/**
 * Neural core renderer (Canvas 2D, additive blending).
 *
 * A Fibonacci-lattice sphere of nodes linked to nearest neighbours, deformed
 * by voice level, with signal pulses travelling along edges, a radial
 * spectrum ring and rotating instrument rings. Colour and motion follow the
 * assistant state.
 */
import type { AssistantState } from '../protocol';
import {
  type RGB,
  type Vec3,
  fibonacciSphere,
  lerp,
  mixRgb,
  nearestEdges,
  project,
  rgba,
  rotate,
  sphereNoise,
} from './geometry';

export const PALETTE: Record<AssistantState, { core: RGB; accent: RGB }> = {
  idle: { core: [110, 178, 214], accent: [110, 178, 214] },
  listening: { core: [143, 227, 255], accent: [190, 242, 255] },
  thinking: { core: [176, 214, 255], accent: [255, 177, 92] },
  speaking: { core: [255, 196, 128], accent: [255, 236, 210] },
};

interface Pulse {
  edge: number;
  t: number;
  speed: number;
  dir: 1 | -1;
}

export interface CoreInputs {
  state: AssistantState;
  /** 0..1 user mic level. */
  userLevel: number;
  /** 0..1 assistant voice level. */
  voiceLevel: number;
  /** Optional live spectrum (0..1 per bar). */
  spectrum?: number[];
}

const BARS = 120;

export class NeuralCore {
  private ctx: CanvasRenderingContext2D;
  private pts: Vec3[];
  private edges: Array<[number, number]>;
  private pulses: Pulse[] = [];
  private proj: Array<{ x: number; y: number; s: number; depth: number }> = [];
  private w = 0;
  private h = 0;
  private dpr = 1;
  private t = 0;
  private last = 0;
  private raf = 0;
  private col: RGB = PALETTE.idle.core;
  private acc: RGB = PALETTE.idle.accent;
  private energy = 0;
  private spin = 0;
  private bars = new Array<number>(BARS).fill(0);
  private reduced: boolean;
  inputs: CoreInputs = { state: 'idle', userLevel: 0, voiceLevel: 0 };
  /** Fixed time step mode for deterministic screenshots. */
  frozenTime: number | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    nodes = 360,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D not available');
    this.ctx = ctx;
    this.pts = fibonacciSphere(nodes);
    this.edges = nearestEdges(this.pts, 3);
    this.reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  resize(): void {
    this.dpr = Math.min(2, devicePixelRatio || 1);
    const r = this.canvas.getBoundingClientRect();
    this.w = Math.max(1, r.width);
    this.h = Math.max(1, r.height);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
  }

  start(): void {
    const loop = (now: number) => {
      const dt = this.last ? Math.min(0.05, (now - this.last) / 1000) : 0.016;
      this.last = now;
      this.frame(this.reduced ? dt * 0.35 : dt);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
  }

  private level(): number {
    const { state, userLevel, voiceLevel } = this.inputs;
    if (state === 'speaking') return voiceLevel;
    if (state === 'listening') return userLevel;
    return Math.max(userLevel * 0.5, voiceLevel * 0.5);
  }

  frame(dt: number): void {
    const { ctx, w, h, dpr } = this;
    this.t = this.frozenTime ?? this.t + dt;
    const t = this.t;
    const pal = PALETTE[this.inputs.state];
    const k = 1 - Math.exp(-dt * 4);
    this.col = mixRgb(this.col, pal.core, k);
    this.acc = mixRgb(this.acc, pal.accent, k);
    const lvl = this.level();
    this.energy = lerp(this.energy, lvl, lvl > this.energy ? 0.5 : 0.08);
    const e = this.energy;
    const thinking = this.inputs.state === 'thinking';
    this.spin += dt * (0.12 + e * 0.5 + (thinking ? 0.55 : 0));

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, w, h);

    const cx = w / 2;
    const cy = h * 0.44;
    const R = w < 640 ? Math.min(w * 0.22, h * 0.2) : Math.min(w * 0.15, h * 0.2, (h - 250) / 3.6);

    ctx.globalCompositeOperation = 'lighter';

    // Ambient bloom
    const bloom = ctx.createRadialGradient(cx, cy, R * 0.1, cx, cy, R * 2.6);
    bloom.addColorStop(0, rgba(this.col, 0.2 + e * 0.25));
    bloom.addColorStop(0.35, rgba(this.col, 0.07 + e * 0.08));
    bloom.addColorStop(1, rgba(this.col, 0));
    ctx.fillStyle = bloom;
    ctx.fillRect(cx - R * 2.6, cy - R * 2.6, R * 5.2, R * 5.2);

    // Deformed, rotated sphere
    const ay = this.spin;
    const ax = 0.38 + Math.sin(t * 0.21) * 0.12;
    const breathe = 1 + Math.sin(t * 1.4) * 0.012;
    for (let i = 0; i < this.pts.length; i++) {
      const p = this.pts[i]!;
      const n = sphereNoise(p, t * (0.7 + e * 2.4));
      const d = breathe * (1 + n * (0.035 + e * 0.17));
      const rp = rotate({ x: p.x * d, y: p.y * d, z: p.z * d }, ay, ax);
      this.proj[i] = project(rp, R * 0.82, cx, cy);
    }

    // Edges, bucketed by depth for fewer state changes
    const buckets: Array<Array<[number, number]>> = [[], [], []];
    for (const edge of this.edges) {
      const dd = (this.proj[edge[0]]!.depth + this.proj[edge[1]]!.depth) / 2;
      buckets[dd > 0.66 ? 2 : dd > 0.36 ? 1 : 0]!.push(edge);
    }
    const edgeAlpha = [0.05, 0.12, 0.26];
    for (let b = 0; b < 3; b++) {
      ctx.strokeStyle = rgba(this.col, edgeAlpha[b]! * (0.8 + e * 0.9));
      ctx.lineWidth = b === 2 ? 0.9 : 0.6;
      ctx.beginPath();
      for (const [i, j] of buckets[b]!) {
        const a = this.proj[i]!;
        const c = this.proj[j]!;
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(c.x, c.y);
      }
      ctx.stroke();
    }

    // Nodes
    for (let i = 0; i < this.proj.length; i++) {
      const q = this.proj[i]!;
      const flick = 0.5 + 0.5 * Math.sin(t * 3 + i * 12.9898);
      const a = 0.12 + q.depth * 0.6 + e * 0.25 * flick;
      const r = (0.6 + q.depth * 1.3) * (1 + e * 0.4);
      ctx.fillStyle = rgba(mixRgb(this.col, [255, 255, 255], q.depth * 0.35), a);
      ctx.beginPath();
      ctx.arc(q.x, q.y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Signal pulses along edges
    const spawn = (thinking ? 26 : 5) + e * 60;
    let toSpawn = spawn * dt;
    while (toSpawn > 0 && this.pulses.length < 140) {
      if (toSpawn < 1 && Math.random() > toSpawn) break;
      toSpawn -= 1;
      this.pulses.push({
        edge: Math.floor(Math.random() * this.edges.length),
        t: 0,
        speed: 1.2 + Math.random() * 2.2,
        dir: Math.random() > 0.5 ? 1 : -1,
      });
    }
    this.pulses = this.pulses.filter((p) => p.t < 1);
    for (const p of this.pulses) {
      p.t += dt * p.speed;
      const [i, j] = this.edges[p.edge]!;
      const a = this.proj[p.dir === 1 ? i : j]!;
      const b = this.proj[p.dir === 1 ? j : i]!;
      const x = lerp(a.x, b.x, p.t);
      const y = lerp(a.y, b.y, p.t);
      const depth = lerp(a.depth, b.depth, p.t);
      const alpha = Math.sin(Math.PI * p.t) * (0.35 + depth * 0.65);
      const g = ctx.createRadialGradient(x, y, 0, x, y, 7 + depth * 5);
      g.addColorStop(0, rgba(this.acc, alpha));
      g.addColorStop(1, rgba(this.acc, 0));
      ctx.fillStyle = g;
      ctx.fillRect(x - 12, y - 12, 24, 24);
      ctx.strokeStyle = rgba(this.acc, alpha * 0.8);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(lerp(a.x, b.x, Math.max(0, p.t - 0.25)), lerp(a.y, b.y, Math.max(0, p.t - 0.25)));
      ctx.lineTo(x, y);
      ctx.stroke();
    }

    // Hot inner core
    const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * (0.42 + e * 0.18));
    core.addColorStop(0, rgba([255, 255, 255], 0.5 + e * 0.35));
    core.addColorStop(0.18, rgba(this.acc, 0.35 + e * 0.3));
    core.addColorStop(0.6, rgba(this.col, 0.08 + e * 0.08));
    core.addColorStop(1, rgba(this.col, 0));
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.7, 0, Math.PI * 2);
    ctx.fill();

    this.drawRings(cx, cy, R, t, e);
  }

  private drawRings(cx: number, cy: number, R: number, t: number, e: number): void {
    const { ctx } = this;
    const TAU = Math.PI * 2;

    // Spectrum bars
    const src = this.inputs.spectrum;
    for (let b = 0; b < BARS; b++) {
      let target: number;
      if (src && src.length) {
        target = src[Math.floor((b / BARS) * src.length)] ?? 0;
      } else {
        const m = Math.abs(Math.sin(b * 0.37 + t * 5.1)) * 0.55 + Math.abs(Math.sin(b * 0.11 - t * 3.3)) * 0.45;
        target = e * m;
      }
      const mirrored = b < BARS / 2 ? b : BARS - 1 - b;
      const shape = 0.55 + 0.45 * Math.cos((mirrored / (BARS / 2)) * Math.PI * 0.5);
      this.bars[b] = lerp(this.bars[b]!, target * shape, target > this.bars[b]! ? 0.6 : 0.12);
    }
    const r0 = R * 1.18;
    ctx.lineCap = 'round';
    for (let b = 0; b < BARS; b++) {
      const v = this.bars[b]!;
      const ang = (b / BARS) * TAU - Math.PI / 2;
      const len = 2 + v * R * 0.42;
      const cos = Math.cos(ang);
      const sin = Math.sin(ang);
      ctx.strokeStyle = rgba(mixRgb(this.col, this.acc, v), 0.18 + v * 0.75);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx + cos * r0, cy + sin * r0);
      ctx.lineTo(cx + cos * (r0 + len), cy + sin * (r0 + len));
      ctx.stroke();
    }
    ctx.lineCap = 'butt';

    // Fine tick ring
    const r1 = R * 1.12;
    ctx.strokeStyle = rgba(this.col, 0.28);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < 180; i++) {
      const a = (i / 180) * TAU + t * 0.03;
      const len = i % 15 === 0 ? 7 : 3;
      ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      ctx.lineTo(cx + Math.cos(a) * (r1 - len), cy + Math.sin(a) * (r1 - len));
    }
    ctx.stroke();

    // Segmented outer ring, counter-rotating
    const r2 = R * 1.72;
    ctx.lineWidth = 2;
    for (let s = 0; s < 6; s++) {
      const a0 = (s / 6) * TAU - t * 0.08;
      ctx.strokeStyle = rgba(this.col, s % 2 ? 0.16 : 0.38);
      ctx.beginPath();
      ctx.arc(cx, cy, r2, a0, a0 + TAU / 6 - 0.12);
      ctx.stroke();
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = rgba(this.col, 0.1);
    ctx.beginPath();
    ctx.arc(cx, cy, r2 + 9, 0, TAU);
    ctx.stroke();

    // Thinking scanner / listening ripples
    if (this.inputs.state === 'thinking') {
      const a = t * 2.6;
      const grad = ctx.createConicGradient ? ctx.createConicGradient(a - 0.9, cx, cy) : null;
      if (grad) {
        grad.addColorStop(0, rgba(this.acc, 0));
        grad.addColorStop(0.14, rgba(this.acc, 0.22));
        grad.addColorStop(0.145, rgba(this.acc, 0));
        grad.addColorStop(1, rgba(this.acc, 0));
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(cx, cy, r2, 0, TAU);
        ctx.arc(cx, cy, r0, 0, TAU, true);
        ctx.fill();
      }
      ctx.strokeStyle = rgba(this.acc, 0.9);
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(cx, cy, r2, a - 0.35, a);
      ctx.stroke();
    }
    if (this.inputs.state === 'listening') {
      for (let k = 0; k < 3; k++) {
        const ph = (t * 0.6 + k / 3) % 1;
        ctx.strokeStyle = rgba(this.col, (1 - ph) * 0.25 * (0.4 + e));
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(cx, cy, r0 + ph * (r2 - r0), 0, TAU);
        ctx.stroke();
      }
    }

    // Bearing marks
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = rgba(this.col, 0.45);
    ctx.font = '500 10px "Chakra Petch", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const r3 = r2 + 24;
    // Skip bearing labels when they would collide with the top bar.
    if (cy - r3 < 96) {
      ctx.globalCompositeOperation = 'lighter';
      return;
    }
    for (const [deg, label] of [
      [0, '000'],
      [90, '090'],
      [180, '180'],
      [270, '270'],
    ] as const) {
      const a = (deg / 180) * Math.PI - Math.PI / 2;
      ctx.fillText(label, cx + Math.cos(a) * r3, cy + Math.sin(a) * r3);
    }
    ctx.globalCompositeOperation = 'lighter';
  }
}
