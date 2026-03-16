/**
 * MCP Server for n8n-a2e
 *
 * Exposes n8n-a2e capabilities as MCP tools that any MCP-compatible
 * AI agent (Claude Code, etc.) can call.
 *
 * Tools:
 *   - search_n8n_nodes: Search for n8n nodes by description
 *   - compose_workflow: Compose a workflow from a plan
 *   - deploy_workflow: Deploy a workflow to n8n
 *   - list_workflow_patterns: List known workflow patterns
 *   - get_node_details: Get full details of a specific node type
 *   - generate_workflow_context: Generate LLM context for workflow composition
 *
 * Protocol: JSON-RPC over stdio (MCP standard)
 */

import { resolve } from 'node:path';
import { Store } from '../storage/store.js';
import { Orchestrator } from '../agent/orchestrator.js';
import { seedPatterns } from '../seeds/patterns.js';
import type { NodeDefinition, WorkflowPattern, N8nInstance } from '../types/entities.js';

const DEFAULT_STORE_PATH = resolve(process.cwd(), '.n8n-a2e', 'store');

// ─── MCP Protocol Types ──────────────────────────────────────────────────────

interface McpRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

interface McpResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// ─── Tool Definitions ────────────────────────────────────────────────────────

const TOOLS: McpTool[] = [
  {
    name: 'search_n8n_nodes',
    description: 'Search for n8n nodes by natural language description. Returns matching nodes with relevance scores.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language search query (e.g. "send email", "database query", "AI agent")' },
        limit: { type: 'number', description: 'Max results to return (default 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_node_details',
    description: 'Get full details of a specific n8n node type including all parameters, credentials, inputs/outputs.',
    inputSchema: {
      type: 'object',
      properties: {
        n8nType: { type: 'string', description: 'The n8n node type (e.g. "n8n-nodes-base.slack", "n8n-nodes-base.httpRequest")' },
      },
      required: ['n8nType'],
    },
  },
  {
    name: 'compose_workflow',
    description: 'Compose an n8n workflow from a structured plan. Returns valid workflow JSON ready for deployment.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Workflow name' },
        description: { type: 'string', description: 'What the workflow does' },
        steps: {
          type: 'array',
          description: 'Array of workflow steps',
          items: {
            type: 'object',
            properties: {
              n8nType: { type: 'string', description: 'n8n node type' },
              label: { type: 'string', description: 'Display label' },
              parameters: { type: 'object', description: 'Node parameters' },
            },
            required: ['n8nType'],
          },
        },
        connections: {
          type: 'array',
          description: 'Array of connections between steps (by index)',
          items: {
            type: 'object',
            properties: {
              from: { type: 'number' },
              to: { type: 'number' },
              fromOutput: { type: 'number' },
              toInput: { type: 'number' },
            },
            required: ['from', 'to'],
          },
        },
      },
      required: ['name', 'steps', 'connections'],
    },
  },
  {
    name: 'deploy_workflow',
    description: 'Deploy a workflow JSON to the configured n8n instance.',
    inputSchema: {
      type: 'object',
      properties: {
        workflow: { type: 'object', description: 'The n8n workflow JSON (from compose_workflow)' },
        activate: { type: 'boolean', description: 'Whether to activate immediately (default false)' },
      },
      required: ['workflow'],
    },
  },
  {
    name: 'list_workflow_patterns',
    description: 'List known workflow patterns/templates that can be used as starting points.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional search query to filter patterns' },
      },
    },
  },
  {
    name: 'generate_workflow_context',
    description: 'Generate a rich context string with relevant nodes and patterns for a given use case. Useful for composing workflows.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Description of what the workflow should do' },
      },
      required: ['query'],
    },
  },
];

// ─── Server ──────────────────────────────────────────────────────────────────

export class McpServer {
  private store: Store;
  private orchestrator: Orchestrator;

  constructor() {
    this.store = new Store({ root: DEFAULT_STORE_PATH });
    seedPatterns(this.store);
    this.orchestrator = new Orchestrator({ store: this.store });

    // Load instance if available
    const instances = this.store.list<N8nInstance>('n8nInstance');
    if (instances.length > 0) {
      this.orchestrator.setInstance(instances[0]);
    }

    this.orchestrator.initialize();
  }

