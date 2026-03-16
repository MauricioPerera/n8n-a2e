/**
 * Node Definition Extractor - from n8n GitHub repo
 *
 * Downloads and parses the package.json from n8n-nodes-base to get
 * the list of all available node types, then fetches each node's
 * description from the compiled dist files on GitHub.
 *
 * This approach works without a running n8n instance.
 */

import type { NodeDefinition, NodeCategory } from '../types/entities.js';
import { randomUUID } from 'node:crypto';

const RAW_BASE = 'https://raw.githubusercontent.com/n8n-io/n8n/master';
const API_BASE = 'https://api.github.com/repos/n8n-io/n8n';

interface PackageJson {
  n8n: {
    nodes: string[];
    credentials: string[];
  };
}

/** Fetch the list of all node type paths from package.json */
async function fetchNodePaths(): Promise<string[]> {
  const url = `${RAW_BASE}/packages/nodes-base/package.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch package.json: ${res.status}`);
  const pkg = await res.json() as PackageJson;
  return pkg.n8n.nodes;
}

function inferCategoryFromPath(path: string): NodeCategory {
  const lower = path.toLowerCase();
  if (lower.includes('trigger')) return 'trigger';
  if (lower.includes('langchain') || lower.includes('agent')) return 'ai';
  return 'action';
}

function nodeNameFromPath(distPath: string): string {
  // "dist/nodes/Slack/Slack.node.js" → "Slack"
  const parts = distPath.replace('dist/nodes/', '').split('/');
  const fileName = parts[parts.length - 1];
  return fileName.replace('.node.js', '');
}

/**
 * Generate lightweight NodeDefinitions from the package.json node list.
 * These are "stubs" - they have the correct n8nType but minimal params.
 * They're sufficient for search/recall and workflow composition.
 */
export async function extractFromGitHub(): Promise<NodeDefinition[]> {
  console.log('Fetching node list from n8n GitHub repo...');
  const paths = await fetchNodePaths();
  console.log(`Found ${paths.length} registered nodes.`);

  const now = new Date().toISOString();
  const definitions: NodeDefinition[] = [];

  for (const distPath of paths) {
    const name = nodeNameFromPath(distPath);
    // n8n convention: "dist/nodes/X/X.node.js" → "n8n-nodes-base.x"
    // but the actual type name uses camelCase
    const typeName = `n8n-nodes-base.${name.charAt(0).toLowerCase()}${name.slice(1)}`;

    const category = inferCategoryFromPath(distPath);

    definitions.push({
      id: randomUUID(),
      type: 'nodeDefinition',
      createdAt: now,
      updatedAt: now,
      tags: [category, name.toLowerCase()],
      n8nType: typeName,
      displayName: name.replace(/([A-Z])/g, ' $1').trim(), // CamelCase → "Camel Case"
      version: [1],
      category,
      group: category === 'trigger' ? ['trigger'] : [],
      description: `${name} integration node`,
      inputs: [{ type: 'main' }],
      outputs: [{ type: 'main' }],
      properties: [],
      credentials: [],
      defaults: { name },
    });
  }

  return definitions;
}

/**
 * Fetch the full description of specific nodes by reading the TypeScript source.
 * This is slower but gives complete parameter info.
 * Use for a subset of critical nodes.
 */
export async function fetchNodeSource(nodePath: string): Promise<string | null> {
  // Convert dist path to src path
  const srcPath = nodePath.replace('dist/', '').replace('.js', '.ts');
  const url = `${RAW_BASE}/packages/nodes-base/${srcPath}`;

  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}
