/**
 * Node Definition Extractor — from n8n-cli catalog files
 *
 * Reads the per-profile catalog JSON files that n8n-cli generates via `nodes sync`.
 * These catalogs contain FULL node definitions (properties, credentials, I/O)
 * extracted from a live n8n instance, stored at ~/.n8n-cli/catalog/{profile}.json.
 *
 * This is the preferred extraction strategy when n8n-cli is available because:
 * - Full property definitions (not stubs like GitHub extraction)
 * - Multi-instance support via profiles
 * - No additional API calls needed (reads cached files)
 * - Includes credential names per node
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type {
  NodeDefinition,
  NodeCategory,
  NodeParam,
  NodeCredential,
  NodeInput,
  NodeOutput,
} from '../types/entities.js';

// ─── n8n-cli catalog types (mirrors catalog.ts) ────────────────────────────

interface CliNodeParam {
  name: string;
  displayName: string;
  type: string;
  default?: unknown;
  required?: boolean;
  description?: string;
  options?: { name: string; value: string; description?: string }[];
  displayOptions?: Record<string, unknown>;
}

interface CliCatalogNode {
  n8nType: string;
  displayName: string;
  category: string;
  description: string;
  version: number[];
  inputs: string[];
  outputs: string[];
  credentials: string[];
  properties: CliNodeParam[];
  tags: string[];
}

interface CliCatalogFile {
  syncedAt: string;
  profileName: string;
  baseUrl: string;
  nodeCount: number;
  nodes: CliCatalogNode[];
}

// ─── n8n-cli config types ──────────────────────────────────────────────────

interface CliProfile {
  baseUrl: string;
  apiKey: string;
  timeout?: number;
}

interface CliConfigFile {
  default?: string;
  profiles: Record<string, CliProfile>;
}

// ─── Paths ─────────────────────────────────────────────────────────────────

const CLI_DIR = join(homedir(), '.n8n-cli');
const CATALOG_DIR = join(CLI_DIR, 'catalog');
const CONFIG_PATH = join(CLI_DIR, 'config.json');

// ─── Config reading ────────────────────────────────────────────────────────

/** Read n8n-cli's config file to discover available profiles */
export function readCliConfig(): CliConfigFile | null {
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.profiles) return parsed;
    return null;
  } catch {
    return null;
  }
}

/** List all available n8n-cli profiles */
export function listCliProfiles(): { name: string; baseUrl: string; isDefault: boolean }[] {
  const config = readCliConfig();
  if (!config) return [];
  return Object.entries(config.profiles).map(([name, p]) => ({
    name,
    baseUrl: p.baseUrl,
    isDefault: name === config.default,
  }));
}

/** Get connection details for a profile (for use with n8n-a2e's client) */
export function getCliProfile(profileName?: string): { baseUrl: string; apiKey: string; timeout: number } | null {
  const config = readCliConfig();
  if (!config) return null;
  const name = profileName ?? config.default;
  if (!name || !config.profiles[name]) return null;
  const p = config.profiles[name];
  return {
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    timeout: p.timeout ?? 30000,
  };
}

// ─── Catalog reading ───────────────────────────────────────────────────────

/** List available catalog files (one per synced profile) */
export function listCliCatalogs(): { profileName: string; syncedAt: string; nodeCount: number; baseUrl: string }[] {
  if (!existsSync(CATALOG_DIR)) return [];
  const files = readdirSync(CATALOG_DIR).filter(f => f.endsWith('.json'));
  const catalogs: { profileName: string; syncedAt: string; nodeCount: number; baseUrl: string }[] = [];

  for (const file of files) {
    try {
      const raw = readFileSync(join(CATALOG_DIR, file), 'utf8');
      const catalog = JSON.parse(raw) as CliCatalogFile;
      catalogs.push({
        profileName: catalog.profileName,
        syncedAt: catalog.syncedAt,
        nodeCount: catalog.nodeCount,
        baseUrl: catalog.baseUrl,
      });
    } catch {
      // Skip corrupt files
    }
  }
  return catalogs;
}

