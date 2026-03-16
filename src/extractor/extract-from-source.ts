/**
 * Node Definition Extractor - from local n8n source code
 *
 * Reads TypeScript node files from a cloned n8n monorepo and extracts
 * NodeDefinition entities with full parameter, credential, and I/O info.
 *
 * Supports both packages:
 * - packages/nodes-base (standard nodes)
 * - packages/@n8n/nodes-langchain (AI/LangChain nodes)
 */

import type { NodeDefinition, NodeCategory, NodeParam, NodeCredential, NodeInput, NodeOutput } from '../types/entities.js';
import { randomUUID } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ExtractOptions {
  /** Path to cloned n8n repo root */
  repoPath: string;
  /** Extract nodes-base (default true) */
  nodesBase?: boolean;
  /** Extract nodes-langchain (default true) */
  nodesLangchain?: boolean;
  /** Verbose logging */
  verbose?: boolean;
}

interface RawDescription {
  displayName: string;
  name: string;
  icon?: string | { light: string; dark: string };
  group: string[];
  version: number | number[];
  description: string;
  subtitle?: string;
  defaults: Record<string, unknown>;
  inputs: string[] | { type: string; displayName?: string; required?: boolean; maxConnections?: number }[];
  outputs: string[] | { type: string; displayName?: string }[];
  properties: RawProperty[];
  credentials?: RawCredential[];
  codex?: { categories?: string[]; subcategories?: Record<string, string[]>; alias?: string[] };
  usableAsTool?: boolean;
}

interface RawProperty {
  displayName: string;
  name: string;
  type: string;
  default: unknown;
  required?: boolean;
  description?: string;
  options?: { name: string; value: unknown; description?: string }[];
  displayOptions?: Record<string, unknown>;
  placeholder?: string;
}

interface RawCredential {
  name: string;
  required?: boolean;
  displayName?: string;
}

// ─── Extraction ──────────────────────────────────────────────────────────────

/**
 * Find all *.node.ts files recursively in a directory.
 */
async function findNodeFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip test directories and node_modules
        if (entry.name === '__test__' || entry.name === '__tests__' || entry.name === 'node_modules') continue;
        results.push(...await findNodeFiles(fullPath));
      } else if (entry.name.endsWith('.node.ts') && !entry.name.endsWith('.test.ts')) {
        results.push(fullPath);
      }
    }
  } catch {
    // Directory not found, skip
  }
  return results;
}

/**
 * Parse a VersionedNodeType file and extract the baseDescription.
 * These files have: const baseDescription: INodeTypeBaseDescription = { ... }
 */
