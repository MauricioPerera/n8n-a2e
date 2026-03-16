/**
 * Interactive Chat CLI
 *
 * REPL interface for the workflow agent.
 * User types natural language → agent composes workflows → deploys to n8n.
 */

import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { Store } from '../storage/store.js';
import { Orchestrator } from '../agent/orchestrator.js';
import { WorkflowAgent } from '../llm/agent.js';
import { createProvider, type ProviderType } from '../llm/provider.js';
import type { N8nInstance } from '../types/entities.js';

const DEFAULT_STORE_PATH = resolve(process.cwd(), '.n8n-a2e', 'store');

function loadConfig(): Record<string, string> {
  const configPath = resolve(process.cwd(), '.n8n-a2e', 'config.json');
  if (existsSync(configPath)) {
    return JSON.parse(readFileSync(configPath, 'utf-8'));
  }
  return {};
}

function detectProvider(): { type: ProviderType; config: Record<string, unknown> } {
  // Priority: config file → env vars
  const fileConfig = loadConfig();

  if (fileConfig.llmProvider) {
    return {
      type: fileConfig.llmProvider as ProviderType,
      config: {
        apiKey: fileConfig.llmApiKey || fileConfig.cfApiKey,
        accountId: fileConfig.cfAccountId,
        model: fileConfig.llmModel,
        gateway: fileConfig.cfGateway,
      },
    };
  }

  // Env var priority: CF → Claude → OpenAI → Ollama
  if (process.env.CF_API_KEY && process.env.CF_ACCOUNT_ID) {
    return {
      type: 'cloudflare',
      config: {
        apiKey: process.env.CF_API_KEY,
        accountId: process.env.CF_ACCOUNT_ID,
        model: process.env.CF_MODEL,
        gateway: process.env.CF_GATEWAY,
      },
    };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      type: 'claude',
      config: { apiKey: process.env.ANTHROPIC_API_KEY, model: process.env.CLAUDE_MODEL },
    };
  }
  if (process.env.OPENAI_API_KEY) {
    return {
      type: 'openai',
      config: { apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL },
    };
  }

  // Default to Ollama (local, no key needed)
  return {
    type: 'ollama',
    config: { model: process.env.OLLAMA_MODEL ?? 'llama3.1' },
  };
}

function getN8nInstance(): N8nInstance | undefined {
  const baseUrl = process.env.N8N_BASE_URL || process.env.N8N_URL;
  const apiKey = process.env.N8N_API_KEY;

  if (!baseUrl || !apiKey) {
    // Try loading from store
    const store = new Store({ root: DEFAULT_STORE_PATH });
    const instances = store.list<N8nInstance>('n8nInstance');
    return instances[0];
  }

  return {
    id: 'env',
    type: 'n8nInstance',
    createdAt: '',
    updatedAt: '',
    tags: [],
    name: 'env',
    baseUrl,
    apiKey,
    availableNodes: [],
    availableCredentials: [],
  };
}

export async function startChat(): Promise<void> {
  // Setup
  const store = new Store({ root: DEFAULT_STORE_PATH });
  const nodeCount = store.count('nodeDefinition');

  if (nodeCount === 0) {
    console.log('No node definitions found. Run "n8n-a2e extract" first to populate the store.');
    console.log('Example: N8N_BASE_URL=http://localhost:5678 N8N_API_KEY=your-key node dist/cli/cli.js extract\n');
  }

  const orchestrator = new Orchestrator({ store });
  orchestrator.initialize();

  const instance = getN8nInstance();
  if (instance) {
    orchestrator.setInstance(instance);
    console.log(`n8n instance: ${instance.baseUrl}`);
  } else {
    console.log('No n8n instance configured. Workflows will be composed but not deployed.');
    console.log('Set N8N_BASE_URL and N8N_API_KEY to enable deployment.\n');
  }

  // LLM provider
  const providerInfo = detectProvider();
  const llm = createProvider(providerInfo.type, providerInfo.config);
  console.log(`LLM: ${providerInfo.type}${providerInfo.config.model ? ` (${providerInfo.config.model})` : ''}`);

  const stats = orchestrator.stats();
  console.log(`Store: ${stats.nodes} nodes, ${stats.patterns} patterns\n`);

  // Create agent (with store for feedback loop)
  const agent = new WorkflowAgent(llm, orchestrator, store);

  // REPL
  console.log('─────────────────────────────────────────────');
  console.log(' n8n-a2e Workflow Agent');
  console.log(' Describe the workflow you want to create.');
  console.log(' Commands: deploy, activate, json, reset, exit');
  console.log('─────────────────────────────────────────────\n');

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'you> ',
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    if (input.toLowerCase() === 'exit' || input.toLowerCase() === 'quit') {
      console.log('Bye!');
      rl.close();
      process.exit(0);
    }

    console.log('\nagent> thinking...\n');

    const response = await agent.chat(input);
    console.log(`agent> ${response.message}\n`);

    rl.prompt();
  });

  rl.on('close', () => {
    process.exit(0);
  });
}
