/**
 * Agent Orchestrator
 *
 * The brain of n8n-a2e. Executes the pipeline:
 *   RECALL → COMPOSE → VALIDATE → DEPLOY → LEARN
 *
 * This module is AI-provider agnostic - it provides the structured
 * context and tools that an LLM agent needs to compose workflows.
 */

import { resolve } from 'node:path';
import { Store } from '../storage/store.js';
import { SearchEngine, type SearchResult } from '../search/tfidf.js';
import { HybridSearchEngine } from '../search/hybrid.js';
import { composeWorkflow, type ComposeOptions, type ComposerNode, type ComposerConnection } from '../composer/compose.js';
import { validateWorkflow, type ValidationResult } from '../composer/validate.js';
import { matchCredentials, fetchCredentials, type CredentialMatchResult, type CredentialBinding } from '../composer/credential-matcher.js';
import { normalizePlan } from '../autonomous/normalize-plan.js';
import { N8nClient } from '../client/n8n-client.js';
import type { NodeDefinition, WorkflowPattern, N8nInstance } from '../types/entities.js';
import type { N8nWorkflow } from '../types/workflow.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AgentConfig {
  store: Store;
  /** Active n8n instance to deploy to */
  instance?: N8nInstance;
}

export interface RecallResult {
  nodes: SearchResult[];
  patterns: SearchResult[];
}

export interface WorkflowPlan {
  name: string;
  description: string;
  /** Selected nodes with their roles */
  steps: WorkflowStep[];
  /** How steps connect */
  connections: StepConnection[];
}

export interface WorkflowStep {
  /** Index in the steps array */
  index: number;
  /** The node definition to use */
  node: NodeDefinition;
  /** Role in the workflow (e.g. "trigger", "process", "output") */
  role: string;
  /** Label override */
  label?: string;
  /** Pre-filled parameters */
  parameters?: Record<string, unknown>;
  /** Credential bindings */
  credentials?: Record<string, { id: string; name: string }>;
}

export interface StepConnection {
  from: number;
  to: number;
  fromOutput?: number;
  toInput?: number;
  type?: string;
}

export interface DeployResult {
  success: boolean;
  workflowId?: string;
  workflowUrl?: string;
  validation: ValidationResult;
  error?: string;
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

export class Orchestrator {
  private store: Store;
  private search: HybridSearchEngine;
  private client: N8nClient | null = null;
  private instance: N8nInstance | null = null;
  private nodeDefMap: Map<string, NodeDefinition> = new Map();
  private cachedCredentials: CredentialBinding[] = [];
  private credentialsCacheTime = 0;

  constructor(config: AgentConfig) {
    this.store = config.store;
    const vectorDir = resolve(this.store.root, 'vectors');
    this.search = new HybridSearchEngine(vectorDir);

    if (config.instance) {
      this.setInstance(config.instance);
    }
  }

  /** Set the active n8n instance */
  setInstance(instance: N8nInstance): void {
    this.instance = instance;
    this.client = new N8nClient({
      baseUrl: instance.baseUrl,
      apiKey: instance.apiKey,
    });
  }

  /** Initialize: load all entities into the search index */
  initialize(): void {
    const nodes = this.store.list<NodeDefinition>('nodeDefinition');
    const patterns = this.store.list<WorkflowPattern>('workflowPattern');

    // Build node definition lookup map
    this.nodeDefMap.clear();
    for (const n of nodes) {
      this.nodeDefMap.set(n.n8nType, n);
    }

    // Index everything for search
    this.search.index([...nodes, ...patterns]);
  }

  /** Get stats about what's loaded */
  stats(): { nodes: number; patterns: number; instances: number } {
    return {
      nodes: this.store.count('nodeDefinition'),
      patterns: this.store.count('workflowPattern'),
      instances: this.store.count('n8nInstance'),
    };
  }

  // ─── Step 1: RECALL ──────────────────────────────────────────────────────

  /** Search for relevant nodes and patterns given a natural language query */
  recall(query: string, limit = 15): RecallResult {
    const results = this.search.search(query, limit * 2);

    return {
      nodes: results.filter(r => r.entity.type === 'nodeDefinition').slice(0, limit),
      patterns: results.filter(r => r.entity.type === 'workflowPattern').slice(0, limit),
    };
  }

  /** Get a node definition by n8n type name */
  getNodeDef(n8nType: string): NodeDefinition | undefined {
    return this.nodeDefMap.get(n8nType);
  }

  /** List all available node categories */
  listCategories(): Map<string, number> {
    const cats = new Map<string, number>();
    for (const [, def] of this.nodeDefMap) {
      cats.set(def.category, (cats.get(def.category) ?? 0) + 1);
    }
    return cats;
  }

