#!/usr/bin/env node
/**
 * n8n-a2e CLI
 *
 * Commands:
 *   extract   - Extract node definitions from a running n8n instance
 *   search    - Search for nodes matching a query
 *   compose   - Compose a workflow from a JSON plan file
 *   deploy    - Deploy a workflow JSON to n8n
 *   stats     - Show store statistics
 *   context   - Generate LLM context for a query
 */

import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { Store } from '../storage/store.js';
import { SearchEngine } from '../search/tfidf.js';
import { Orchestrator } from '../agent/orchestrator.js';
import { extractFromInstance, extractCredentials } from '../extractor/extract-from-api.js';
import { extractFromGitHub } from '../extractor/extract-from-github.js';
import { extractFromSource } from '../extractor/extract-from-source.js';
import { startChat } from './chat.js';
import { seedPatterns } from '../seeds/patterns.js';
import { startMcpServer } from '../mcp/server.js';
import { AutonomousAgent } from '../autonomous/autonomous-agent.js';
import { createProvider, type ProviderType } from '../llm/provider.js';
import { ModelEvaluator, type EvalModelConfig, type EvalGoal } from '../eval/evaluator.js';
import { DEFAULT_EVAL_GOALS } from '../eval/default-goals.js';
import type { N8nInstance, NodeDefinition, WorkflowPattern } from '../types/entities.js';

const DEFAULT_STORE_PATH = resolve(process.cwd(), '.n8n-a2e', 'store');

function getStore(): Store {
  return new Store({ root: DEFAULT_STORE_PATH });
}

function getConfig(): { baseUrl: string; apiKey: string } | null {
  // Check env vars
  const baseUrl = process.env.N8N_BASE_URL || process.env.N8N_URL;
  const apiKey = process.env.N8N_API_KEY;
  if (baseUrl && apiKey) return { baseUrl, apiKey };

  // Check config file
  const configPath = resolve(process.cwd(), '.n8n-a2e', 'config.json');
  if (existsSync(configPath)) {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    return { baseUrl: config.baseUrl, apiKey: config.apiKey };
  }

  return null;
}

