# n8n-a2e - Agent-to-n8n Workflow Composer

## What is this
An AI agent system that composes and deploys n8n workflows from natural language.
Inspired by RepoMemory v2's entity-based memory architecture, adapted for n8n.
Supports both interactive (human-in-loop) and fully autonomous (no-human) modes.

## Architecture
- **TypeScript/Node.js**, zero runtime dependencies, ESM modules
- Content-addressable filesystem store (Git-inspired, SHA-256 dedup)
- TF-IDF search with Porter stemming and query expansion
- 436 n8n node definitions extracted from GitHub
- 8 built-in + auto-learned workflow patterns
- 4 LLM providers: Claude, OpenAI, Ollama, Cloudflare Workers AI

## Project structure
```
src/
  types/        → Entity types + n8n workflow JSON types
  storage/      → Filesystem store with SHA-256 dedup
  extractor/    → Extract nodes from: API, GitHub, existing workflows
  search/       → TF-IDF search engine
  composer/     → Workflow JSON generator + validator
  client/       → n8n REST API client
  agent/        → Orchestrator (recall → compose → validate → deploy → learn)
  autonomous/   → Autonomous agent, circuit breaker, normalizer, sanitization, skills
  llm/          → AI providers (Claude/OpenAI/Ollama/Cloudflare) + conversational agent
  eval/         → Model evaluation framework + benchmark goals
  seeds/        → Built-in workflow patterns
  mcp/          → MCP server (6 tools)
  web/          → Web UI (zero-dependency HTTP server + chat interface)
  tests/        → Unit tests (feedback loop, normalizer)
  cli/          → CLI + interactive chat + autonomous + web mode
```

## Commands
```bash
npm run build                    # Compile TypeScript
node dist/cli/cli.js extract     # Extract from running n8n (needs N8N_BASE_URL + N8N_API_KEY)
node dist/cli/cli.js extract-github  # Extract from GitHub (no n8n instance needed)
node dist/cli/cli.js search <q>  # Search nodes + patterns
node dist/cli/cli.js context <q> # Generate LLM context
node dist/cli/cli.js chat        # Interactive chat mode
node dist/cli/cli.js auto "goal" # Autonomous mode: compose + deploy + learn (no human)
node dist/cli/cli.js deploy <f>  # Deploy workflow JSON
node dist/cli/cli.js seed        # Seed workflow patterns
node dist/cli/cli.js web         # Start web UI (port 3000)
node dist/cli/cli.js mcp         # Start MCP server
node dist/cli/cli.js stats       # Show store statistics
```

## Environment variables
- `N8N_BASE_URL` - n8n instance URL (e.g. http://localhost:5678)
- `N8N_API_KEY` - n8n API key
- `ANTHROPIC_API_KEY` - for Claude LLM
- `OPENAI_API_KEY` - for OpenAI LLM
- `OLLAMA_MODEL` - for local Ollama
- `CF_API_KEY` - for Cloudflare Workers AI
- `CF_ACCOUNT_ID` - for Cloudflare Workers AI

## Config file
`.n8n-a2e/config.json` - alternative to env vars, supports llmProvider, cfApiKey, cfAccountId, cfModel, cfGateway

## Store location
`.n8n-a2e/store/` in the project root. Contains nodeDefinition/, workflowPattern/, executionContext/, n8nInstance/

## Key pipeline
1. RECALL - TF-IDF search finds relevant nodes + patterns
2. PLAN - LLM generates WorkflowPlan JSON (with inline retry on parse failures)
3. NORMALIZE - Fix broken connections, orphans, self-loops from small models
4. COMPOSE - Generates valid n8n workflow JSON with auto-layout
5. VALIDATE - Checks params, credentials, connections
6. DEPLOY - POST to n8n REST API
7. LEARN - Saves successful workflows as new patterns

## Autonomous mode additions (src/autonomous/)
- **AutonomousAgent** - Full pipeline with auto-retry (up to 2), error recovery, few-shot from learned patterns
- **CircuitBreaker** - Blocks node types after 3 consecutive failures, injects anti-pattern context into LLM prompts
- **NormalizePlan** - Fixes out-of-bounds connections, self-loops, duplicates, auto-chains orphan nodes
- **WorkflowSkills** - Saves successes as patterns, errors as ExecutionContext, auto-promotes (5 successes → proven)
- **Sanitize** - 4-layer credential protection (known secrets, URL params, JSON fields, prefix detection)

## Evaluation (src/eval/)
- **ModelEvaluator** - Runs goals against LLM providers, measures JSON/plan/validation/deploy rates
- **runWithFeedback** - A/B test: baseline vs feedback-enriched, measures if models learn from errors
- **default-goals.ts** - 7 eval goals across simple/medium/complex complexity levels
- Supports inline retry (feeds parse errors back for self-correction)
- Auto-detects Qwen models and disables thinking mode (/no_think)

## Entity types (mapped from RepoMemory v2)
- NodeDefinition (Knowledge) - 436 n8n node schemas
- WorkflowPattern (Skills) - Proven/experimental/deprecated workflow templates
- ExecutionContext (Memories) - Errors, fixes, optimizations from executions
- N8nInstance (Profiles) - n8n connection configs

## n8n workflow JSON structure
- Connections: `{ "SourceNode": { "main": [[{ "node": "Target", "type": "main", "index": 0 }]] } }`
- AI tool connections use `"ai_tool"` type (flow reversed: tool → trigger)
- IF nodes: output 0 = true, output 1 = false