  /** Handle an MCP JSON-RPC request */
  async handleRequest(request: McpRequest): Promise<McpResponse> {
    try {
      switch (request.method) {
        case 'initialize':
          return this.respond(request.id, {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: {
              name: 'n8n-a2e',
              version: '0.1.0',
            },
          });

        case 'tools/list':
          return this.respond(request.id, { tools: TOOLS });

        case 'tools/call':
          return this.handleToolCall(request);

        case 'notifications/initialized':
          return this.respond(request.id, {});

        default:
          return this.error(request.id, -32601, `Method not found: ${request.method}`);
      }
    } catch (err) {
      return this.error(request.id, -32603, `Internal error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleToolCall(request: McpRequest): Promise<McpResponse> {
    const params = request.params as { name: string; arguments: Record<string, unknown> };
    const { name, arguments: args } = params;

    switch (name) {
      case 'search_n8n_nodes': {
        const results = this.orchestrator.recall(args.query as string, (args.limit as number) ?? 10);
        const nodes = results.nodes.map(r => {
          const n = r.entity as NodeDefinition;
          return {
            n8nType: n.n8nType,
            displayName: n.displayName,
            category: n.category,
            description: n.description,
            score: r.score,
            credentials: n.credentials.map(c => c.name),
          };
        });
        return this.respondContent(request.id, JSON.stringify(nodes, null, 2));
      }

      case 'get_node_details': {
        const def = this.orchestrator.getNodeDef(args.n8nType as string);
        if (!def) {
          return this.respondContent(request.id, `Node type "${args.n8nType}" not found.`);
        }
        return this.respondContent(request.id, JSON.stringify(def, null, 2));
      }

      case 'compose_workflow': {
        const plan = args as unknown as {
          name: string;
          description?: string;
          steps: { n8nType: string; label?: string; parameters?: Record<string, unknown> }[];
          connections: { from: number; to: number; fromOutput?: number; toInput?: number }[];
        };

        // Resolve steps to WorkflowSteps
        const steps = plan.steps.map((s, i) => {
          const nodeDef = this.orchestrator.getNodeDef(s.n8nType);
          return {
            index: i,
            node: nodeDef || this.placeholderNode(s.n8nType, s.label),
            role: i === 0 ? 'trigger' : 'process',
            label: s.label,
            parameters: s.parameters,
          };
        });

        const workflow = this.orchestrator.compose({
          name: plan.name,
          description: plan.description ?? '',
          steps,
          connections: plan.connections,
        });

        const validation = this.orchestrator.validate(workflow);
        return this.respondContent(request.id, JSON.stringify({ workflow, validation }, null, 2));
      }

      case 'deploy_workflow': {
        const result = await this.orchestrator.deploy(
          args.workflow as any,
          args.activate as boolean
        );
        return this.respondContent(request.id, JSON.stringify(result, null, 2));
      }

      case 'list_workflow_patterns': {
        const patterns = this.store.list<WorkflowPattern>('workflowPattern');
        let filtered = patterns;
        if (args.query) {
          const results = this.orchestrator.recall(args.query as string, 20);
          const patternIds = new Set(results.patterns.map(r => r.entity.id));
          filtered = patterns.filter(p => patternIds.has(p.id));
        }
        const summary = filtered.map(p => ({
          name: p.name,
          description: p.description,
          useCases: p.useCases,
          nodes: p.nodes.map(n => n.n8nType),
          status: p.status,
        }));
        return this.respondContent(request.id, JSON.stringify(summary, null, 2));
      }

      case 'generate_workflow_context': {
        const context = this.orchestrator.generateContext(args.query as string);
        return this.respondContent(request.id, context);
      }

      default:
        return this.error(request.id, -32602, `Unknown tool: ${name}`);
    }
  }

  private placeholderNode(n8nType: string, label?: string): NodeDefinition {
    return {
      id: n8nType,
      type: 'nodeDefinition',
      createdAt: '',
      updatedAt: '',
      tags: [],
      n8nType,
      displayName: label || n8nType.split('.').pop() || n8nType,
      version: [1],
      category: 'action',
      group: [],
      description: '',
      inputs: [{ type: 'main' }],
      outputs: [{ type: 'main' }],
      properties: [],
      credentials: [],
      defaults: {},
    };
  }

  private respond(id: number | string, result: unknown): McpResponse {
    return { jsonrpc: '2.0', id, result };
  }

  private respondContent(id: number | string, text: string): McpResponse {
    return {
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text }] },
    };
  }

  private error(id: number | string, code: number, message: string): McpResponse {
    return { jsonrpc: '2.0', id, error: { code, message } };
  }
}

// ─── stdio transport ─────────────────────────────────────────────────────────

export async function startMcpServer(): Promise<void> {
  const server = new McpServer();
  let buffer = '';

  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', async (chunk: string) => {
    buffer += chunk;

    // MCP uses newline-delimited JSON
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const request = JSON.parse(trimmed) as McpRequest;
        const response = await server.handleRequest(request);
        if (request.method !== 'notifications/initialized') {
          process.stdout.write(JSON.stringify(response) + '\n');
        }
      } catch {
        // Malformed JSON, skip
      }
    }
  });

  process.stderr.write('n8n-a2e MCP server started\n');
}
