/** Resolve which WebSocket the HUD connects to. Priority: ?ws= > build-time env > same-origin /ws. */
export function resolveWsUrl(location: { protocol: string; host: string; search: string }, envUrl?: string): string {
  const q = new URLSearchParams(location.search).get('ws');
  if (q) return q;
  if (envUrl) return envUrl;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

/** Exponential reconnect backoff with a ceiling. attempt starts at 0. */
export function backoffMs(attempt: number, base = 500, max = 8000): number {
  return Math.min(max, base * 2 ** Math.max(0, attempt));
}