  /** List nodes by category */
  listNodesByCategory(category: string): NodeDefinition[] {
    return [...this.nodeDefMap.values()].filter(n => n.category === category);
  }

  // ─── Credentials ─────────────────────────────────────────────────────────

  /**
   * Refresh the cached credentials from the n8n instance.
   * Caches for 60 seconds to avoid hammering the API.
   */
  async refreshCredentials(): Promise<CredentialBinding[]> {
    if (!this.instance) return [];

    const now = Date.now();
    if (now - this.credentialsCacheTime < 60_000 && this.cachedCredentials.length > 0) {
      return this.cachedCredentials;
    }

    this.cachedCredentials = await fetchCredentials(this.instance.baseUrl, this.instance.apiKey);
    this.credentialsCacheTime = now;

    // Also update the instance profile in store if credentials changed
    if (this.cachedCredentials.length > 0) {
      this.instance.availableCredentials = this.cachedCredentials.map(c => ({
        type: c.type,
        name: c.name,
        id: c.id,
      }));
    }

    return this.cachedCredentials;
  }

  /**
   * Auto-bind credentials to a composed workflow.
   * Matches node credential requirements against available instance credentials.
   */
  async bindCredentials(workflow: N8nWorkflow): Promise<CredentialMatchResult> {
    const creds = await this.refreshCredentials();
    return matchCredentials(workflow, this.nodeDefMap, creds);
  }

  // ─── Step 2: COMPOSE ─────────────────────────────────────────────────────

  /** Build a workflow from a plan */
  compose(plan: WorkflowPlan): N8nWorkflow {
    // Normalize plan: fix out-of-bounds connections, orphans, duplicates
    const { plan: normalizedPlan, fixes } = normalizePlan(plan);
    if (fixes.length > 0) {
      plan = normalizedPlan;
    }

    const composerNodes: ComposerNode[] = plan.steps.map(step => ({
      definition: step.node,
      label: step.label,
      parameters: step.parameters,
      credentials: step.credentials,
    }));

    const composerConnections: ComposerConnection[] = plan.connections.map(conn => ({
      from: conn.from,
      to: conn.to,
      fromOutput: conn.fromOutput,
      toInput: conn.toInput,
      type: conn.type,
    }));

    const options: ComposeOptions = {
      name: plan.name,
      nodes: composerNodes,
      connections: composerConnections,
    };

    return composeWorkflow(options);
  }

  // ─── Step 3: VALIDATE ────────────────────────────────────────────────────

  /** Validate a composed workflow */
  validate(workflow: N8nWorkflow): ValidationResult {
    return validateWorkflow(workflow, this.nodeDefMap);
  }

  // ─── Step 4: DEPLOY ──────────────────────────────────────────────────────

