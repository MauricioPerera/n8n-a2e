/**
 * Node Definition Extractor - from a running n8n instance
 *
 * Uses the n8n internal API endpoint GET /types/nodes.json
 * which returns ALL node type descriptions in one call.
 * This is the most reliable way to get accurate, complete node schemas
 * because it reflects the actual installed nodes + versions.
 */

import type {
  NodeDefinition,
  NodeParam,
  NodeParamOption,
  NodeCredential,
  NodeInput,
  NodeOutput,
  NodeCategory,
} from '../types/entities.js';
import { randomUUID } from 'node:crypto';

interface RawN8nNodeType {
  displayName: string;
  name: string;
  group: string[];
  description: string;
  version: number | number[];
  defaults: Record<string, unknown>;
  inputs: unknown[];
  outputs: unknown[];
  properties: RawProperty[];
  credentials?: RawCredential[];
  icon?: string;
  subtitle?: string;
  documentationUrl?: string;
  usableAsTool?: boolean;
  codex?: { categories?: string[]; subcategories?: Record<string, string[]> };
  hidden?: boolean;
}

interface RawProperty {
  displayName: string;
  name: string;
  type: string;
  default?: unknown;
  required?: boolean;
  description?: string;
  options?: RawOption[];
  displayOptions?: Record<string, unknown>;
}

interface RawOption {
  name: string;
  value: string | number | boolean;
  description?: string;
}

interface RawCredential {
  name: string;
  required: boolean;
  displayName?: string;
}

function inferCategory(node: RawN8nNodeType): NodeCategory {
  const name = node.name.toLowerCase();
  const group = node.group.map(g => g.toLowerCase());

  if (group.includes('trigger') || name.endsWith('trigger')) return 'trigger';
  if (group.includes('transform')) return 'transform';
  if (group.includes('output')) return 'output';
  if (group.includes('input')) return 'input';

  // Flow control nodes
  const flowNodes = ['if', 'switch', 'merge', 'splitinbatches', 'wait', 'noop', 'filter'];
  if (flowNodes.some(f => name.includes(f))) return 'flow';

  // AI nodes
  if (name.startsWith('@n8n/n8n-nodes-langchain') || name.includes('agent') || name.includes('openai')) {
    return 'ai';
  }

  // Utility
  const utilityNodes = ['code', 'function', 'set', 'datetime', 'crypto', 'xml', 'html', 'markdown'];
  if (utilityNodes.some(u => name.includes(u))) return 'utility';

  return 'action';
}

function parseInputs(raw: unknown[]): NodeInput[] {
  return raw.map(inp => {
    if (typeof inp === 'string') {
      return { type: inp };
    }
    const obj = inp as Record<string, unknown>;
    return {
      type: (obj.type as string) || 'main',
      displayName: obj.displayName as string | undefined,
      required: obj.required as boolean | undefined,
      maxConnections: obj.maxConnections as number | undefined,
    };
  });
}

function parseOutputs(raw: unknown[]): NodeOutput[] {
  return raw.map(out => {
    if (typeof out === 'string') {
      return { type: out };
    }
    const obj = out as Record<string, unknown>;
    return {
      type: (obj.type as string) || 'main',
      displayName: obj.displayName as string | undefined,
    };
  });
}

function parseProperty(raw: RawProperty): NodeParam {
  return {
    name: raw.name,
    displayName: raw.displayName,
    type: raw.type,
    default: raw.default ?? null,
    required: raw.required ?? false,
    description: raw.description ?? '',
    options: raw.options?.map(parseOption),
    displayOptions: raw.displayOptions,
  };
}

function parseOption(raw: RawOption): NodeParamOption {
  return {
    name: raw.name,
    value: raw.value,
    description: raw.description,
  };
}

function parseCredential(raw: RawCredential): NodeCredential {
  return {
    name: raw.name,
    required: raw.required,
    displayName: raw.displayName,
  };
}

/** Convert a raw n8n node type into our NodeDefinition entity */
export function rawToNodeDefinition(raw: RawN8nNodeType): NodeDefinition {
  const now = new Date().toISOString();
  const versions = Array.isArray(raw.version) ? raw.version : [raw.version];

  return {
    id: randomUUID(),
    type: 'nodeDefinition',
    createdAt: now,
    updatedAt: now,
    tags: [
      inferCategory(raw),
      ...raw.group,
      ...(raw.codex?.categories ?? []),
    ],
    n8nType: raw.name,
    displayName: raw.displayName,
    version: versions,
    category: inferCategory(raw),
    group: raw.group,
    description: raw.description ?? '',
    inputs: parseInputs(raw.inputs as unknown[]),
    outputs: parseOutputs(raw.outputs as unknown[]),
    properties: raw.properties?.map(parseProperty) ?? [],
    credentials: raw.credentials?.map(parseCredential) ?? [],
    defaults: raw.defaults ?? {},
    icon: raw.icon,
    subtitle: raw.subtitle,
    documentationUrl: raw.documentationUrl,
    usableAsTool: raw.usableAsTool,
  };
}