async function cmdExtract(): Promise<void> {
  const config = getConfig();
  if (!config) {
    console.error('Error: Set N8N_BASE_URL and N8N_API_KEY env vars, or create .n8n-a2e/config.json');
    process.exit(1);
  }

  console.log(`Extracting nodes from ${config.baseUrl}...`);

  const store = getStore();
  const nodes = await extractFromInstance(config.baseUrl, config.apiKey);
  console.log(`Found ${nodes.length} node definitions.`);

  const saved = store.saveBatch(nodes);
  console.log(`Saved ${saved.length} node definitions to store.`);

  // Also extract credentials and save instance profile
  try {
    const creds = await extractCredentials(config.baseUrl, config.apiKey);
    const instance: N8nInstance = {
      id: '',
      type: 'n8nInstance',
      createdAt: '',
      updatedAt: '',
      tags: ['default'],
      name: 'default',
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      availableNodes: nodes.map(n => n.n8nType),
      availableCredentials: creds,
    };
    store.save(instance);
    console.log(`Saved instance profile with ${creds.length} credentials.`);
  } catch (e) {
    console.warn('Could not extract credentials (API key may lack permission).');
  }

  // Show category breakdown
  const cats = new Map<string, number>();
  for (const n of nodes) {
    cats.set(n.category, (cats.get(n.category) ?? 0) + 1);
  }
  console.log('\nNode categories:');
  for (const [cat, count] of [...cats.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cat}: ${count}`);
  }
}

function cmdSearch(query: string): void {
  const store = getStore();
  const nodes = store.list<NodeDefinition>('nodeDefinition');
  const patterns = store.list<WorkflowPattern>('workflowPattern');

  const allEntities = [...nodes, ...patterns];
  if (allEntities.length === 0) {
    console.error('Store is empty. Run "extract" and/or "seed" first.');
    process.exit(1);
  }

  const engine = new SearchEngine();
  engine.index(allEntities);

  const results = engine.search(query, 15);
  console.log(`\nSearch: "${query}" → ${results.length} results\n`);

  for (const r of results) {
    const score = r.score.toFixed(3);
    if (r.entity.type === 'nodeDefinition') {
      const n = r.entity as NodeDefinition;
      console.log(`  [${score}] NODE: ${n.displayName} (${n.n8nType}) - ${n.category}`);
      console.log(`         ${n.description}`);
    } else if (r.entity.type === 'workflowPattern') {
      const p = r.entity as WorkflowPattern;
      console.log(`  [${score}] PATTERN: ${p.name}`);
      console.log(`         ${p.description}`);
      console.log(`         Nodes: ${p.nodes.map(n => n.n8nType).join(' → ')}`);
    }
  }
}

function cmdStats(): void {
  const store = getStore();
  console.log('\nn8n-a2e Store Statistics:');
  console.log(`  Node Definitions:   ${store.count('nodeDefinition')}`);
  console.log(`  Workflow Patterns:  ${store.count('workflowPattern')}`);
  console.log(`  Execution Contexts: ${store.count('executionContext')}`);
  console.log(`  n8n Instances:      ${store.count('n8nInstance')}`);
  console.log(`  Store path:         ${DEFAULT_STORE_PATH}`);
}

function cmdContext(query: string): void {
  const store = getStore();
  const orchestrator = new Orchestrator({ store });
  orchestrator.initialize();

  const context = orchestrator.generateContext(query);
  console.log(context);
}

async function cmdDeploy(filePath: string): Promise<void> {
  const config = getConfig();
  if (!config) {
    console.error('Error: Set N8N_BASE_URL and N8N_API_KEY env vars.');
    process.exit(1);
  }

  const absPath = resolve(filePath);
  if (!existsSync(absPath)) {
    console.error(`File not found: ${absPath}`);
    process.exit(1);
  }

  const workflow = JSON.parse(readFileSync(absPath, 'utf-8'));
  const store = getStore();
  const orchestrator = new Orchestrator({ store });
  orchestrator.initialize();
  orchestrator.setInstance({
    id: 'cli',
    type: 'n8nInstance',
    createdAt: '',
    updatedAt: '',
    tags: [],
    name: 'cli',
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    availableNodes: [],
    availableCredentials: [],
  });

  const result = await orchestrator.deploy(workflow);
  if (result.success) {
    console.log(`Workflow deployed successfully!`);
    console.log(`  ID:  ${result.workflowId}`);
    console.log(`  URL: ${result.workflowUrl}`);
  } else {
    console.error(`Deploy failed: ${result.error}`);
    if (result.validation.errors.length > 0) {
      console.error('\nValidation errors:');
      for (const e of result.validation.errors) {
        console.error(`  - ${e.node ? `[${e.node}] ` : ''}${e.message}`);
      }
    }
  }
}

// ─── Autonomous Mode ─────────────────────────────────────────────────────────

function loadFileConfig(): Record<string, string> {
  const configPath = resolve(process.cwd(), '.n8n-a2e', 'config.json');
  if (existsSync(configPath)) return JSON.parse(readFileSync(configPath, 'utf-8'));
  return {};
}

function detectLlmProvider(): { type: ProviderType; config: Record<string, unknown> } {
  const fileConfig = loadFileConfig();
  if (fileConfig.llmProvider) {
    return {
      type: fileConfig.llmProvider as ProviderType,
      config: {
        apiKey: fileConfig.llmApiKey || fileConfig.cfApiKey,
        accountId: fileConfig.cfAccountId,
        model: fileConfig.llmModel || fileConfig.cfModel,
        gateway: fileConfig.cfGateway,
      },
    };
  }
  if (process.env.CF_API_KEY && process.env.CF_ACCOUNT_ID) {
    return { type: 'cloudflare', config: { apiKey: process.env.CF_API_KEY, accountId: process.env.CF_ACCOUNT_ID, model: process.env.CF_MODEL } };
  }
  if (process.env.ANTHROPIC_API_KEY) return { type: 'claude', config: { apiKey: process.env.ANTHROPIC_API_KEY } };
  if (process.env.OPENAI_API_KEY) return { type: 'openai', config: { apiKey: process.env.OPENAI_API_KEY } };
  return { type: 'ollama', config: { model: process.env.OLLAMA_MODEL ?? 'llama3.1' } };
}

async function cmdAuto(goals: string[]): Promise<void> {
  const config = getConfig();
  if (!config) {
    console.error('Error: Set N8N_BASE_URL and N8N_API_KEY to deploy workflows.');
    process.exit(1);
  }

  const store = getStore();
  const orchestrator = new Orchestrator({ store });
  orchestrator.initialize();
  orchestrator.setInstance({
    id: 'auto',
    type: 'n8nInstance',
    createdAt: '',
    updatedAt: '',
    tags: [],
    name: 'auto',
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    availableNodes: [],
    availableCredentials: [],
  });

  const providerInfo = detectLlmProvider();
  const llm = createProvider(providerInfo.type, providerInfo.config);

  console.log(`\n🤖 Autonomous Mode`);
  console.log(`  LLM: ${providerInfo.type}`);
  console.log(`  n8n: ${config.baseUrl}`);
  console.log(`  Goals: ${goals.length}\n`);

  const agent = new AutonomousAgent({
    store,
    orchestrator,
    llm,
    autoActivate: true,
    onStatus: (event) => {
      const prefix = event.phase.toUpperCase().padEnd(14);
      console.log(`  [${prefix}] ${event.message}`);
    },
  });

  for (let i = 0; i < goals.length; i++) {
    console.log(`\n── Goal ${i + 1}/${goals.length}: "${goals[i]}" ──\n`);
    const result = await agent.execute(goals[i]);
    if (result.success) {
      console.log(`\n  ✓ Success: ${result.deployResult?.workflowUrl}`);
    } else {
      console.log(`\n  ✗ Failed: ${result.error}`);
    }
  }
}

// ─── Eval Mode ──────────────────────────────────────────────────────────────

async function cmdEval(args: string[]): Promise<void> {
  const store = getStore();
  const orchestrator = new Orchestrator({ store });
  orchestrator.initialize();

  // Optional: connect to n8n for credential binding
  const n8nConfig = getConfig();
  let instance: N8nInstance | undefined;
  if (n8nConfig) {
    instance = {
      id: 'eval', type: 'n8nInstance', createdAt: '', updatedAt: '', tags: [],
      name: 'eval', baseUrl: n8nConfig.baseUrl, apiKey: n8nConfig.apiKey,
      availableNodes: [], availableCredentials: [],
    };
    orchestrator.setInstance(instance);
  }

  // Parse model configs from args or use defaults
  const models = parseEvalModels(args);
  if (models.length === 0) {
    console.error('No models configured. Provide models via args or env vars.');
    console.error('Usage: n8n-a2e eval [--models cf:model1,cf:model2] [--goals simple|medium|complex|all]');
    console.error('\nExamples:');
    console.error('  n8n-a2e eval                                    # Default CF model');
    console.error('  n8n-a2e eval --models cf:@cf/meta/llama-3.3-70b-instruct-fp8-fast,cf:@cf/meta/llama-3.1-8b-instruct');
    console.error('  n8n-a2e eval --models claude:claude-sonnet-4-20250514,openai:gpt-4o');
    console.error('  n8n-a2e eval --goals simple');
    process.exit(1);
  }

  // Parse goal filter
  const goalFilter = parseGoalFilter(args);
  const goals = goalFilter
    ? DEFAULT_EVAL_GOALS.filter(g => g.tags?.some(t => goalFilter.includes(t)))
    : DEFAULT_EVAL_GOALS;

  console.log(`\n  n8n-a2e Model Evaluation`);
  console.log(`  Models: ${models.map(m => m.name).join(', ')}`);
  console.log(`  Goals:  ${goals.length}`);
  console.log(`  Total:  ${goals.length * models.length} runs\n`);

  const evaluator = new ModelEvaluator(store, orchestrator, instance);

  const report = await evaluator.runAll(goals, models, (done, total, result) => {
    const icon = result.deployReady ? '+' : result.planValid ? '~' : '-';
    const pct = Math.round(done / total * 100);
    console.log(`  [${pct.toString().padStart(3)}%] [${icon}] ${result.model.padEnd(30)} "${result.goal.slice(0, 40)}..." ${result.latencyMs}ms`);
  });

  // Print report
  console.log(ModelEvaluator.formatReport(report));

  // Save report to file
  const reportPath = resolve(process.cwd(), '.n8n-a2e', `eval-${Date.now()}.json`);
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync(resolve(process.cwd(), '.n8n-a2e'), { recursive: true });
  // Strip rawResponse for a cleaner file
  const cleanResults = report.results.map(({ rawResponse, ...rest }) => rest);
  writeFileSync(reportPath, JSON.stringify({ ...report, results: cleanResults }, null, 2));
  console.log(`\n  Report saved: ${reportPath}`);
}

function parseEvalModels(args: string[]): EvalModelConfig[] {
  const modelsIdx = args.indexOf('--models');
  if (modelsIdx !== -1 && args[modelsIdx + 1]) {
    const specs = args[modelsIdx + 1].split(',');
    return specs.map(spec => {
      const [providerStr, ...modelParts] = spec.split(':');
      const model = modelParts.join(':'); // Handle model names with colons
      const provider = providerStr === 'cf' ? 'cloudflare' : providerStr as ProviderType;

      const fileConfig = loadFileConfig();
      const config: Record<string, unknown> = {};

      switch (provider) {
        case 'cloudflare':
          config.apiKey = fileConfig.cfApiKey || process.env.CF_API_KEY;
          config.accountId = fileConfig.cfAccountId || process.env.CF_ACCOUNT_ID;
          config.model = model || fileConfig.cfModel;
          config.gateway = fileConfig.cfGateway || process.env.CF_GATEWAY;
          return { name: `cf/${(model || fileConfig.cfModel || 'default').split('/').pop()}`, provider: 'cloudflare' as ProviderType, config };
        case 'claude':
          config.apiKey = process.env.ANTHROPIC_API_KEY;
          config.model = model;
          return { name: `claude/${model || 'default'}`, provider, config };
        case 'openai':
          config.apiKey = process.env.OPENAI_API_KEY;
          config.model = model;
          return { name: `openai/${model || 'default'}`, provider, config };
        case 'ollama':
          config.model = model || 'llama3.1';
          return { name: `ollama/${model || 'llama3.1'}`, provider, config };
        default:
          return { name: spec, provider: provider as ProviderType, config };
      }
    });
  }

  // Default: use configured provider
  const providerInfo = detectLlmProvider();
  const modelName = (providerInfo.config.model as string) || 'default';
  return [{
    name: `${providerInfo.type}/${modelName.split('/').pop()}`,
    provider: providerInfo.type,
    config: providerInfo.config,
  }];
}

function parseGoalFilter(args: string[]): string[] | null {
  const goalsIdx = args.indexOf('--goals');
  if (goalsIdx !== -1 && args[goalsIdx + 1]) {
    return args[goalsIdx + 1].split(',');
  }
  return null;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;

  switch (command) {
    case 'extract':
      await cmdExtract();
      break;
    case 'extract-github':
      {
        console.log('Extracting node definitions from n8n GitHub repo...');
        const store = getStore();
        const nodes = await extractFromGitHub();
        const saved = store.saveBatch(nodes);
        console.log(`Saved ${saved.length} node definitions from GitHub.`);
        const cats = new Map<string, number>();
        for (const n of nodes) {
          cats.set(n.category, (cats.get(n.category) ?? 0) + 1);
        }
        console.log('\nNode categories:');
        for (const [cat, count] of [...cats.entries()].sort((a, b) => b[1] - a[1])) {
          console.log(`  ${cat}: ${count}`);
        }
      }
      break;
    case 'search':
      cmdSearch(args.join(' '));
      break;
    case 'stats':
      cmdStats();
      break;
    case 'context':
      cmdContext(args.join(' '));
      break;
    case 'deploy':
      await cmdDeploy(args[0]);
      break;
    case 'chat':
      await startChat();
      break;
    case 'seed':
      {
        const store = getStore();
        const count = seedPatterns(store);
        console.log(count > 0 ? `Seeded ${count} workflow patterns.` : 'Patterns already seeded.');
      }
      break;
    case 'mcp':
      await startMcpServer();
      break;
    case 'auto':
      if (args.length === 0) {
        console.error('Usage: n8n-a2e auto "goal 1" "goal 2" ...');
        console.error('Example: n8n-a2e auto "Create a webhook that sends Slack notifications"');
        process.exit(1);
      }
      await cmdAuto(args);
      break;
    case 'eval':
      await cmdEval(args);
      break;
    case 'extract-source':
      {
        const repoPath = args[0] || resolve(process.cwd(), '..', 'n8n-source');
        console.log(`Extracting node definitions from n8n source at: ${repoPath}`);
        const store = getStore();
        const nodes = await extractFromSource({
          repoPath,
          verbose: args.includes('--verbose') || args.includes('-v'),
        });
        const saved = store.saveBatch(nodes);
        console.log(`Saved ${saved.length} node definitions from source.`);
        const cats = new Map<string, number>();
        for (const n of nodes) {
          cats.set(n.category, (cats.get(n.category) ?? 0) + 1);
        }
        console.log('\nNode categories:');
        for (const [cat, count] of [...cats.entries()].sort((a, b) => b[1] - a[1])) {
          console.log(`  ${cat}: ${count}`);
        }
        // Show AI nodes specifically
        const aiNodes = nodes.filter(n => n.category === 'ai');
        if (aiNodes.length > 0) {
          console.log(`\nAI/LangChain nodes (${aiNodes.length}):`);
          for (const n of aiNodes.sort((a, b) => a.n8nType.localeCompare(b.n8nType))) {
            const ios = n.inputs.map(i => i.type).join(',') + ' -> ' + n.outputs.map(o => o.type).join(',');
            console.log(`  ${n.n8nType} (${n.displayName}) [${ios}]`);
          }
        }
      }
      break;
    default:
      console.log(`
n8n-a2e - Agent-to-n8n Workflow Composer

Usage:
  n8n-a2e extract                Extract node definitions from n8n instance
  n8n-a2e extract-source [path]  Extract from local n8n repo (includes AI/LangChain nodes)
  n8n-a2e search <query>         Search for nodes matching a query
  n8n-a2e context <query>        Generate LLM context for a query
  n8n-a2e deploy <file.json>     Deploy a workflow JSON to n8n
  n8n-a2e chat                   Interactive chat mode (compose workflows via conversation)
  n8n-a2e auto "goal" [...]      Autonomous mode: compose + deploy + learn (no human in the loop)
  n8n-a2e eval [--models ...] [--goals ...]  Evaluate LLM models for workflow composition
  n8n-a2e seed                   Seed store with built-in workflow patterns
  n8n-a2e mcp                    Start MCP server (for Claude Code integration)
  n8n-a2e stats                  Show store statistics

Environment:
  N8N_BASE_URL    n8n instance URL (e.g. http://localhost:5678)
  N8N_API_KEY     n8n API key
  ANTHROPIC_API_KEY  For Claude LLM (default)
  OPENAI_API_KEY     For OpenAI LLM
  OLLAMA_MODEL       For local Ollama (fallback, no key needed)
      `);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
