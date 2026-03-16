# n8n-a2e — Agent-to-n8n Workflow Composer

**Powered by [Context-Time Training (CTT)](https://github.com/MauricioPerera/repomemory-v2)** — the production validation of entity-based memory architecture applied to n8n automation.

> **Key finding:** A 1B-parameter model achieves 86% deploy-ready workflows with three lightweight guard rails (feedback loop + plan normalizer + inline retry). Small models fail on format, not logic — structured error feedback closes the gap without fine-tuning or larger models.

## Overview

n8n-a2e transforms natural language descriptions into fully valid n8n workflow JSON, deploys them to a running n8n instance via REST API, and learns from successful deployments to improve future compositions.

```
"Create a workflow that watches Slack and logs messages to Google Sheets"
                        ↓
              ┌─────────────────┐
              │   1. RECALL     │  TF-IDF search → relevant nodes + patterns
              ├─────────────────┤
              │   2. COMPOSE    │  LLM generates WorkflowPlan → valid JSON
              ├─────────────────┤
              │   3. VALIDATE   │  Check params, credentials, connections
              ├─────────────────┤
              │   4. DEPLOY     │  POST to n8n REST API
              ├─────────────────┤
              │   5. LEARN      │  Save as reusable pattern
              └─────────────────┘
                        ↓
            Active workflow in n8n
```

## Key Features

- **Zero runtime dependencies** — pure Node.js built-ins only (`crypto`, `fs`, `path`, `fetch`)
- **436 n8n node definitions** extracted from GitHub
- **8 built-in workflow patterns** as seeds
- **TF-IDF search** with Porter stemming and domain-specific query expansion
- **Content-addressable storage** with SHA-256 deduplication (Git-inspired)
- **4 LLM providers** — Claude, OpenAI, Ollama (local), Cloudflare Workers AI
- **MCP server** with 6 tools for external AI agent integration
- **Interactive chat** mode for conversational workflow building
- **Autonomous mode** — goal in, deployed workflow out, no human in the loop
- **Circuit breaker** prevents repeated failures on the same node types
- **Plan normalizer** fixes broken connections from small LLMs automatically
- **Inline retry** feeds parse errors back to the LLM for self-correction
- **Model evaluation** framework with A/B feedback testing across providers
- **Secret sanitization** strips credentials from learned patterns

## Quick Start

```bash
# Install & build
npm install
npm run build

# Extract node definitions (no n8n instance required)
node dist/cli/cli.js extract-github

# Seed built-in patterns
node dist/cli/cli.js seed

# Interactive chat (requires LLM provider)
node dist/cli/cli.js chat

# Web UI
node dist/cli/cli.js web

# Autonomous mode — no human in the loop
node dist/cli/cli.js auto "Create a webhook that responds with hello world"

# Start MCP server
node dist/cli/cli.js mcp
```

## Autonomous Mode

The killer feature: fully autonomous workflow creation with no human in the loop.

```bash
# Single goal
node dist/cli/cli.js auto "Create a webhook that responds with hello world"

# Multiple goals (batch)
node dist/cli/cli.js auto \
  "Schedule a GET request every 5 minutes to an API" \
  "Webhook that filters by status and responds with active items"
```

**What happens under the hood:**

```
Goal (natural language)
  ↓
[LLM Planning] → WorkflowPlan JSON (with few-shot from learned patterns)
  │                    ↑
  │        (inline retry: feed parse errors back to LLM)
  ↓
[Circuit Breaker] → Skip node types that failed repeatedly
  ↓
[Normalize Plan] → Fix broken connections, orphans, self-loops
  ↓
[Compose] → Valid n8n workflow JSON with auto-layout
  ↓
[Validate] → Check params, connections, credentials
  ↓                    ↑
[Deploy] ──failure──→ [Auto-Retry with error context] (up to 2 retries)
  ↓
[Learn] → Save pattern + sanitize secrets + update search index
  ↓
Active workflow in n8n
```

**Production validation of [Context-Time Training (CTT)](https://github.com/MauricioPerera/repomemory-v2)** and RepoMemory v2's A2E protocol, with key adaptations:
- **8 A2E primitives** (ApiCall, FilterData, etc.) replaced by **436+ real n8n nodes**
- **JSONL output** replaced by **native n8n workflow JSON**
- **Circuit breaker** with anti-pattern injection into LLM prompts (CTT feedback loop)
- **Plan normalizer + inline retry** — guard rails that make 1B models viable
- **Secret sanitization** strips credentials from learned patterns
- **Pattern learning** — successful workflows become few-shot examples (CTT skill accumulation)

## Architecture

```
src/
├── types/          Entity types (NodeDefinition, WorkflowPattern, etc.)
├── storage/        Content-addressable filesystem store
├── extractor/      Extract nodes from: n8n API, GitHub, existing workflows
├── search/         TF-IDF search engine with stemming + query expansion
├── composer/       Workflow JSON generator + validator
├── client/         n8n REST API client
├── agent/          Orchestrator (recall → compose → validate → deploy → learn)
├── autonomous/     Autonomous agent, circuit breaker, normalizer, sanitization, skills
├── llm/            AI providers (Claude/OpenAI/Ollama/Cloudflare) + agent
├── eval/           Model evaluation framework + benchmark goals
├── seeds/          Built-in workflow patterns
├── mcp/            MCP server (6 tools)
├── tests/          Unit tests (feedback loop, normalizer, etc.)
└── cli/            CLI + interactive chat + autonomous mode
```

### Module Dependency Graph

```
cli ──→ autonomous/agent ──→ agent/orchestrator ──→ composer/compose
  │            │                     │               composer/validate
  │            ├── circuit-breaker   │               client/n8n-client
  │            ├── workflow-skills   ↓
  │            └── sanitize    search/tfidf ──→ storage/store
  │
  ├──→ llm/agent (interactive) ──→ agent/orchestrator
  │
  └──→ llm/provider (Claude │ OpenAI │ Ollama │ Cloudflare)
```

---

## Entity Model

Five core entity types, mapped from RepoMemory v2 primitives:

| Entity | RepoMemory v2 Equivalent | Purpose |
|--------|--------------------------|---------|
| `NodeDefinition` | Knowledge | JSON schema of each n8n node (type, params, credentials, I/O) |
| `WorkflowPattern` | Skills | Proven workflow templates (nodes + connections + use cases) |
| `ExecutionContext` | Memories | Runtime facts: errors, fixes, optimizations learned |
| `N8nInstance` | Profiles | Connection config for n8n instances (URL, API key, credentials) |
| `BaseEntity` | — | Common fields: `id`, `createdAt`, `updatedAt`, `tags` |

### NodeDefinition

```typescript
interface NodeDefinition extends BaseEntity {
  type: 'nodeDefinition';
  n8nType: string;           // e.g. "n8n-nodes-base.slack"
  displayName: string;       // e.g. "Slack"
  version: number[];
  category: 'trigger' | 'action' | 'transform' | 'flow' | 'ai' | 'output' | 'input' | 'utility';
  group: string[];
  description: string;
  inputs: string[];
  outputs: string[];
  properties: NodeParam[];   // Parameter definitions (name, type, default, required, options)
  credentials: { name: string; type: string; required: boolean }[];
  defaults: Record<string, unknown>;
  icon?: string;
  subtitle?: string;
  documentationUrl?: string;
  usableAsTool?: boolean;
}
```

### WorkflowPattern

```typescript
interface WorkflowPattern extends BaseEntity {
  type: 'workflowPattern';
  name: string;
  description: string;
  useCases: string[];
  nodes: PatternNode[];       // { n8nType, label, parameters, position }
  connections: PatternConnection[];
  status: 'proven' | 'experimental' | 'deprecated';
  successCount: number;
  failCount: number;
}
```

---

## Pipeline Detail

### Stage 1: RECALL

TF-IDF search over all NodeDefinitions and WorkflowPatterns.

```typescript
const orchestrator = new Orchestrator({ store });
orchestrator.initialize(); // index all entities

const results = orchestrator.recall("send email on schedule", 10);
// → { nodes: [ScheduleTrigger, Gmail, SMTP, ...], patterns: [ScheduledDataSync, ...] }
```

**Search features:**
- Porter stemming (simplified)
- 50+ English stop words filtered
- Domain-specific query expansion: `"email"` → `["gmail", "smtp", "imap", "sendgrid", "mailgun"]`
- Tag-based boosting (1.3x multiplier)
- TF-IDF scoring: `normalizedTF × log(totalDocs / (docFreq + 1))`

### Stage 2: COMPOSE

Converts a `WorkflowPlan` into valid `N8nWorkflow` JSON.

```typescript
const plan: WorkflowPlan = {
  name: "Daily Email Report",
  description: "Send daily summary email",
  steps: [
    { index: 0, node: scheduleTriggerDef, role: "trigger" },
    { index: 1, node: httpRequestDef, role: "process", parameters: { url: "..." } },
    { index: 2, node: gmailDef, role: "output", credentials: { gmailOAuth2: { id: "1", name: "Gmail" } } }
  ],
  connections: [
    { from: 0, to: 1 },
    { from: 1, to: 2 }
  ]
};

const workflow = orchestrator.compose(plan);
```

**Auto-layout algorithm:**
- Left-to-right topological sort (BFS)
- Spacing: 300px horizontal, 200px vertical
- Starts at position `(250, 300)`

### Stage 3: VALIDATE

Checks workflow integrity against known node definitions.

```typescript
const result = orchestrator.validate(workflow);
// → { valid: true, errors: [], warnings: ["No trigger node found"] }
```

**Validation checks:**
1. At least one node exists
2. Workflow has a name
3. Has trigger node (warning if missing)
4. No duplicate node names
5. All node types exist in definitions
6. Required parameters are set
7. Credentials are available
8. Connection integrity (source/target exist)
9. No orphan nodes

### Stage 4: DEPLOY

Push to n8n via REST API.

```typescript
const result = await orchestrator.deploy(workflow, true); // true = activate
// → { success: true, workflowId: "abc123", workflowUrl: "http://localhost:5678/workflow/abc123" }
```

### Stage 5: LEARN

Successful workflows are saved as reusable patterns.

```typescript
orchestrator.learn(workflow, ["daily email report", "scheduled data push"]);
// Saved as WorkflowPattern with status: 'experimental'
// Re-indexes search so future queries find it
```

---

## LLM Providers

Four pluggable providers, all implementing the same interface:

```typescript
interface LlmProvider {
  name: string;
  chat(messages: LlmMessage[], options?: LlmOptions): Promise<LlmResponse>;
}
```

| Provider | Default Model | Config |
|----------|---------------|--------|
| `ClaudeProvider` | `claude-sonnet-4-20250514` | `ANTHROPIC_API_KEY` |
| `OpenAiProvider` | `gpt-4o` | `OPENAI_API_KEY` |
| `OllamaProvider` | `llama3.1` | Local, `http://localhost:11434` |
| `CloudflareAiProvider` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | `CF_API_KEY` + `CF_ACCOUNT_ID` |

```typescript
// Factory
const provider = createProvider('cloudflare', {
  apiKey: 'your-key',
  accountId: 'your-account',
  gateway: 'my-gateway', // optional AI Gateway
});
```

### Conversational Agent

The `WorkflowAgent` class maintains a session with conversation history for iterative refinement:

```typescript
const agent = new WorkflowAgent(orchestrator, provider);

const response = await agent.chat("Create a webhook that sends Slack notifications");
// → { action: 'plan', message: "...", plan: {...}, workflow: {...} }

const refined = await agent.chat("Add an IF node to filter by status code");
// → { action: 'plan', message: "...", plan: {...}, workflow: {...} }

await agent.chat("/deploy");
// → { action: 'deploy', deployResult: { success: true, workflowId: "..." } }
```

**Chat shortcuts:**
- `/deploy` or `despliega` — deploy last workflow
- `/activate` or `activa` — activate deployed workflow
- `/json` — show raw workflow JSON
- `/reset` — clear session

---

## Autonomous Agent

### AutonomousAgent

The core class for fully autonomous workflow creation.

```typescript
import { AutonomousAgent } from '@n8n-a2e/core';

const agent = new AutonomousAgent({
  store,
  orchestrator,
  llm: createProvider('cloudflare', { apiKey: '...', accountId: '...' }),
  maxRetries: 2,               // auto-retry on failure
  circuitBreakerThreshold: 3,  // block node after 3 consecutive errors
  autoActivate: true,          // activate workflows after deploy
  secrets: new Map([           // sanitize before saving patterns
    ['API_KEY', 'sk-live-abc123'],
  ]),
  onStatus: (event) => {       // real-time status callback
    console.log(`[${event.phase}] ${event.message}`);
  },
});

// Single goal
const result = await agent.execute("Create a cron job that fetches an API every hour");
// → { success: true, workflow, deployResult, plan, events, retries: 0 }

// Batch goals
const results = await agent.executeBatch([
  "Webhook that logs to database",
  "Email trigger that sends Slack notifications",
]);
```

### Circuit Breaker

Prevents the agent from repeatedly failing on the same node types.

```typescript
import { CircuitBreaker } from '@n8n-a2e/core';

const breaker = new CircuitBreaker(store, 3); // threshold = 3 errors

breaker.check('n8n-nodes-base.slack');
// → { open: false, errorCount: 0, target: 'n8n-nodes-base.slack', message: '...' }

breaker.recordError('n8n-nodes-base.slack', 'Missing credentials');
// After 3 errors: circuit opens, agent will request alternative nodes from LLM
```

### Secret Sanitization

Prevents credentials from leaking into learned patterns.

```typescript
import { sanitizeSecrets, sanitizeParameters } from '@n8n-a2e/core';

// 4-layer sanitization:
// 1. Known secrets → {{PLACEHOLDER}}
// 2. URL auth params (apikey, token, access_token)
// 3. JSON credential fields (authorization, api_key, bearer)
// 4. Known prefixes (Bearer, sk-, ghp_, xoxb-, eyJ)

sanitizeSecrets('Bearer sk-ant-api123-abc', new Map([['MY_KEY', 'sk-ant-api123-abc']]));
// → '{{MY_KEY}}'

sanitizeParameters({ apiKey: 'secret123', url: 'https://api.example.com' });
// → { apiKey: '{{APIKEY}}', url: 'https://api.example.com' }
```

### Workflow Skills (Learning Layer)

```typescript
import { saveWorkflowSkill, recallWorkflowSkills, markPatternSuccess } from '@n8n-a2e/core';

// Automatically called by AutonomousAgent on success:
saveWorkflowSkill(store, workflow, "the original goal", ["use case 1"]);

// Recall previously learned patterns (used as few-shot examples):
const patterns = recallWorkflowSkills(store, 3);

// Patterns auto-promote: experimental → proven (after 5 successes)
// Patterns auto-deprecate: after 5 failures
markPatternSuccess(store, patternId);
```

---

## n8n REST API Client

Full CRUD for workflows + execution history:

```typescript
const client = new N8nClient({ baseUrl: 'http://localhost:5678', apiKey: 'your-key' });

await client.createWorkflow(workflow);
await client.listWorkflows({ active: true, limit: 10 });
await client.getWorkflow('workflow-id');
await client.updateWorkflow('workflow-id', { name: 'Updated' });
await client.activateWorkflow('workflow-id');
await client.deactivateWorkflow('workflow-id');
await client.deleteWorkflow('workflow-id');
await client.listExecutions('workflow-id', 5);
await client.healthCheck();
```

All requests use header `X-N8N-API-KEY` for authentication.

---

## MCP Server

Exposes 6 tools over JSON-RPC 2.0 (stdio) for integration with Claude Code, Cursor, or any MCP client.

```bash
node dist/cli/cli.js mcp
```

### Tools

| Tool | Input | Output |
|------|-------|--------|
| `search_n8n_nodes` | `query`, `limit` | Matching nodes with scores |
| `get_node_details` | `n8nType` | Full NodeDefinition JSON |
| `compose_workflow` | `name`, `steps[]`, `connections[]` | Valid N8nWorkflow JSON |
| `deploy_workflow` | `workflow`, `activate?` | DeployResult |
| `list_workflow_patterns` | `query?` | WorkflowPattern[] |
| `generate_workflow_context` | `query` | Rich markdown with nodes + patterns |

### Claude Code Integration

Add to `~/.claude/claude_code_config.json`:

```json
{
  "mcpServers": {
    "n8n-a2e": {
      "command": "node",
      "args": ["D:/repos/n8n_a2e/dist/mcp/main.js"],
      "env": {
        "N8N_BASE_URL": "http://localhost:5678",
        "N8N_API_KEY": "your-api-key"
      }
    }
  }
}
```

---

## Storage System

Git-inspired content-addressable filesystem store.

```
.n8n-a2e/store/
├── nodeDefinition/       # 436+ files (one JSON per node)
├── workflowPattern/      # 8+ files (seed + learned patterns)
├── executionContext/      # Runtime learnings (errors, fixes)
└── n8nInstance/           # n8n connection configs
```

**Deduplication:** SHA-256 hash of content → `.hash_<sha256>` marker files prevent duplicates.

**Format:** Each entity is a JSON file named by UUID.

```typescript
const store = new Store({ root: '.n8n-a2e/store' });

store.save<NodeDefinition>(entity);          // auto-generates id + timestamps
store.saveBatch<NodeDefinition>(entities);   // batch with dedup
store.get<NodeDefinition>('nodeDefinition', id);
store.list<NodeDefinition>('nodeDefinition');
store.delete('nodeDefinition', id);
store.count('nodeDefinition');               // → 436
store.hasNode('n8n-nodes-base.slack');       // → true
store.getNode('n8n-nodes-base.slack');       // → NodeDefinition
```

---

## Node Extraction

### From GitHub (no n8n instance needed)

```bash
node dist/cli/cli.js extract-github
```

Fetches `packages/nodes-base/package.json` from the n8n repository, parses the node registration list, and generates stub definitions for all 436+ nodes.

### From Running n8n Instance

```bash
N8N_BASE_URL=http://localhost:5678 N8N_API_KEY=your-key node dist/cli/cli.js extract
```

Calls `GET /types/nodes.json` on the n8n internal API to get full node type descriptions with complete parameters, credentials, and metadata.

---

## CLI Commands

| Command | Description |
|---------|-------------|
| `extract` | Extract nodes from running n8n (requires `N8N_BASE_URL` + `N8N_API_KEY`) |
| `extract-github` | Extract from GitHub (no n8n needed) |
| `search <query>` | TF-IDF search over nodes + patterns |
| `context <query>` | Generate LLM-ready context markdown |
| `chat` | Interactive conversation mode |
| `auto "goal" [...]` | Autonomous: compose + deploy + learn, no human in loop |
| `deploy <file.json>` | Deploy workflow JSON to n8n |
| `seed` | Load 8 built-in workflow patterns |
| `web [port]` | Start web UI (default port 3000) |
| `mcp` | Start MCP server on stdio |
| `stats` | Show store statistics |

---

## Seed Patterns

8 built-in workflow patterns for common use cases:

| Pattern | Nodes | Use Case |
|---------|-------|----------|
| Webhook API endpoint | webhook → set → respondToWebhook | REST API endpoints |
| Scheduled data sync | scheduleTrigger → httpRequest → set | Cron-based data pulls |
| Email with routing | emailReadImap → if → slack/gmail | Conditional email processing |
| File upload + notify | webhook → googleDrive → slack | Cloud storage with notifications |
| CRM enrichment | trigger → httpRequest → if → salesforce | Lead lookup and routing |
| Slack to database | slackTrigger → if → mysql/postgres | Chat message persistence |
| Data transform | httpRequest → code → spreadsheet → email | ETL pipelines |
| AI agent with tools | webhook → agent → tools → respond | AI-powered workflows |

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `N8N_BASE_URL` | For deploy | n8n instance URL (e.g. `http://localhost:5678`) |
| `N8N_API_KEY` | For deploy | n8n API key |
| `ANTHROPIC_API_KEY` | For Claude | Anthropic API key |
| `OPENAI_API_KEY` | For OpenAI | OpenAI API key |
| `OLLAMA_MODEL` | For Ollama | Local model name (default: `llama3.1`) |
| `CF_API_KEY` | For Cloudflare | Cloudflare API token |
| `CF_ACCOUNT_ID` | For Cloudflare | Cloudflare account ID |

Config file alternative: `.n8n-a2e/config.json`

```json
{
  "baseUrl": "http://localhost:5678",
  "apiKey": "your-n8n-api-key",
  "llmProvider": "cloudflare",
  "cfApiKey": "your-cf-key",
  "cfAccountId": "your-account-id",
  "cfModel": "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
}
```

---

## Library Usage

All modules are exported for programmatic use:

```typescript
import {
  // Storage
  Store,
  // Search
  SearchEngine,
  // Composer
  composeWorkflow, validateWorkflow,
  // Client
  N8nClient,
  // Orchestrator
  Orchestrator,
  // LLM
  createProvider, WorkflowAgent,
  // Autonomous
  AutonomousAgent, CircuitBreaker,
  sanitizeSecrets, sanitizeParameters,
  saveWorkflowSkill, recallWorkflowSkills, markPatternSuccess,
  // Seeds
  seedPatterns,
  // MCP
  startMcpServer,
} from '@n8n-a2e/core';

// Initialize
const store = new Store({ root: '.n8n-a2e/store' });
seedPatterns(store);

const orchestrator = new Orchestrator({ store });
orchestrator.initialize();

// Search
const results = orchestrator.recall("slack notification on webhook", 5);

// ── Option A: Interactive (human in the loop) ──
const provider = createProvider('cloudflare', { apiKey: '...', accountId: '...' });
const chatAgent = new WorkflowAgent(provider, orchestrator);
const response = await chatAgent.chat("Watch a webhook and send Slack messages");

// ── Option B: Autonomous (no human in the loop) ──
const autoAgent = new AutonomousAgent({
  store,
  orchestrator,
  llm: provider,
  autoActivate: true,
  onStatus: (e) => console.log(`[${e.phase}] ${e.message}`),
});
const result = await autoAgent.execute("Create a cron job that fetches an API every hour");
console.log(result.deployResult?.workflowUrl);
```

---

## Feedback Loop & Error Recovery

Three complementary systems ensure LLMs produce valid workflows, even at small model sizes:

### 1. Anti-Pattern Feedback (Semantic Errors)

The **CircuitBreaker** tracks node-type failures across executions and injects "Known Issues" context into LLM prompts so models avoid repeating past mistakes.

```
Circuit Breaker records:
  n8n-nodes-base.slack → 3 errors → circuit OPEN
    - "Missing credentials for Slack"
    - Resolution: "Use n8n-nodes-base.httpRequest with Slack webhook URL instead"

Injected into LLM prompt:
  ## Known Issues (avoid these mistakes)
  - n8n-nodes-base.slack: Missing credentials → Use httpRequest with webhook URL instead
```

Both **interactive** (`WorkflowAgent`) and **autonomous** (`AutonomousAgent`) modes share the same feedback mechanism. Errors are recorded on deploy failure and cleared on success.

### 2. Plan Normalizer (Structural Errors)

Small models (<3B params) generate structurally broken plans — out-of-bounds connections, self-loops, orphan nodes. The **normalizePlan** layer fixes these automatically before composition:

```typescript
import { normalizePlan } from '@n8n-a2e/core';

const { plan: fixed, fixes } = normalizePlan(rawPlan);
// fixes: ["removed out-of-bounds connection 5→8", "auto-chained orphan node 3→2"]
```

**Fixes applied:**
- Reindex steps to match array positions
- Remove connections referencing non-existent step indices
- Remove self-loops (`from === to`)
- Deduplicate connections
- Auto-chain orphan nodes (nodes with no incoming connections)

### 3. Inline Retry (Format Errors)

When the LLM produces invalid JSON or missing required fields, the system feeds the specific error back in a multi-turn conversation before giving up:

```
Turn 1: LLM → invalid JSON
Turn 2: "ERROR: JSON missing required fields: connections. The JSON must have..."
Turn 3: LLM → valid workflow ✓
```

This is especially effective for small models that understand the task but struggle with output format. Configurable via `maxRetries` parameter (default: 1).

---

## Model Evaluation

Built-in evaluation framework for comparing LLM providers on workflow composition quality.

### Running Evaluations

```bash
# Run the evaluation script
node dist/eval/run-hermes-eval.js
```

### Evaluation Goals

7 test goals across 3 complexity levels:

| Level | Goals | Examples |
|-------|-------|---------|
| Simple (2-3 nodes) | 3 | Webhook with greeting, scheduled HTTP, UUID generator |
| Medium (3-5 nodes) | 2 | Filtered webhook, API data transform |
| Complex (5+ nodes) | 2 | Conditional branching with Slack/Sheets, multi-API merge |

### Metrics

Each goal is evaluated on:
- **JSON Valid** — LLM produced parseable JSON
- **Plan Valid** — JSON has correct `name`, `steps[]`, `connections[]` structure
- **Validation Pass** — workflow passes all integrity checks (types, params, connections)
- **Deploy Ready** — would succeed on `POST` to n8n API

### Feedback Evaluation (`runWithFeedback`)

Runs 2 rounds per model:
1. **Baseline** — no prior context
2. **With Feedback** — injects anti-patterns from round 1 failures

Measures whether models "learn" from error context provided in-prompt.

### Benchmark Results

Tested across 7 models via Cloudflare Workers AI, ranging from 1B to 70B parameters.
All models use ~1,100 input tokens (context) + 200-400 output tokens per workflow.

| Model | Params | Baseline | +Feedback | +Normalizer+FB | +Retry | +Retry+FB | ~Tokens/wf | Cost/wf |
|-------|--------|:--------:|:---------:|:--------------:|:------:|:---------:|:----------:|:-------:|
| Granite 4.0 Micro | — | 100% | 100% | — | — | — | ~1,500 | $0* |
| Qwen 3 30B | 30B | 100% | 100% | — | — | — | ~2,300 | $0* |
| Mistral 7B v0.1 | 7B | 100% | 100% | — | — | — | ~1,500 | $0* |
| Llama 3.3 70B | 70B | 86% | 100% | — | — | — | ~1,500 | $0* |
| Llama 3 8B | 8B | 71% | 86% | — | — | — | ~1,500 | $0* |
| Llama 3.2 3B | 3B | 71% | 100% | — | — | — | ~1,500 | $0* |
| Llama 3.2 1B | 1B | 29% | 57-71% | 86% | 86% | 86% | ~1,500 | $0* |

*\*Cloudflare Workers AI free tier. Ollama local models: $0 (your hardware). For comparison: equivalent quality via GPT-4o ≈ $0.02/workflow, Claude Sonnet ≈ $0.01/workflow.*

**Key findings:**

1. **Small models fail on format, not logic.** A 1B model understands "webhook → filter → respond" but outputs broken JSON. Inline retry (feeding the parse error back) jumps it from 29% → 86% — no fine-tuning, no larger model needed. This validates CTT's core thesis: structured context at inference time substitutes for parameter count.
2. **Feedback loop works** — every non-100% model improved with anti-pattern context. Most dramatic: Llama 3.2 3B went from 71% → 100%.
3. **Normalizer is critical for small models** — 1B models generate broken connections that crash the compositor. The normalizer fixes these automatically.
4. **The three mechanisms are complementary**: feedback (avoids semantic errors), normalizer (fixes structural errors), retry (corrects format errors).
5. **From 7B and up, baseline is already solid** — Mistral 7B achieved 100% with no assistance. The guard rails exist for democratizing access to smaller/free models.

### Custom Evaluations

```typescript
import { ModelEvaluator, type EvalModelConfig } from '@n8n-a2e/core';

const evaluator = new ModelEvaluator(store, orchestrator);

// Single model run
const report = await evaluator.runAll(goals, [modelConfig], (done, total, result) => {
  console.log(`[${done}/${total}] ${result.model}: ${result.deployReady ? 'PASS' : 'FAIL'}`);
});

// A/B test: baseline vs feedback
const { baseline, withFeedback } = await evaluator.runWithFeedback(goals, models);
console.log(ModelEvaluator.formatReport(baseline));
```

---

## Build

```bash
npm run build    # TypeScript → dist/
npm run dev      # Watch mode
npm test         # Run tests
```

**Requirements:** Node.js 18+ (for native `fetch`), TypeScript 5.4+

---

## How n8n Workflow JSON Works

For reference, this is the structure n8n-a2e generates:

```json
{
  "name": "My Workflow",
  "active": false,
  "nodes": [
    {
      "id": "uuid",
      "name": "Webhook",
      "type": "n8n-nodes-base.webhook",
      "typeVersion": 2,
      "position": [250, 300],
      "parameters": { "path": "my-hook", "httpMethod": "POST" },
      "credentials": {}
    },
    {
      "id": "uuid",
      "name": "Slack",
      "type": "n8n-nodes-base.slack",
      "typeVersion": 2.2,
      "position": [550, 300],
      "parameters": { "channel": "#general", "text": "={{ $json.message }}" },
      "credentials": { "slackApi": { "id": "1", "name": "Slack" } }
    }
  ],
  "connections": {
    "Webhook": {
      "main": [
        [{ "node": "Slack", "type": "main", "index": 0 }]
      ]
    }
  },
  "settings": { "executionOrder": "v1" }
}
```

**Connection structure:**
- Outer key = source node name
- `"main"` = standard data connection type
- Outer array index = source output index (IF node: 0=true, 1=false)
- Inner array = multiple targets from same output
- `ai_tool` connection type for MCP/AI tool nodes (flow is reversed: tool → trigger)

---

## License

MIT