  /** Deploy a workflow to the active n8n instance */
  async deploy(workflow: N8nWorkflow, activate = false): Promise<DeployResult> {
    if (!this.client || !this.instance) {
      const validation = this.validate(workflow);
      return {
        success: false,
        validation,
        error: 'No n8n instance configured. Call setInstance() first.',
      };
    }

    // Auto-bind credentials before validation
    const credResult = await this.bindCredentials(workflow);
    const boundWorkflow = credResult.workflow;

    // Validate after credential binding
    const validation = this.validate(boundWorkflow);
    if (!validation.valid) {
      return {
        success: false,
        validation,
        error: `Validation failed with ${validation.errors.length} error(s)`,
      };
    }

    try {
      const created = await this.client.createWorkflow(boundWorkflow);
      const workflowId = created.id!;
      const workflowUrl = `${this.instance.baseUrl}/workflow/${workflowId}`;

      let activationError: string | undefined;
      if (activate) {
        try {
          await this.client.activateWorkflow(workflowId);
        } catch (err) {
          // Workflow was created successfully but activation failed
          // This is still a partial success — the workflow exists in n8n
          activationError = `Workflow created but activation failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      return {
        success: true,
        workflowId,
        workflowUrl,
        validation,
        error: activationError,
      };
    } catch (err) {
      return {
        success: false,
        validation,
        error: `Deploy failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // ─── Step 5: LEARN ───────────────────────────────────────────────────────

  /** Save a successful workflow as a reusable pattern */
  learn(workflow: N8nWorkflow, useCases: string[]): WorkflowPattern {
    const pattern: WorkflowPattern = {
      id: '',
      type: 'workflowPattern',
      createdAt: '',
      updatedAt: '',
      tags: workflow.nodes.map(n => n.type),
      name: workflow.name,
      description: `Auto-learned pattern from workflow "${workflow.name}"`,
      useCases,
      nodes: workflow.nodes.map(n => ({
        n8nType: n.type,
        label: n.name,
        parameters: n.parameters,
        position: n.position,
      })),
      connections: this.flattenConnections(workflow),
      status: 'experimental',
      successCount: 1,
      failCount: 0,
    };

    return this.store.save(pattern);
  }

  private flattenConnections(workflow: N8nWorkflow) {
    const connections: WorkflowPattern['connections'] = [];
    const nameToIndex = new Map(workflow.nodes.map((n, i) => [n.name, i]));

    for (const [sourceName, connTypes] of Object.entries(workflow.connections)) {
      for (const outputs of Object.values(connTypes)) {
        for (let outputIdx = 0; outputIdx < outputs.length; outputIdx++) {
          for (const conn of outputs[outputIdx]) {
            const fromIdx = nameToIndex.get(sourceName);
            const toIdx = nameToIndex.get(conn.node);
            if (fromIdx !== undefined && toIdx !== undefined) {
              connections.push({
                from: { node: sourceName, output: outputIdx },
                to: { node: conn.node, input: conn.index },
              });
            }
          }
        }
      }
    }

    return connections;
  }

  // ─── Convenience: Full Pipeline ──────────────────────────────────────────

  /** Execute the full pipeline: compose → validate → deploy → learn */
  async execute(
    plan: WorkflowPlan,
    options?: { activate?: boolean; learn?: boolean; useCases?: string[] }
  ): Promise<DeployResult & { workflow: N8nWorkflow }> {
    const workflow = this.compose(plan);
    const result = await this.deploy(workflow, options?.activate);

    if (result.success && options?.learn !== false) {
      this.learn(workflow, options?.useCases ?? [plan.description]);
      // Re-index to include the new pattern
      this.initialize();
    }

    return { ...result, workflow };
  }

  // ─── Context Generation (for LLM agents) ────────────────────────────────

  /**
   * Generate a context string for an LLM agent.
   * Given a user query, produces a structured prompt with:
   * - Relevant node definitions (summarized)
   * - Relevant workflow patterns
   * - Available credentials on the instance
   */
  generateContext(query: string): string {
    const recall = this.recall(query, 10);
    const lines: string[] = [];

    lines.push('# Available n8n Nodes (most relevant)\n');
    for (const r of recall.nodes) {
      const n = r.entity as NodeDefinition;
      const params = n.properties
        .filter(p => p.required || p.name === 'resource' || p.name === 'operation')
        .map(p => `  - ${p.displayName} (${p.type}${p.required ? ', required' : ''})`)
        .join('\n');
      const creds = n.credentials.map(c => c.name).join(', ');

      lines.push(`## ${n.displayName} [${n.n8nType}]`);
      lines.push(`Category: ${n.category} | Version: ${n.version.join(',')}`);
      lines.push(`${n.description}`);
      if (params) lines.push(`Key parameters:\n${params}`);
      if (creds) lines.push(`Credentials: ${creds}`);
      lines.push('');
    }

    if (recall.patterns.length > 0) {
      lines.push('\n# Matching Workflow Patterns\n');
      for (const r of recall.patterns) {
        const p = r.entity as WorkflowPattern;
        lines.push(`## ${p.name}`);
        lines.push(`${p.description}`);
        lines.push(`Nodes: ${p.nodes.map(n => n.n8nType).join(' → ')}`);
        lines.push(`Use cases: ${p.useCases.join(', ')}`);
        lines.push('');
      }
    }

    if (this.instance) {
      lines.push('\n# Instance Info\n');
      lines.push(`URL: ${this.instance.baseUrl}`);

      // Use cached credentials (refreshed in real-time during deploy)
      const creds = this.cachedCredentials.length > 0
        ? this.cachedCredentials
        : this.instance.availableCredentials;

      if (creds.length > 0) {
        lines.push('\n## Available Credentials (auto-bound after compose)');
        lines.push('You do NOT need to include credential IDs in the plan.');
        lines.push('The system auto-matches credentials by type. Just use the correct node types.\n');
        // Group by type for clarity
        const byType = new Map<string, string[]>();
        for (const c of creds) {
          if (!byType.has(c.type)) byType.set(c.type, []);
          byType.get(c.type)!.push(c.name);
        }
        for (const [type, names] of byType) {
          lines.push(`  - ${type}: ${names.join(', ')}`);
        }
      } else {
        lines.push('No credentials configured. Workflows that need credentials will need manual setup after deploy.');
      }
    }

    return lines.join('\n');
  }
}
