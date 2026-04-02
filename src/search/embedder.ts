/**
 * Offline Embedding Generator for n8n-a2e
 *
 * Uses @huggingface/transformers (optional dev dependency) to generate
 * e5-small-v2 embeddings locally. These embeddings are stored in
 * js-vector-store's PolarQuantizedStore format for runtime search.
 *
 * This module is ONLY used by the `n8n-a2e embed` CLI command.
 * It is never imported at runtime — hybrid.ts reads the pre-computed files.
 */

import { resolve } from 'node:path';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { SearchEngine } from './tfidf.js';
import type { Entity, NodeDefinition, WorkflowPattern } from '../types/entities.js';

// ─── Types for js-vector-store (CJS require at runtime) ────────────────────

interface VectorStoreModule {
  PolarQuantizedStore: new (dir: string, dim: number, opts?: { bits?: number; seed?: number; model?: string }) => PolarStore;
}

interface PolarStore {
  set(col: string, id: string, vector: number[] | Float32Array, metadata?: Record<string, unknown>): void;
  flush(): void;
  count(col: string): number;
}

// ─── Common query phrases for pre-computation ──────────────────────────────

const QUERY_PHRASES = [
  // Communication
  'send email notification', 'send slack message', 'post to discord',
  'send telegram message', 'send SMS text', 'send push notification',
  'reply to message', 'forward email',
  // Triggers
  'webhook trigger', 'schedule cron job', 'watch for new files',
  'poll for changes', 'listen for events', 'receive webhook',
  'run on schedule', 'interval timer',
  // Data
  'query database', 'insert into database', 'update records',
  'read spreadsheet', 'write to google sheets', 'export to CSV',
  'fetch API data', 'HTTP request', 'REST API call',
  // Files
  'upload file', 'download file', 'read file contents',
  'write file', 'convert file format', 'compress files',
  // Transform
  'filter data', 'transform JSON', 'map fields',
  'merge data', 'split items', 'aggregate results',
  'parse HTML', 'extract text', 'format date',
  // AI
  'AI agent', 'generate text with AI', 'classify with AI',
  'summarize text', 'translate language', 'chat with LLM',
  'vector search', 'embeddings',
  // Flow
  'conditional logic', 'if else branch', 'switch case',
  'loop over items', 'wait for approval', 'error handling',
  // CRM & Business
  'create contact', 'update customer', 'sync CRM',
  'create invoice', 'track order', 'manage leads',
];

// ─── Embedding Pipeline ────────────────────────────────────────────────────

interface EmbedOptions {
  storePath: string;
  model?: string;
  verbose?: boolean;
}

export async function generateEmbeddings(
  entities: Entity[],
  options: EmbedOptions
): Promise<{ nodeCount: number; patternCount: number; queryCount: number; vectorDir: string }> {
  const model = options.model ?? 'Xenova/e5-small-v2';
  const vectorDir = resolve(options.storePath, 'vectors');

  if (!existsSync(vectorDir)) {
    mkdirSync(vectorDir, { recursive: true });
  }

  // Dynamic import of transformers.js (optional dependency)
  let pipeline: unknown;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const transformers = await (Function('return import("@huggingface/transformers")')() as Promise<{ pipeline: unknown }>);
    pipeline = transformers.pipeline;
  } catch {
    throw new Error(
      'Could not import @huggingface/transformers.\n' +
      'Install it with: npm install -D @huggingface/transformers\n' +
      'This is only needed for the "embed" command, not at runtime.'
    );
  }

  if (options.verbose) console.log(`Loading model: ${model}...`);
  const extractor = await (pipeline as Function)('feature-extraction', model, {
    dtype: 'fp32',
  });

  // Detect embedding dimensions
  const testOutput = await extractor('test', { pooling: 'mean', normalize: true });
  const dim = testOutput.data.length;
  if (options.verbose) console.log(`Embedding dimensions: ${dim}`);

  // Load js-vector-store
  // @ts-ignore — vanilla JS module with default export
  const vsModule = await import('./js-vector-store.js');
  const PolarQuantizedStore = vsModule.default.PolarQuantizedStore;

  // Create stores
  const nodeStore = new PolarQuantizedStore(vectorDir, dim, { bits: 3, seed: 42, model });
  const patternStore = new PolarQuantizedStore(vectorDir, dim, { bits: 3, seed: 42, model });

  // Separate entities by type
  const nodes = entities.filter((e): e is NodeDefinition => e.type === 'nodeDefinition');
  const patterns = entities.filter((e): e is WorkflowPattern => e.type === 'workflowPattern');

  // Embed nodes
  if (options.verbose) console.log(`Embedding ${nodes.length} nodes...`);
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const text = `passage: ${SearchEngine.entityToText(node)}`;
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    const vector = Array.from(output.data as Float32Array);
    nodeStore.set('nodes', node.n8nType, vector, {
      displayName: node.displayName,
      category: node.category,
      entityId: node.id,
    });
    if (options.verbose && (i + 1) % 50 === 0) {
      console.log(`  ${i + 1}/${nodes.length} nodes embedded`);
    }
  }
  nodeStore.flush();

  // Embed patterns
  if (options.verbose) console.log(`Embedding ${patterns.length} patterns...`);
  for (const pattern of patterns) {
    const text = `passage: ${SearchEngine.entityToText(pattern)}`;
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    const vector = Array.from(output.data as Float32Array);
    patternStore.set('patterns', pattern.id, vector, {
      name: pattern.name,
      entityId: pattern.id,
    });
  }
  patternStore.flush();

  // Pre-compute query embeddings
  if (options.verbose) console.log(`Pre-computing ${QUERY_PHRASES.length} query embeddings...`);
  const queryEmbeddings: Record<string, number[]> = {};
  for (const phrase of QUERY_PHRASES) {
    const text = `query: ${phrase}`;
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    queryEmbeddings[phrase] = Array.from(output.data as Float32Array);
  }

  // Save query embeddings as JSON
  writeFileSync(
    resolve(vectorDir, 'queries.json'),
    JSON.stringify({ model, dim, queries: queryEmbeddings }, null, 0),
    'utf-8'
  );

  const nodeCount = nodeStore.count('nodes');
  const patternCount = patternStore.count('patterns');

  if (options.verbose) {
    console.log(`\nDone:`);
    console.log(`  Nodes: ${nodeCount} vectors`);
    console.log(`  Patterns: ${patternCount} vectors`);
    console.log(`  Queries: ${QUERY_PHRASES.length} pre-computed`);
    console.log(`  Stored in: ${vectorDir}`);
  }

  return {
    nodeCount,
    patternCount,
    queryCount: QUERY_PHRASES.length,
    vectorDir,
  };
}

