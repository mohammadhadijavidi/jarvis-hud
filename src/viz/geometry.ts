/** Pure geometry + math for the neural core. No DOM, fully testable. */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Evenly distributed points on a unit sphere (Fibonacci lattice). */
export function fibonacciSphere(n: number): Vec3[] {
  const pts: Vec3[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = n === 1 ? 0 : 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const t = golden * i;
    pts.push({ x: Math.cos(t) * r, y, z: Math.sin(t) * r });
  }
  return pts;
}

/**
 * Undirected edges linking each point to its k nearest neighbours.
 * O(n^2) but only run once at startup for a few hundred points.
 */
export function nearestEdges(pts: Vec3[], k: number): Array<[number, number]> {
  const seen = new Set<number>();
  const edges: Array<[number, number]> = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i]!;
    const d: Array<[number, number]> = [];
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const b = pts[j]!;
      d.push([(a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2, j]);
    }
    d.sort((p, q) => p[0] - q[0]);
    for (let m = 0; m < Math.min(k, d.length); m++) {
      const j = d[m]![1];
      const lo = Math.min(i, j);
      const hi = Math.max(i, j);
      const key = lo * n + hi;
      if (!seen.has(key)) {
        seen.add(key);
        edges.push([lo, hi]);
      }
    }
  }
  return edges;
}

/** Rotate around Y then X. */
export function rotate(p: Vec3, ay: number, ax: number): Vec3 {
  const cy = Math.cos(ay);
  const sy = Math.sin(ay);
  const x1 = p.x * cy + p.z * sy;
  const z1 = -p.x * sy + p.z * cy;
  const cx = Math.cos(ax);
  const sx = Math.sin(ax);
  return { x: x1, y: p.y * cx - z1 * sx, z: p.y * sx + z1 * cx };
}

/** Perspective projection. Returns screen coords and a 0..1 depth (1 = nearest). */
export function project(p: Vec3, radius: number, cx: number, cy: number, fov = 3.2): { x: number; y: number; s: number; depth: number } {
  const s = fov / (fov - p.z);
  return { x: cx + p.x * radius * s, y: cy + p.y * radius * s, s, depth: (p.z + 1) / 2 };
}

/** Cheap smooth pseudo-noise on the sphere, in -1..1. */
export function sphereNoise(p: Vec3, t: number): number {
  return (
    Math.sin(p.x * 3.1 + t * 1.3) * Math.sin(p.y * 2.7 - t * 0.9) * 0.6 +
    Math.sin(p.z * 4.3 + p.x * 1.7 + t * 2.1) * 0.4
  );
}

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export type RGB = [number, number, number];

export function mixRgb(a: RGB, b: RGB, t: number): RGB {
  const k = clamp01(t);
  return [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)];
}

export function rgba(c: RGB, a: number): string {
  return `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${clamp01(a).toFixed(3)})`;
}

/** Smooth N bars of a radial spectrum from analyser bytes (0..255) into 0..1 values. */
export function binSpectrum(bytes: ArrayLike<number>, bars: number, maxBin = bytes.length): number[] {
  const out = new Array<number>(bars).fill(0);
  const usable = Math.max(1, Math.min(bytes.length, maxBin));
  for (let b = 0; b < bars; b++) {
    // log-ish spacing so speech frequencies get more bars
    const start = Math.floor(usable * (b / bars) ** 1.6);
    const end = Math.max(start + 1, Math.floor(usable * ((b + 1) / bars) ** 1.6));
    let sum = 0;
    for (let i = start; i < end; i++) sum += bytes[i] ?? 0;
    out[b] = sum / (end - start) / 255;
  }
  return out;
}
