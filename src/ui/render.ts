/** DOM rendering of HUD panels from {@link HudState}. Keyed, incremental, no framework. */
import type { HudState, ToolCard, Utterance } from '../state/store';
import { rows, summarize } from '../state/store';
import type { AssistantState } from '../protocol';

export const STATE_WORDS: Record<AssistantState, string> = {
  idle: 'Standing by',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function clock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

export function formatMs(ms?: number): string {
  if (ms === undefined) return '';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export class Renderer {
  private utterEls = new Map<string, HTMLLIElement>();
  private toolEls = new Map<string, HTMLLIElement>();
  private toolSig = new Map<string, string>();

  render(s: HudState): void {
    const hud = $('hud');
    hud.dataset.state = s.assistant;
    $('state-word').textContent = s.connection === 'open' ? STATE_WORDS[s.assistant] : s.connection === 'connecting' ? 'Linking' : 'Offline';

    const link = $('t-link');
    link.dataset.s = s.connection;
    link.textContent = s.connection === 'open' ? 'Online' : s.connection === 'connecting' ? 'Connecting' : 'Offline';
    $('t-backend').textContent = s.meta?.backend ?? '-';
    $('t-model').textContent = s.meta ? [s.meta.provider, s.meta.model].filter(Boolean).join(' / ') || '-' : '-';
    $('t-turns').textContent = String(s.turns);
    $('sim').hidden = !s.meta?.simulated;

    this.renderTranscript(s.transcript);
    this.renderTools(s.tools);

    const lastAssistant = [...s.transcript].reverse().find((u) => u.role === 'assistant');
    const lastUser = [...s.transcript].reverse().find((u) => u.role === 'user');
    const cap = $('caption');
    cap.textContent =
      s.assistant === 'speaking' && lastAssistant
        ? lastAssistant.text
        : s.assistant === 'thinking' && lastUser
          ? lastUser.text
          : '';
  }

  private renderTranscript(list: Utterance[]): void {
    const root = $('transcript');
    $('transcript-empty').hidden = list.length > 0;
    const keep = new Set(list.map((u) => u.id));
    for (const [id, node] of this.utterEls) {
      if (!keep.has(id)) {
        node.remove();
        this.utterEls.delete(id);
      }
    }
    let changed = false;
    for (const u of list) {
      let li = this.utterEls.get(u.id);
      if (!li) {
        li = el('li', 'u');
        const who = el('div', 'who');
        who.append(el('span', '', u.role === 'assistant' ? 'Assistant' : u.role === 'user' ? 'You' : 'System'), el('time', '', clock(u.at)));
        li.append(who, el('p'));
        li.dataset.role = u.role;
        root.append(li);
        this.utterEls.set(u.id, li);
        changed = true;
      }
      const p = li.querySelector('p')!;
      if (p.textContent !== u.text) {
        p.textContent = u.text;
        changed = true;
      }
      li.dataset.final = String(u.final || u.role !== 'assistant');
    }
    if (changed) root.scrollTop = root.scrollHeight;
  }

  private renderTools(list: ToolCard[]): void {
    const root = $('tools');
    $('tools-empty').hidden = list.length > 0;
    $('tool-count').textContent = String(list.length);
    const keep = new Set(list.map((t) => t.id));
    for (const [id, node] of this.toolEls) {
      if (!keep.has(id)) {
        node.remove();
        this.toolEls.delete(id);
        this.toolSig.delete(id);
      }
    }
    // Newest first
    for (let i = list.length - 1; i >= 0; i--) {
      const t = list[i]!;
      const sig = `${t.status}|${t.ms ?? ''}`;
      let li = this.toolEls.get(t.id);
      if (li && this.toolSig.get(t.id) === sig) continue;
      const fresh = el('li', 'tool');
      fresh.dataset.status = t.status;
      const head = el('header');
      head.append(
        el('span', 'name', t.name),
        el('span', 'meta', t.status === 'running' ? 'Running' : t.status === 'error' ? `Failed ${formatMs(t.ms)}` : formatMs(t.ms)),
      );
      const dl = el('dl');
      const args = rows(t.args, 3);
      if (!args.length) dl.append(el('dt', '', 'args'), el('dd', '', 'none'));
      for (const [k, v] of args) dl.append(el('dt', '', k), el('dd', '', v));
      if (t.status !== 'running') {
        dl.append(el('div', 'sep'));
        const res = rows(t.result, 4, t.args);
        if (!res.length) dl.append(el('dt', '', 'result'), el('dd', 'out', summarize(t.result) || 'ok'));
        for (const [k, v] of res) dl.append(el('dt', '', k), el('dd', 'out', v));
      }
      fresh.append(head, dl);
      if (li) li.replaceWith(fresh);
      else root.prepend(fresh);
      this.toolEls.set(t.id, fresh);
      this.toolSig.set(t.id, sig);
      li = fresh;
    }
    // Keep DOM order newest-first
    for (let i = list.length - 1, pos = 0; i >= 0; i--, pos++) {
      const node = this.toolEls.get(list[i]!.id)!;
      if (root.children[pos] !== node) root.insertBefore(node, root.children[pos] ?? null);
    }
  }
}

export function showToast(message: string): void {
  const hud = $('hud');
  hud.querySelector('.toast')?.remove();
  const t = el('div', 'toast', message);
  t.setAttribute('role', 'alert');
  hud.append(t);
  setTimeout(() => t.remove(), 4500);
}