/** Load a specific catalog file by profile name */
function loadCatalogFile(profileName: string): CliCatalogFile | null {
  const filePath = join(CATALOG_DIR, `${profileName}.json`);
  try {
    const raw = readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as CliCatalogFile;
  } catch {
    return null;
  }
}

// ─── Conversion: CLI CatalogNode → n8n-a2e NodeDefinition ─────────────────

function mapCategory(cat: string): NodeCategory {
  const valid: NodeCategory[] = ['trigger', 'action', 'transform', 'flow', 'ai', 'output', 'input', 'utility'];
  return valid.includes(cat as NodeCategory) ? (cat as NodeCategory) : 'action';
}

function convertParam(p: CliNodeParam): NodeParam {
  return {
    name: p.name,
    displayName: p.displayName,
    type: p.type,
    default: p.default ?? null,
    required: p.required ?? false,
    description: p.description ?? '',
    options: p.options?.map(o => ({
      name: o.name,
      value: o.value,
      description: o.description,
    })),
    displayOptions: p.displayOptions,
  };
}

function convertNode(node: CliCatalogNode): NodeDefinition {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    type: 'nodeDefinition',
    createdAt: now,
    updatedAt: now,
    tags: node.tags,
    n8nType: node.n8nType,
    displayName: node.displayName,
    version: node.version,
    category: mapCategory(node.category),
    group: node.category === 'trigger' ? ['trigger'] : [],
    description: node.description,
    inputs: node.inputs.map((i): NodeInput => ({ type: i })),
    outputs: node.outputs.map((o): NodeOutput => ({ type: o })),
    properties: node.properties.map(convertParam),
    credentials: node.credentials.map((name): NodeCredential => ({ name, required: false })),
    defaults: {},
  };
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Extract NodeDefinitions from n8n-cli's cached catalog for a specific profile.
 * Falls back to the default profile if no name is given.
 *
 * Returns null if n8n-cli is not installed or the profile has no catalog.
 * Caller should fall back to other extraction strategies in that case.
 */
export function extractFromCliCatalog(profileName?: string): NodeDefinition[] | null {
  const config = readCliConfig();
  if (!config) return null;

  const name = profileName ?? config.default;
  if (!name) return null;

  const catalog = loadCatalogFile(name);
  if (!catalog || catalog.nodes.length === 0) return null;

  return catalog.nodes.map(convertNode);
}

/**
 * Extract NodeDefinitions from ALL n8n-cli catalogs (all profiles).
 * Useful for building a comprehensive knowledge base across instances.
 * Deduplicates by n8nType (keeps the most recently synced version).
 */
export function extractFromAllCliCatalogs(): {
  nodes: NodeDefinition[];
  profiles: { name: string; baseUrl: string; nodeCount: number; syncedAt: string }[];
} {
  const catalogs = listCliCatalogs();
  if (catalogs.length === 0) return { nodes: [], profiles: [] };

  // Sort by syncedAt descending so newest wins in dedup
  catalogs.sort((a, b) => b.syncedAt.localeCompare(a.syncedAt));

  const seen = new Set<string>();
  const allNodes: NodeDefinition[] = [];
  const profileInfos: { name: string; baseUrl: string; nodeCount: number; syncedAt: string }[] = [];

  for (const info of catalogs) {
    const catalog = loadCatalogFile(info.profileName);
    if (!catalog) continue;

    profileInfos.push({
      name: info.profileName,
      baseUrl: info.baseUrl,
      nodeCount: info.nodeCount,
      syncedAt: info.syncedAt,
    });

    for (const node of catalog.nodes) {
      if (!seen.has(node.n8nType)) {
        seen.add(node.n8nType);
        allNodes.push(convertNode(node));
      }
    }
  }

  return { nodes: allNodes, profiles: profileInfos };
}

/**
 * Check if n8n-cli is installed and has at least one catalog available.
 */
export function isCliAvailable(): boolean {
  return existsSync(CONFIG_PATH) && existsSync(CATALOG_DIR);
}
