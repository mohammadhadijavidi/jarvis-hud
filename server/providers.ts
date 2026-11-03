/**
 * Minimal LLM provider layer.
 *
 * - openai-compatible: OpenAI, OpenRouter, Groq, Ollama, LM Studio, vLLM ... (Chat Completions + tools)
 * - anthropic: Anthropic Messages API (+ tool_use)
 * - mock: deterministic, offline, clearly labeled as simulated
 */
import { mockChat } from './mock.js';

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCallRequest {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCallRequest[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface ProviderReply {
  text: string;
  toolCalls: ToolCallRequest[];
}

export interface Provider {
  /** Provider id, e.g. "openai", "anthropic", "mock". */
  id: string;
  model: string;
  /** True when replies do not come from a real model. */
  simulated: boolean;
  chat(messages: ChatMessage[], tools: ToolSpec[]): Promise<ProviderReply>;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface ProviderConfig {
  provider: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  fetch?: FetchLike;
}

interface Preset {
  baseUrl: string;
  model: string;
  keyEnv?: string;
}

export const OPENAI_COMPATIBLE_PRESETS: Record<string, Preset> = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', keyEnv: 'OPENAI_API_KEY' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini', keyEnv: 'OPENROUTER_API_KEY' },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', keyEnv: 'GROQ_API_KEY' },
  ollama: { baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' },
  lmstudio: { baseUrl: 'http://localhost:1234/v1', model: 'local-model' },
  'openai-compatible': { baseUrl: 'http://localhost:8000/v1', model: 'default' },
};

/** Build provider config from environment variables. */
export function configFromEnv(env: Record<string, string | undefined> = process.env): ProviderConfig {
  const provider = (env.JARVIS_PROVIDER || 'mock').toLowerCase();
  const preset = OPENAI_COMPATIBLE_PRESETS[provider];
  const apiKey =
    env.JARVIS_API_KEY ||
    (provider === 'anthropic' ? env.ANTHROPIC_API_KEY : preset?.keyEnv ? env[preset.keyEnv] : undefined);
  return {
    provider,
    model: env.JARVIS_MODEL || undefined,
    baseUrl: env.JARVIS_BASE_URL || undefined,
    apiKey: apiKey || undefined,
    temperature: env.JARVIS_TEMPERATURE ? Number(env.JARVIS_TEMPERATURE) : undefined,
  };
}

export function createProvider(cfg: ProviderConfig): Provider {
  const doFetch: FetchLike = cfg.fetch ?? ((url, init) => fetch(url, init) as ReturnType<FetchLike>);
  if (cfg.provider === 'mock') {
    return { id: 'mock', model: 'scripted', simulated: true, chat: async (m) => mockChat(m) };
  }
  if (cfg.provider === 'anthropic') {
    if (!cfg.apiKey) throw new Error('ANTHROPIC_API_KEY (or JARVIS_API_KEY) is required for provider "anthropic"');
    return anthropicProvider({ ...cfg, apiKey: cfg.apiKey }, doFetch);
  }
  const preset = OPENAI_COMPATIBLE_PRESETS[cfg.provider];
  if (!preset) {
    throw new Error(
      `Unknown provider "${cfg.provider}". Use one of: mock, anthropic, ${Object.keys(OPENAI_COMPATIBLE_PRESETS).join(', ')}`,
    );
  }
  if (preset.keyEnv && !cfg.apiKey) {
    throw new Error(`${preset.keyEnv} (or JARVIS_API_KEY) is required for provider "${cfg.provider}"`);
  }
  return openAICompatibleProvider(
    { ...cfg, baseUrl: cfg.baseUrl ?? preset.baseUrl, model: cfg.model ?? preset.model },
    doFetch,
  );
}

async function readJson(res: Awaited<ReturnType<FetchLike>>, who: string): Promise<Record<string, unknown>> {
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    throw new Error(`${who} request failed (HTTP ${res.status}) ${detail}`.trim());
  }
  return (await res.json()) as Record<string, unknown>;
}

function safeParseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : { value: v };
  } catch {
    return { raw };
  }
}

/** Convert our message list to the OpenAI Chat Completions shape. */
export function toOpenAIMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

function openAICompatibleProvider(cfg: ProviderConfig & { baseUrl: string; model: string }, doFetch: FetchLike): Provider {
  const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  return {
    id: cfg.provider,
    model: cfg.model,
    simulated: false,
    async chat(messages, tools) {
      const body: Record<string, unknown> = {
        model: cfg.model,
        messages: toOpenAIMessages(messages),
        temperature: cfg.temperature ?? 0.4,
      };
      if (cfg.maxTokens) body.max_tokens = cfg.maxTokens;
      if (tools.length) {
        body.tools = tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
      }
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
      const json = await readJson(await doFetch(url, { method: 'POST', headers, body: JSON.stringify(body) }), cfg.provider);
      const choice = ((json.choices as unknown[]) ?? [])[0] as Record<string, unknown> | undefined;
      const msg = (choice?.message ?? {}) as Record<string, unknown>;
      const calls = ((msg.tool_calls as unknown[]) ?? []).map((c, i) => {
        const call = c as Record<string, unknown>;
        const fn = (call.function ?? {}) as Record<string, unknown>;
        return { id: String(call.id ?? `call_${i}`), name: String(fn.name ?? ''), args: safeParseArgs(fn.arguments) };
      });
      return { text: typeof msg.content === 'string' ? msg.content : '', toolCalls: calls.filter((c) => c.name) };
    },
  };
}

/** Convert our message list to Anthropic Messages API shape (system is separate). */
export function toAnthropicMessages(messages: ChatMessage[]): { system: string; messages: unknown[] } {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const out: Array<{ role: 'user' | 'assistant'; content: unknown[] }> = [];
  const push = (role: 'user' | 'assistant', block: unknown) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(block);
    else out.push({ role, content: [block] });
  };
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') push('user', { type: 'text', text: m.content });
    else if (m.role === 'tool') push('user', { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content });
    else {
      if (m.content) push('assistant', { type: 'text', text: m.content });
      for (const c of m.toolCalls ?? []) push('assistant', { type: 'tool_use', id: c.id, name: c.name, input: c.args });
    }
  }
  return { system, messages: out };
}

function anthropicProvider(cfg: ProviderConfig & { apiKey: string }, doFetch: FetchLike): Provider {
  const model = cfg.model ?? 'claude-sonnet-4-5';
  const url = (cfg.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '') + '/v1/messages';
  return {
    id: 'anthropic',
    model,
    simulated: false,
    async chat(messages, tools) {
      const { system, messages: msgs } = toAnthropicMessages(messages);
      const body: Record<string, unknown> = {
        model,
        max_tokens: cfg.maxTokens ?? 1024,
        messages: msgs,
        temperature: cfg.temperature ?? 0.4,
      };
      if (system) body.system = system;
      if (tools.length) body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
      const json = await readJson(
        await doFetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify(body),
        }),
        'anthropic',
      );
      const blocks = (json.content as Array<Record<string, unknown>>) ?? [];
      const text = blocks
        .filter((b) => b.type === 'text')
        .map((b) => String(b.text ?? ''))
        .join('');
      const toolCalls = blocks
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({ id: String(b.id), name: String(b.name), args: safeParseArgs(b.input) }));
      return { text, toolCalls };
    },
  };
}
