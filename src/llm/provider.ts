/**
 * LLM Provider Abstraction
 *
 * Pluggable interface for AI providers.
 * Zero dependencies - uses native fetch for all API calls.
 * Supports: Anthropic Claude, OpenAI, Ollama (local).
 */

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmResponse {
  content: string;
  usage?: { inputTokens: number; outputTokens: number };
  model: string;
}

export interface LlmProvider {
  name: string;
  chat(messages: LlmMessage[], options?: LlmOptions): Promise<LlmResponse>;
}

export interface LlmOptions {
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
}

// ─── Anthropic Claude ────────────────────────────────────────────────────────

export interface ClaudeConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

export class ClaudeProvider implements LlmProvider {
  name = 'claude';
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(config: ClaudeConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'claude-sonnet-4-20250514';
    this.baseUrl = config.baseUrl ?? 'https://api.anthropic.com';
  }

  async chat(messages: LlmMessage[], options?: LlmOptions): Promise<LlmResponse> {
    const systemMsg = messages.find(m => m.role === 'system');
    const nonSystem = messages.filter(m => m.role !== 'system');

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: options?.maxTokens ?? 4096,
      messages: nonSystem.map(m => ({ role: m.role, content: m.content })),
    };

    if (systemMsg) {
      body.system = systemMsg.content;
    }
    if (options?.temperature !== undefined) {
      body.temperature = options.temperature;
    }
    if (options?.stop) {
      body.stop_sequences = options.stop;
    }

    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Claude API error (${res.status}): ${text}`);
    }

    const data = await res.json() as {
      content: { type: string; text: string }[];
      usage: { input_tokens: number; output_tokens: number };
      model: string;
    };

    return {
      content: data.content.map(c => c.text).join(''),
      usage: {
        inputTokens: data.usage.input_tokens,
        outputTokens: data.usage.output_tokens,
      },
      model: data.model,
    };
  }
}

// ─── OpenAI ──────────────────────────────────────────────────────────────────

export interface OpenAiConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

export class OpenAiProvider implements LlmProvider {
  name = 'openai';
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(config: OpenAiConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'gpt-4o';
    this.baseUrl = config.baseUrl ?? 'https://api.openai.com';
  }

  async chat(messages: LlmMessage[], options?: LlmOptions): Promise<LlmResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      max_tokens: options?.maxTokens ?? 4096,
    };
    if (options?.temperature !== undefined) body.temperature = options.temperature;
    if (options?.stop) body.stop = options.stop;

    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenAI API error (${res.status}): ${text}`);
    }

    const data = await res.json() as {
      choices: { message: { content: string } }[];
      usage: { prompt_tokens: number; completion_tokens: number };
      model: string;
    };

    return {
      content: data.choices[0].message.content,
      usage: {
        inputTokens: data.usage.prompt_tokens,
        outputTokens: data.usage.completion_tokens,
      },
      model: data.model,
    };
  }
}

// ─── Ollama (local) ──────────────────────────────────────────────────────────

export interface OllamaConfig {
  model?: string;
  baseUrl?: string;
}

export class OllamaProvider implements LlmProvider {
  name = 'ollama';
  private model: string;
  private baseUrl: string;

  constructor(config?: OllamaConfig) {
    this.model = config?.model ?? 'llama3.1';
    this.baseUrl = config?.baseUrl ?? 'http://localhost:11434';
  }

  async chat(messages: LlmMessage[], options?: LlmOptions): Promise<LlmResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      stream: false,
      options: {
        temperature: options?.temperature ?? 0.7,
        num_predict: options?.maxTokens ?? 4096,
      },
    };
    if (options?.stop) {
      (body.options as Record<string, unknown>).stop = options.stop;
    }

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ollama API error (${res.status}): ${text}`);
    }

    const data = await res.json() as {
      message: { content: string };
      model: string;
      eval_count?: number;
      prompt_eval_count?: number;
    };

    return {
      content: data.message.content,
      usage: {
        inputTokens: data.prompt_eval_count ?? 0,
        outputTokens: data.eval_count ?? 0,
      },
      model: data.model,
    };
  }
}

// ─── Cloudflare Workers AI ────────────────────────────────────────────────────

export interface CloudflareAiConfig {
  apiKey: string;
  accountId: string;
  model?: string;
  /** Optional AI Gateway slug for logging/caching */
  gateway?: string;
}

export class CloudflareAiProvider implements LlmProvider {
  name = 'cloudflare';
  private apiKey: string;
  private accountId: string;
  private model: string;
  private gateway?: string;

  constructor(config: CloudflareAiConfig) {
    this.apiKey = config.apiKey;
    this.accountId = config.accountId;
    this.model = config.model ?? '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
    this.gateway = config.gateway;
  }

  async chat(messages: LlmMessage[], options?: LlmOptions): Promise<LlmResponse> {
    // Workers AI uses OpenAI-compatible endpoint or native endpoint
    // Use the AI Gateway if configured, otherwise direct API
    let url: string;
    if (this.gateway) {
      url = `https://gateway.ai.cloudflare.com/v1/${this.accountId}/${this.gateway}/workers-ai/v1/chat/completions`;
    } else {
      url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai/v1/chat/completions`;
    }

    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      max_tokens: options?.maxTokens ?? 4096,
      stream: false,
    };
    if (options?.temperature !== undefined) body.temperature = options.temperature;
    if (options?.stop) body.stop = options.stop;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Cloudflare Workers AI error (${res.status}): ${text}`);
    }

    const data = await res.json() as {
      choices?: { message: { content: string } }[];
      result?: { response: string };
      usage?: { prompt_tokens: number; completion_tokens: number };
      model?: string;
    };

    // Handle both OpenAI-compatible and native response formats
    const content = data.choices?.[0]?.message?.content ?? data.result?.response ?? '';

    return {
      content,
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      },
      model: this.model,
    };
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export type ProviderType = 'claude' | 'openai' | 'ollama' | 'cloudflare';

export function createProvider(type: ProviderType, config?: Record<string, unknown>): LlmProvider {
  switch (type) {
    case 'claude':
      return new ClaudeProvider({
        apiKey: (config?.apiKey as string) || process.env.ANTHROPIC_API_KEY || '',
        model: config?.model as string,
      });
    case 'openai':
      return new OpenAiProvider({
        apiKey: (config?.apiKey as string) || process.env.OPENAI_API_KEY || '',
        model: config?.model as string,
      });
    case 'ollama':
      return new OllamaProvider({
        model: config?.model as string,
        baseUrl: config?.baseUrl as string,
      });
    case 'cloudflare':
      return new CloudflareAiProvider({
        apiKey: (config?.apiKey as string) || process.env.CF_API_KEY || '',
        accountId: (config?.accountId as string) || process.env.CF_ACCOUNT_ID || '',
        model: config?.model as string,
        gateway: config?.gateway as string,
      });
    default:
      throw new Error(`Unknown provider: ${type}`);
  }
}
