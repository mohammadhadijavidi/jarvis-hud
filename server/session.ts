/**
 * Agent session: turns HUD client events into HUD server events using any
 * {@link Provider} plus local tools. Transport-agnostic (the WebSocket server
 * just pipes JSON in and out), which makes it easy to test.
 */
import type { ClientEvent, ServerEvent } from '../src/protocol.js';
import { speechEnvelope } from '../src/audio/level.js';
import type { ChatMessage, Provider } from './providers.js';
import type { Tool } from './tools.js';

export interface SessionOptions {
  provider: Provider;
  tools: Tool[];
  emit: (ev: ServerEvent) => void;
  systemPrompt?: string;
  /** Delay between streamed words (ms). 0 disables pacing (tests). */
  wordDelayMs?: number;
  /** Pause to show the "thinking" state (ms). */
  thinkDelayMs?: number;
  /** Emit a synthetic voice level envelope while "speaking" text. */
  levels?: boolean;
  maxToolRounds?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export const DEFAULT_SYSTEM_PROMPT =
  'You are Jarvis, a concise voice assistant shown in a heads-up display. ' +
  'Answer in one to three short spoken sentences. Use tools when they help.';

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class AgentSession {
  private history: ChatMessage[];
  private turn = 0;
  private busy = false;
  private cancelled = false;
  private readonly o: Required<Omit<SessionOptions, 'systemPrompt'>> & { systemPrompt: string };

  constructor(opts: SessionOptions) {
    this.o = {
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      wordDelayMs: 55,
      thinkDelayMs: 350,
      levels: true,
      maxToolRounds: 4,
      sleep: realSleep,
      now: () => Date.now(),
      ...opts,
    };
    this.history = [{ role: 'system', content: this.o.systemPrompt }];
  }

  /** Emit the meta/state preamble for a newly connected HUD. */
  start(): void {
    const p = this.o.provider;
    this.o.emit({
      type: 'meta',
      backend: p.simulated ? 'Mock backend' : 'Agent backend',
      provider: p.id,
      model: p.model,
      simulated: p.simulated,
      accepts: ['text'],
    });
    this.o.emit({ type: 'state', state: 'idle' });
  }

  get isBusy(): boolean {
    return this.busy;
  }

  async handle(ev: ClientEvent): Promise<void> {
    if (ev.type === 'interrupt') {
      this.cancelled = true;
      return;
    }
    if (ev.type === 'user_text') {
      if (this.busy) {
        this.o.emit({ type: 'error', message: 'Still answering the previous request. Interrupt first.' });
        return;
      }
      await this.respond(ev.text);
    }
    if (ev.type === 'audio' || ev.type === 'audio_commit') {
      // Agent mode transcribes speech in the browser (Web Speech API) and sends user_text.
    }
  }

  private async respond(text: string): Promise<void> {
    this.busy = true;
    this.cancelled = false;
    const n = ++this.turn;
    const { emit, sleep } = this.o;
    try {
      emit({ type: 'transcript', id: `u${n}`, role: 'user', text, final: true });
      emit({ type: 'state', state: 'thinking' });
      this.history.push({ role: 'user', content: text });
      if (this.o.thinkDelayMs) await sleep(this.o.thinkDelayMs);

      let reply = await this.o.provider.chat(this.history, this.o.tools);
      let rounds = 0;
      while (reply.toolCalls.length && rounds < this.o.maxToolRounds && !this.cancelled) {
        rounds++;
        this.history.push({ role: 'assistant', content: reply.text, toolCalls: reply.toolCalls });
        for (const call of reply.toolCalls) {
          emit({ type: 'tool_call', id: call.id, name: call.name, args: call.args });
          const t0 = this.o.now();
          const tool = this.o.tools.find((t) => t.name === call.name);
          let content: string;
          try {
            if (!tool) throw new Error(`Unknown tool "${call.name}"`);
            const result = await tool.run(call.args);
            emit({ type: 'tool_result', id: call.id, status: 'ok', result, ms: this.o.now() - t0 });
            content = JSON.stringify(result);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            emit({ type: 'tool_result', id: call.id, status: 'error', result: { error: message }, ms: this.o.now() - t0 });
            content = JSON.stringify({ error: message });
          }
          this.history.push({ role: 'tool', toolCallId: call.id, name: call.name, content });
        }
        reply = await this.o.provider.chat(this.history, this.o.tools);
      }

      const answer = reply.text.trim() || 'Done.';
      this.history.push({ role: 'assistant', content: answer });
      await this.speak(`a${n}`, answer);
    } catch (err) {
      emit({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      emit({ type: 'level', value: 0 });
      emit({ type: 'state', state: 'idle' });
      this.busy = false;
    }
  }

  /** Stream the answer word by word with a matching voice-level envelope. */
  private async speak(id: string, text: string): Promise<void> {
    const { emit, sleep, wordDelayMs, levels } = this.o;
    emit({ type: 'state', state: 'speaking' });
    const words = text.split(/(\s+)/).filter((w) => w.length);
    const env = levels ? speechEnvelope(text, 40) : [];
    const perWord = words.length ? env.length / words.length : 0;
    let li = 0;
    let first = true;
    for (let wi = 0; wi < words.length; wi++) {
      if (this.cancelled) break;
      emit({ type: 'transcript', id, role: 'assistant', text: words[wi]!, delta: !first });
      first = false;
      if (levels) {
        const until = Math.round((wi + 1) * perWord);
        const slice = env.slice(li, until);
        li = until;
        const peak = slice.length ? Math.max(...slice) : 0;
        emit({ type: 'level', value: Math.round(peak * 1000) / 1000 });
      }
      if (wordDelayMs && /\S/.test(words[wi]!)) await sleep(wordDelayMs);
    }
    emit({ type: 'transcript', id, role: 'assistant', text: '', delta: true, final: true });
  }
}