function extractVersionedDescription(source: string, filePath: string): RawDescription | null {
  const baseMatch = source.match(/baseDescription:\s*INodeTypeBaseDescription\s*=\s*\{/);
  if (!baseMatch || baseMatch.index === undefined) return null;

  const startIdx = baseMatch.index + baseMatch[0].length - 1;
  let depth = 0;
  let endIdx = startIdx;
  for (let i = startIdx; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) { endIdx = i + 1; break; } }
  }
  const objStr = source.slice(startIdx, endIdx);

  const getString = (key: string): string => {
    const m = objStr.match(new RegExp(`${key}:\\s*'([^']*)'`)) ||
              objStr.match(new RegExp(`${key}:\\s*"([^"]*)"`));
    return m?.[1] ?? '';
  };

  const displayName = getString('displayName');
  const name = getString('name');
  const description = getString('description');
  if (!name) return null;

  // Extract group
  let group: string[] = [];
  const groupMatch = objStr.match(/group:\s*\[([^\]]*)\]/);
  if (groupMatch) {
    group = groupMatch[1].split(',').map(g => g.trim().replace(/['"]/g, '')).filter(g => g.length > 0);
  }

  // Extract default version to figure out versions
  let version: number[] = [1];
  const dvMatch = objStr.match(/defaultVersion:\s*(\d+(\.\d+)?)/);
  if (dvMatch) {
    const dv = parseFloat(dvMatch[1]);
    // Generate version list: 1 through defaultVersion
    version = [];
    for (let v = 1; v <= Math.floor(dv); v++) version.push(v);
    if (dv !== Math.floor(dv)) version.push(dv);
  }

  // Extract icon
  const icon = getString('icon');

  // Now look at the versioned sub-files to get inputs/outputs/properties
  // We try to find the highest version sub-node file
  const isTrigger = name.toLowerCase().includes('trigger') || group.includes('trigger');

  // Default inputs/outputs for base nodes
  const inputs: { type: string; displayName?: string }[] = [{ type: 'main' }];
  const outputs: { type: string; displayName?: string }[] = [{ type: 'main' }];

  // For IF/Switch, add second output
  if (name === 'if' || name === 'filter') {
    outputs.push({ type: 'main' });
  } else if (name === 'switch') {
    outputs.push({ type: 'main' }, { type: 'main' }, { type: 'main' });
  } else if (name === 'merge') {
    inputs.push({ type: 'main' });
  }

  return {
    displayName: displayName || name,
    name,
    icon: icon || undefined,
    group,
    version,
    description: description || `${displayName} node`,
    subtitle: undefined,
    defaults: { name: displayName || name },
    inputs,
    outputs,
    properties: [],
    credentials: [],
    codex: { categories: [], alias: [] },
    usableAsTool: false,
  };
}

/**
 * Parse a TypeScript node file and extract the description object.
 * Uses regex-based extraction since we can't execute the TS files directly.
 */
function extractDescription(source: string, filePath: string): RawDescription | null {
  // First try VersionedNodeType pattern
  if (source.includes('extends VersionedNodeType')) {
    return extractVersionedDescription(source, filePath);
  }

  // Look for the description assignment pattern
  // Pattern: description: INodeTypeDescription = { ... }
  const descMatch = source.match(/description:\s*INodeTypeDescription\s*=\s*\{/);
  if (!descMatch || descMatch.index === undefined) return null;

  // Extract the object by counting braces
  const startIdx = descMatch.index + descMatch[0].length - 1;
  let depth = 0;
  let endIdx = startIdx;

  for (let i = startIdx; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) {
        endIdx = i + 1;
        break;
      }
    }
  }

  let objStr = source.slice(startIdx, endIdx);

  // Clean TypeScript-specific syntax for JSON-like parsing
  // Remove type assertions and casts
  objStr = objStr.replace(/\s+as\s+\w+(\[\])?/g, '');
  objStr = objStr.replace(/\s+as\s+['"][^'"]+['"]/g, '');
  // Remove NodeConnectionTypes.X references → string
  objStr = objStr.replace(/NodeConnectionTypes\.(\w+)/g, (_, name) => {
    const mapping: Record<string, string> = {
      Main: '"main"',
      AiTool: '"ai_tool"',
      AiAgent: '"ai_agent"',
      AiLanguageModel: '"ai_languageModel"',
      AiMemory: '"ai_memory"',
      AiOutputParser: '"ai_outputParser"',
      AiVectorStore: '"ai_vectorStore"',
      AiDocument: '"ai_document"',
      AiEmbedding: '"ai_embedding"',
      AiTextSplitter: '"ai_textSplitter"',
      AiRetriever: '"ai_retriever"',
      AiChain: '"ai_chain"',
      AiGuardrails: '"ai_guardrails"',
      AiReranker: '"ai_reranker"',
    };
    return mapping[name] || `"${name.toLowerCase()}"`;
  });

  // Try to extract key fields via regex instead of eval (safer)
  const getString = (key: string): string => {
    const m = objStr.match(new RegExp(`${key}:\\s*'([^']*)'`)) ||
              objStr.match(new RegExp(`${key}:\\s*"([^"]*)"`));
    return m?.[1] ?? '';
  };

  const getStringOrObj = (key: string): string => {
    // For icon which can be string or object
    const m = objStr.match(new RegExp(`${key}:\\s*'([^']*)'`)) ||
              objStr.match(new RegExp(`${key}:\\s*"([^"]*)"`));
    return m?.[1] ?? '';
  };

  const displayName = getString('displayName');
  const name = getString('name');
  const description = getString('description');

  if (!name) return null;

  // Extract version
  let version: number[] = [1];
  const versionMatch = objStr.match(/version:\s*\[([^\]]+)\]/);
  if (versionMatch) {
    version = versionMatch[1].split(',').map(v => parseFloat(v.trim())).filter(v => !isNaN(v));
  } else {
    const singleVersion = objStr.match(/version:\s*(\d+(\.\d+)?)/);
    if (singleVersion) version = [parseFloat(singleVersion[1])];
  }

  // Extract group
  let group: string[] = [];
  const groupMatch = objStr.match(/group:\s*\[([^\]]*)\]/);
  if (groupMatch) {
    group = groupMatch[1].split(',')
      .map(g => g.trim().replace(/['"]/g, ''))
      .filter(g => g.length > 0);
  }

  // Extract inputs/outputs types
  const extractIOs = (key: string): { type: string; displayName?: string }[] => {
    // Match array of objects like [{ type: "main" }, { type: "ai_tool", displayName: "Tools" }]
    const ioRegex = new RegExp(`${key}:\\s*\\[([\\s\\S]*?)\\]`, 'm');
    const match = objStr.match(ioRegex);
    if (!match) return [{ type: 'main' }];

    const content = match[1];
    const ios: { type: string; displayName?: string }[] = [];

    // Match { type: "xxx" } patterns
    const objPattern = /\{\s*type:\s*["']([^"']+)["'](?:,\s*displayName:\s*["']([^"']+)["'])?\s*\}/g;
    let m;
    while ((m = objPattern.exec(content)) !== null) {
      ios.push({ type: m[1], displayName: m[2] || undefined });
    }

    // Match plain strings like "main"
    if (ios.length === 0) {
      const strPattern = /["']([^"']+)["']/g;
      while ((m = strPattern.exec(content)) !== null) {
        ios.push({ type: m[1] });
      }
    }

    return ios.length > 0 ? ios : [{ type: 'main' }];
  };

  // Extract properties (simplified - get name, type, default, required)
  const properties: RawProperty[] = [];
  const propsSection = objStr.match(/properties:\s*\[([\s\S]*)\]\s*[,}]\s*$/m);
  if (propsSection) {
    // Find individual property objects by matching displayName/name pairs
    const propPattern = /\{\s*(?:\/\/[^\n]*\n\s*)?displayName:\s*['"]([^'"]+)['"],\s*name:\s*['"]([^'"]+)['"],\s*type:\s*['"]([^'"]+)['"]/g;
    let pm;
    while ((pm = propPattern.exec(propsSection[1])) !== null) {
      properties.push({
        displayName: pm[1],
        name: pm[2],
        type: pm[3],
        default: '',
        required: false,
        description: '',
      });
    }
  }

  // Extract credentials
  const credentials: RawCredential[] = [];
  // Look for credentials array in the description
  const credSection = objStr.match(/credentials:\s*\[([\s\S]*?)\]\s*,/);
  if (credSection) {
    const credPattern = /name:\s*['"]([^'"]+)['"]/g;
    let cm;
    while ((cm = credPattern.exec(credSection[1])) !== null) {
      credentials.push({ name: cm[1], required: false });
    }
  }

  // Extract codex categories
  let codexCategories: string[] = [];
  let codexAlias: string[] = [];
  const codexMatch = objStr.match(/codex:\s*\{([\s\S]*?)\}\s*,/);
  if (codexMatch) {
    const catMatch = codexMatch[1].match(/categories:\s*\[([^\]]*)\]/);
    if (catMatch) {
      codexCategories = catMatch[1].split(',').map(c => c.trim().replace(/['"]/g, '')).filter(Boolean);
    }
    const aliasMatch = codexMatch[1].match(/alias:\s*\[([^\]]*)\]/);
    if (aliasMatch) {
      codexAlias = aliasMatch[1].split(',').map(a => a.trim().replace(/['"]/g, '')).filter(Boolean);
    }
  }

  // Extract subtitle
  const subtitle = getString('subtitle');

  // Check usableAsTool
  const usableAsTool = /usableAsTool:\s*true/.test(objStr);

  // Extract default name
  let defaultName = displayName;
  const defaultsMatch = objStr.match(/defaults:\s*\{[^}]*name:\s*['"]([^'"]+)['"]/);
  if (defaultsMatch) defaultName = defaultsMatch[1];

  return {
    displayName: displayName || defaultName,
    name,
    icon: getStringOrObj('icon'),
    group,
    version,
    description,
    subtitle,
    defaults: { name: defaultName },
    inputs: extractIOs('inputs'),
    outputs: extractIOs('outputs'),
    properties,
    credentials,
    codex: { categories: codexCategories, alias: codexAlias },
    usableAsTool,
  };
}

/**
 * Infer category from the raw description and file path.
 */
function inferCategory(raw: RawDescription, filePath: string): NodeCategory {
  const lower = filePath.toLowerCase();
  const nameLower = raw.name.toLowerCase();

  // AI/LangChain
  if (lower.includes('nodes-langchain') || raw.codex?.categories?.includes('AI')) return 'ai';

  // Triggers
  if (raw.group.includes('trigger') || nameLower.includes('trigger')) return 'trigger';

  // Flow control
  if (['if', 'switch', 'merge', 'splitInBatches', 'filter', 'limit', 'removeDuplicates', 'sort', 'itemLists']
    .some(f => nameLower === f.toLowerCase())) return 'flow';

  // Transform
  if (['set', 'code', 'function', 'functionItem', 'html', 'xml', 'markdown', 'crypto', 'dateTime', 'compression']
    .some(t => nameLower === t.toLowerCase())) return 'transform';

  return 'action';
}

/**
 * Determine the n8n type from the file path and parsed name.
 */
function resolveN8nType(raw: RawDescription, filePath: string): string {
  const isLangchain = filePath.includes('nodes-langchain');
  const prefix = isLangchain ? '@n8n/n8n-nodes-langchain' : 'n8n-nodes-base';
  return `${prefix}.${raw.name}`;
}

/**
 * Convert raw description to NodeDefinition entity.
 */
function toNodeDefinition(raw: RawDescription, filePath: string): NodeDefinition {
  const now = new Date().toISOString();
  const n8nType = resolveN8nType(raw, filePath);
  const category = inferCategory(raw, filePath);

  const tags: string[] = [category];
  if (raw.codex?.categories) tags.push(...raw.codex.categories.map(c => c.toLowerCase()));
  if (raw.codex?.alias) tags.push(...raw.codex.alias.map(a => a.toLowerCase()));
  tags.push(raw.displayName.toLowerCase());

  const inputs: NodeInput[] = (raw.inputs as { type: string; displayName?: string; required?: boolean; maxConnections?: number }[])
    .map(i => typeof i === 'string' ? { type: i } : i);
  const outputs: NodeOutput[] = (raw.outputs as { type: string; displayName?: string }[])
    .map(o => typeof o === 'string' ? { type: o } : o);

  const properties: NodeParam[] = raw.properties.map(p => ({
    name: p.name,
    displayName: p.displayName,
    type: p.type,
    default: p.default ?? '',
    required: p.required ?? false,
    description: p.description ?? '',
    options: p.options?.map(o => ({
      name: o.name,
      value: typeof o.value === 'string' ? o.value : String(o.value),
      description: o.description,
    })),
    displayOptions: p.displayOptions,
  }));

  const credentials: NodeCredential[] = (raw.credentials ?? []).map(c => ({
    name: c.name,
    required: c.required ?? false,
    displayName: c.displayName,
  }));

  return {
    id: randomUUID(),
    type: 'nodeDefinition',
    createdAt: now,
    updatedAt: now,
    tags: [...new Set(tags)],
    n8nType,
    displayName: raw.displayName,
    version: Array.isArray(raw.version) ? raw.version : [raw.version],
    category,
    group: raw.group,
    description: raw.description,
    inputs,
    outputs,
    properties,
    credentials,
    defaults: raw.defaults,
    icon: typeof raw.icon === 'string' ? raw.icon : undefined,
    subtitle: raw.subtitle || undefined,
    usableAsTool: raw.usableAsTool || undefined,
  };
}

// ─── Versioned Node Definitions ──────────────────────────────────────────────
// Some nodes use VersionedNodeType with constructor-based descriptions.
// These can't be parsed automatically, so we define them manually.

function getVersionedNodeDefinitions(): NodeDefinition[] {
  const now = new Date().toISOString();

  return [
    {
      id: randomUUID(), type: 'nodeDefinition', createdAt: now, updatedAt: now,
      tags: ['ai', 'agent', 'langchain', 'chat', 'conversational', 'plan and execute', 'react', 'tools'],
      n8nType: '@n8n/n8n-nodes-langchain.agent',
      displayName: 'AI Agent',
      version: [1, 2, 3, 3.1],
      category: 'ai', group: ['transform'],
      description: 'Generates an action plan and executes it. Can use external tools.',
      inputs: [
        { type: 'main' },
        { type: 'ai_languageModel', displayName: 'Model', required: true, maxConnections: 1 },
        { type: 'ai_memory', displayName: 'Memory' },
        { type: 'ai_tool', displayName: 'Tool' },
        { type: 'ai_outputParser', displayName: 'Output Parser' },
      ],
      outputs: [{ type: 'main' }],
      properties: [
        { name: 'promptType', displayName: 'Prompt', type: 'options', default: 'define', required: false, description: 'How to specify the prompt' },
        { name: 'text', displayName: 'Text', type: 'string', default: '={{ $json.chatInput }}', required: false, description: 'The text to send to the agent' },
        { name: 'hasOutputParser', displayName: 'Require Specific Output Format', type: 'boolean', default: false, required: false, description: 'Whether to require structured output' },
        { name: 'options', displayName: 'Options', type: 'collection', default: {}, required: false, description: 'Additional options' },
      ],
      credentials: [],
      defaults: { name: 'AI Agent' },
      icon: 'fa:robot',
      documentationUrl: 'https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.agent/',
    },
    {
      id: randomUUID(), type: 'nodeDefinition', createdAt: now, updatedAt: now,
      tags: ['ai', 'agent', 'tool', 'sub-agent', 'multi-agent'],
      n8nType: '@n8n/n8n-nodes-langchain.agentTool',
      displayName: 'Call n8n Agent Tool',
      version: [1, 2],
      category: 'ai', group: ['transform'],
      description: 'Call another agent as a tool for multi-agent orchestration.',
      inputs: [
        { type: 'ai_languageModel', displayName: 'Model', required: true },
        { type: 'ai_tool', displayName: 'Tool' },
      ],
      outputs: [{ type: 'ai_tool' }],
      properties: [
        { name: 'name', displayName: 'Name', type: 'string', default: '', required: true, description: 'Name of the agent tool' },
        { name: 'description', displayName: 'Description', type: 'string', default: '', required: true, description: 'Description for the AI on when to use this agent' },
      ],
      credentials: [],
      defaults: { name: 'Call n8n Agent Tool' },
    },
    {
      id: randomUUID(), type: 'nodeDefinition', createdAt: now, updatedAt: now,
      tags: ['ai', 'tool', 'workflow', 'sub-workflow'],
      n8nType: '@n8n/n8n-nodes-langchain.toolWorkflow',
      displayName: 'Call n8n Workflow Tool',
      version: [1, 2],
      category: 'ai', group: ['transform'],
      description: 'Uses another n8n workflow as a tool. Useful for complex operations.',
      inputs: [],
      outputs: [{ type: 'ai_tool' }],
      properties: [
        { name: 'name', displayName: 'Name', type: 'string', default: '', required: true, description: 'Tool name visible to the AI' },
        { name: 'description', displayName: 'Description', type: 'string', default: '', required: true, description: 'Description of what this tool does' },
        { name: 'workflowId', displayName: 'Workflow', type: 'string', default: '', required: true, description: 'The workflow to call' },
      ],
      credentials: [],
      defaults: { name: 'Call n8n Workflow Tool' },
    },
    {
      id: randomUUID(), type: 'nodeDefinition', createdAt: now, updatedAt: now,
      tags: ['ai', 'chain', 'summarization', 'summarize'],
      n8nType: '@n8n/n8n-nodes-langchain.chainSummarization',
      displayName: 'Summarization Chain',
      version: [1, 2],
      category: 'ai', group: ['transform'],
      description: 'Summarizes text using an LLM.',
      inputs: [
        { type: 'main' },
        { type: 'ai_languageModel', displayName: 'Model', required: true },
      ],
      outputs: [{ type: 'main' }],
      properties: [
        { name: 'options', displayName: 'Options', type: 'collection', default: {}, required: false, description: 'Summarization options' },
      ],
      credentials: [],
      defaults: { name: 'Summarization Chain' },
    },
    {
      id: randomUUID(), type: 'nodeDefinition', createdAt: now, updatedAt: now,
      tags: ['ai', 'guardrails', 'safety', 'moderation'],
      n8nType: '@n8n/n8n-nodes-langchain.guardrails',
      displayName: 'Guardrails',
      version: [1, 2],
      category: 'ai', group: ['transform'],
      description: 'Add guardrails to validate and constrain AI agent behavior.',
      inputs: [{ type: 'main' }],
      outputs: [{ type: 'ai_guardrails' }],
      properties: [],
      credentials: [],
      defaults: { name: 'Guardrails' },
    },
    {
      id: randomUUID(), type: 'nodeDefinition', createdAt: now, updatedAt: now,
      tags: ['ai', 'openai', 'assistant', 'gpt'],
      n8nType: '@n8n/n8n-nodes-langchain.openAiAssistant',
      displayName: 'OpenAI Assistant',
      version: [1, 2],
      category: 'ai', group: ['transform'],
      description: 'Use an OpenAI Assistant with tools.',
      inputs: [
        { type: 'main' },
        { type: 'ai_tool', displayName: 'Tool' },
      ],
      outputs: [{ type: 'main' }],
      properties: [
        { name: 'assistantId', displayName: 'Assistant', type: 'string', default: '', required: true, description: 'The assistant to use' },
      ],
      credentials: [{ name: 'openAiApi', required: true }],
      defaults: { name: 'OpenAI Assistant' },
    },
  ];
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Extract NodeDefinitions from a local n8n monorepo clone.
 */
export async function extractFromSource(options: ExtractOptions): Promise<NodeDefinition[]> {
  const { repoPath, nodesBase = true, nodesLangchain = true, verbose = false } = options;
  const definitions: NodeDefinition[] = [];
  const dirs: { path: string; label: string }[] = [];

  if (nodesBase) {
    dirs.push({ path: join(repoPath, 'packages', 'nodes-base', 'nodes'), label: 'nodes-base' });
  }
  if (nodesLangchain) {
    dirs.push({ path: join(repoPath, 'packages', '@n8n', 'nodes-langchain', 'nodes'), label: 'nodes-langchain' });
  }

  for (const { path, label } of dirs) {
    console.log(`Scanning ${label} at ${path}...`);
    const files = await findNodeFiles(path);
    console.log(`  Found ${files.length} node files.`);

    let extracted = 0;
    let skipped = 0;
    const seenNames = new Set<string>();

    for (const file of files) {
      try {
        const source = await readFile(file, 'utf-8');
        const raw = extractDescription(source, file);

        if (!raw || !raw.name) {
          skipped++;
          continue;
        }

        // Skip versioned sub-files if we already have the main one
        // (e.g., AgentV1.node.ts, AgentV2.node.ts → keep only Agent.node.ts)
        const n8nType = resolveN8nType(raw, file);
        if (seenNames.has(n8nType)) {
          if (verbose) console.log(`    Skip duplicate: ${n8nType} (${file})`);
          continue;
        }
        seenNames.add(n8nType);

        const def = toNodeDefinition(raw, file);
        definitions.push(def);
        extracted++;

        if (verbose) console.log(`    + ${def.n8nType} (${def.category})`);
      } catch (err) {
        skipped++;
        if (verbose) console.log(`    ! Error in ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    console.log(`  Extracted: ${extracted}, Skipped: ${skipped}`);
  }

  // Add versioned nodes that can't be parsed automatically
  const versionedDefs = getVersionedNodeDefinitions();
  const existingTypes = new Set(definitions.map(d => d.n8nType));
  for (const vd of versionedDefs) {
    if (!existingTypes.has(vd.n8nType)) {
      definitions.push(vd);
      if (verbose) console.log(`  + ${vd.n8nType} (versioned, manual)`);
    }
  }

  console.log(`Total: ${definitions.length} node definitions extracted (${versionedDefs.length} versioned).`);
  return definitions;
}