/** Fetch all node types from a running n8n instance */
export async function extractFromInstance(baseUrl: string, apiKey: string): Promise<NodeDefinition[]> {
  // Try multiple endpoints — n8n exposes node types at different paths depending on version and auth
  const endpoints: { url: string; headers: Record<string, string> }[] = [
    // Internal REST API (works with cookie session)
    { url: `${baseUrl}/rest/node-types`, headers: { 'X-N8N-API-KEY': apiKey } },
    // Static types file
    { url: `${baseUrl}/types/nodes.json`, headers: { 'X-N8N-API-KEY': apiKey } },
    // Public API (newer n8n versions)
    { url: `${baseUrl}/api/v1/node-types`, headers: { 'X-N8N-API-KEY': apiKey } },
  ];

  // First try session-based auth (login + cookie)
  const sessionCookie = await tryLogin(baseUrl);
  if (sessionCookie) {
    // Prepend session-auth endpoints (these have highest success rate)
    endpoints.unshift(
      { url: `${baseUrl}/rest/node-types`, headers: { 'Cookie': sessionCookie } as Record<string, string> },
      { url: `${baseUrl}/types/nodes.json`, headers: { 'Cookie': sessionCookie } as Record<string, string> },
    );
  }

  let rawNodes: RawN8nNodeType[] = [];

  for (const ep of endpoints) {
    try {
      const res = await fetch(ep.url, {
        headers: { ...ep.headers, 'Accept': 'application/json' },
      });
      if (res.ok) {
        const data = await res.json();
        rawNodes = Array.isArray(data) ? data : (data as { data: RawN8nNodeType[] }).data ?? [];
        if (rawNodes.length > 0) break;
      }
    } catch {
      // Try next endpoint
    }
  }

  // Fallback: extract node info from existing workflows via public API
  if (rawNodes.length === 0) {
    const fromWorkflows = await extractFromWorkflows(baseUrl, apiKey);
    if (fromWorkflows.length > 0) return fromWorkflows;
  }

  if (rawNodes.length === 0) {
    throw new Error(
      `Could not fetch node types from ${baseUrl}.\n` +
      `Tried: ${endpoints.map(e => e.url).join(', ')}\n` +
      `Hint: Try 'extract-github' for offline extraction, or ensure n8n owner auth is available.`
    );
  }

  return rawNodes
    .filter(n => !n.hidden)
    .map(rawToNodeDefinition);
}

/**
 * Try to login to n8n to get a session cookie.
 * Uses N8N_USER and N8N_PASSWORD env vars if available.
 */
async function tryLogin(baseUrl: string): Promise<string | null> {
  const email = process.env.N8N_USER || process.env.N8N_EMAIL;
  const password = process.env.N8N_PASSWORD;
  if (!email || !password) return null;

  try {
    const res = await fetch(`${baseUrl}/rest/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
      redirect: 'manual',
    });

    if (res.ok || res.status === 302) {
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) {
        // Extract session cookie name=value
        return setCookie.split(';')[0];
      }
    }
  } catch {
    // Login failed, no session auth
  }
  return null;
}

/**
 * Extract node definitions from existing workflows via the public API.
 * Less complete than /types/nodes.json but works with just an API key.
 * Builds NodeDefinitions from the actual node configs found in workflows.
 */
async function extractFromWorkflows(baseUrl: string, apiKey: string): Promise<NodeDefinition[]> {
  const seenTypes = new Map<string, NodeDefinition>();

  try {
    // Fetch all workflows
    let cursor: string | undefined;
    let page = 0;
    const maxPages = 10;

    while (page < maxPages) {
      const qs = cursor ? `?cursor=${cursor}&limit=100` : '?limit=100';
      const res = await fetch(`${baseUrl}/api/v1/workflows${qs}`, {
        headers: { 'X-N8N-API-KEY': apiKey, 'Accept': 'application/json' },
      });

      if (!res.ok) break;

      const body = await res.json() as { data: Array<{ nodes: Array<{ type: string; typeVersion: number; name: string; parameters: Record<string, unknown>; credentials?: Record<string, unknown> }>; }>, nextCursor?: string };
      const workflows = body.data ?? [];

      for (const wf of workflows) {
        for (const node of (wf.nodes ?? [])) {
          if (seenTypes.has(node.type)) continue;

          const now = new Date().toISOString();
          const def: NodeDefinition = {
            id: randomUUID(),
            type: 'nodeDefinition',
            createdAt: now,
            updatedAt: now,
            tags: [],
            n8nType: node.type,
            displayName: node.name || node.type.split('.').pop() || node.type,
            version: [node.typeVersion || 1],
            category: inferCategory({ name: node.type, displayName: node.name || node.type, group: [], description: '', version: node.typeVersion || 1, defaults: {}, inputs: ['main'], outputs: ['main'], properties: [] }),
            group: [],
            description: `Extracted from workflow node "${node.name}"`,
            inputs: [{ type: 'main' }],
            outputs: [{ type: 'main' }],
            properties: Object.keys(node.parameters ?? {}).map(k => ({
              name: k,
              displayName: k,
              type: 'string',
              default: null,
              required: false,
              description: '',
            })),
            credentials: node.credentials
              ? Object.keys(node.credentials).map(k => ({ name: k, required: true }))
              : [],
            defaults: {},
          };

          seenTypes.set(node.type, def);
        }
      }

      if (!body.nextCursor) break;
      cursor = body.nextCursor;
      page++;
    }
  } catch {
    // Failed to extract from workflows
  }

  return [...seenTypes.values()];
}

/** Fetch available credentials from instance */
export async function extractCredentials(
  baseUrl: string,
  apiKey: string
): Promise<{ type: string; name: string; id: string }[]> {
  const res = await fetch(`${baseUrl}/api/v1/credentials`, {
    headers: {
      'X-N8N-API-KEY': apiKey,
      'Accept': 'application/json',
    },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch credentials: ${res.status} ${res.statusText}`);
  }

  const body = await res.json() as { data: { id: string; name: string; type: string }[] };
  return (body.data ?? []).map(c => ({
    id: c.id,
    name: c.name,
    type: c.type,
  }));
}
