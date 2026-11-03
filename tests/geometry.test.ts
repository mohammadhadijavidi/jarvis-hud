import { describe, expect, it } from 'vitest';
import { binSpectrum, fibonacciSphere, mixRgb, nearestEdges, project, rgba, rotate } from '../src/viz/geometry';
import { backoffMs, resolveWsUrl } from '../src/net/url';

describe('neural core geometry', () => {
  it('fibonacci points lie on the unit sphere', () => {
    const pts = fibonacciSphere(200);
    expect(pts).toHaveLength(200);
    for (const p of pts) expect(Math.hypot(p.x, p.y, p.z)).toBeCloseTo(1, 6);
  });

  it('nearest edges are unique and undirected', () => {
    const pts = fibonacciSphere(100);
    const edges = nearestEdges(pts, 3);
    const keys = new Set(edges.map(([a, b]) => `${a}-${b}`));
    expect(keys.size).toBe(edges.length);
    for (const [a, b] of edges) expect(a).toBeLessThan(b);
    expect(edges.length).toBeGreaterThanOrEqual(150);
    expect(edges.length).toBeLessThanOrEqual(300);
  });

  it('rotation preserves length', () => {
    const r = rotate({ x: 0.3, y: -0.4, z: 0.866 }, 1.2, -0.7);
    expect(Math.hypot(r.x, r.y, r.z)).toBeCloseTo(Math.hypot(0.3, -0.4, 0.866), 9);
  });

  it('projection puts nearer points larger and further from centre', () => {
    const near = project({ x: 1, y: 0, z: 0.9 }, 100, 0, 0);
    const far = project({ x: 1, y: 0, z: -0.9 }, 100, 0, 0);
    expect(near.s).toBeGreaterThan(far.s);
    expect(near.x).toBeGreaterThan(far.x);
    expect(near.depth).toBeGreaterThan(far.depth);
  });

  it('colour helpers clamp', () => {
    expect(mixRgb([0, 0, 0], [100, 200, 50], 2)).toEqual([100, 200, 50]);
    expect(rgba([1.4, 2, 3], 3)).toBe('rgba(1,2,3,1.000)');
  });

  it('bins a spectrum into normalized bars', () => {
    const bytes = new Uint8Array(512).fill(255);
    const bars = binSpectrum(bytes, 32, 300);
    expect(bars).toHaveLength(32);
    for (const b of bars) expect(b).toBeCloseTo(1);
    expect(binSpectrum(new Uint8Array(512), 8).every((b) => b === 0)).toBe(true);
  });
});

describe('connection helpers', () => {
  const loc = { protocol: 'https:', host: 'hud.example.com', search: '' };
  it('resolves ws url by priority', () => {
    expect(resolveWsUrl(loc)).toBe('wss://hud.example.com/ws');
    expect(resolveWsUrl({ ...loc, protocol: 'http:' })).toBe('ws://hud.example.com/ws');
    expect(resolveWsUrl(loc, 'ws://env/ws')).toBe('ws://env/ws');
    expect(resolveWsUrl({ ...loc, search: '?ws=ws://q:1/x' }, 'ws://env/ws')).toBe('ws://q:1/x');
  });
  it('backs off exponentially with a cap', () => {
    expect([0, 1, 2, 3, 10].map((a) => backoffMs(a))).toEqual([500, 1000, 2000, 4000, 8000]);
  });
});
