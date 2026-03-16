/**
 * Autonomous Workflow Agent
 *
 * The brain of n8n-a2e's autonomous mode. Unlike the interactive WorkflowAgent
 * that requires human confirmation at each step, this agent:
 *
 * 1. Receives a goal in natural language
 * 2. Decides what workflow(s) to create
 * 3. Composes, validates, deploys — with auto-retry and error recovery
 * 4. Learns from successes and failures
 * 5. Uses circuit breakers to avoid repeated failures
 *
 * Inspired by RepoMemory v2's autonomous mining + A2E protocol.
 */

import type { LlmProvider, LlmMessage } from '../llm/provider.js';
import { Orchestrator, type WorkflowPlan, type WorkflowStep, type StepConnection, type DeployResult } from '../agent/orchestrator.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { saveWorkflowSkill, saveWorkflowError, recallWorkflowSkills, saveExecutionFix } from './workflow-skills.js';
import { sanitizeSecrets } from './sanitize.js';
import { normalizeResponse } from './normalize.js';
import type { Store } from '../storage/store.js';
import type { NodeDefinition, ExecutionContext } from '../types/entities.js';
import type { N8nWorkflow } from '../types/workflow.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AutonomousConfig {
  store: Store;
  orchestrator: Orchestrator;
  llm: LlmProvider;
  /** Max retries per workflow attempt */
  maxRetries?: number;
  /** Circuit breaker error threshold */
  circuitBreakerThreshold?: number;
  /** Known secrets to sanitize from learned patterns */
  secrets?: Map<string, string>;
  /** Auto-activate deployed workflows */
  autoActivate?: boolean;
  /** Callback for status updates */
  onStatus?: (event: AgentEvent) => void;
}

export interface AgentEvent {
  phase: 'plan' | 'compose' | 'validate' | 'deploy' | 'learn' | 'error' | 'retry' | 'circuit-break' | 'done';
  message: string;
  data?: unknown;
}

export interface AutonomousResult {
  success: boolean;
  workflow?: N8nWorkflow;
  deployResult?: DeployResult;
  plan?: WorkflowPlan | null;
  events: AgentEvent[];
  retries: number;
  error?: string;
}

// ─── Prompts ─────────────────────────────────────────────────────────────────

const AUTONOMOUS_SYSTEM_PROMPT = `You are an autonomous n8n workflow composer. You receive a goal and produce a complete workflow plan as JSON.

## Critical Rules
1. You MUST respond with ONLY a JSON object wrapped in \`\`\`json code fences. No explanations.
2. Every workflow MUST start with a trigger node.
3. Use ONLY node types from the provided context.
4. Set parameters you are confident about. The system uses defaults for the rest.
5. For IF nodes: output 0 = true, output 1 = false. Use "fromOutput" in connections.
6. For AI tool connections use "type": "ai_tool" in connections.
7. Be precise and minimal. Do not over-engineer.

## JSON Schema
\`\`\`json
{
  "name": "Workflow Name",
  "description": "What it does",
  "steps": [
    { "index": 0, "n8nType": "n8n-nodes-base.manualTrigger", "role": "trigger", "label": "Start", "parameters": {} }
  ],
  "connections": [
    { "from": 0, "to": 1 }
  ]
}
\`\`\``;

const FIX_PROMPT = `The workflow had validation errors. Fix the plan and return corrected JSON only.

Errors:
`;

// ─── Autonomous Agent ────────────────────────────────────────────────────────

export class AutonomousAgent {
  private store: Store;
  private orchestrator: Orchestrator;
  private llm: LlmProvider;
  private circuitBreaker: CircuitBreaker;
  private maxRetries: number;
  private secrets: Map<string, string>;
  private autoActivate: boolean;
  private onStatus: (event: AgentEvent) => void;

  constructor(config: AutonomousConfig) {
    this.store = config.store;
    this.orchestrator = config.orchestrator;
    this.llm = config.llm;
    this.circuitBreaker = new CircuitBreaker(config.store, config.circuitBreakerThreshold ?? 3);
    this.maxRetries = config.maxRetries ?? 2;
    this.secrets = config.secrets ?? new Map();
    this.autoActivate = config.autoActivate ?? false;
    this.onStatus = config.onStatus ?? (() => {});
  }

  /**
   * Execute a goal autonomously.
   * Returns the result of the entire pipeline.
   */
  async execute(goal: string): Promise<AutonomousResult> {
    const events: AgentEvent[] = [];
    const emit = (event: AgentEvent) => {
      events.push(event);
      this.onStatus(event);
    };

    let lastPlan: WorkflowPlan | null = null;
    let lastWorkflow: N8nWorkflow | null = null;
    let retries = 0;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        // ── Step 1: PLAN ──────────────────────────────────────────────
        emit({ phase: 'plan', message: `Planning workflow for: "${goal}"${attempt > 0 ? ` (retry ${attempt})` : ''}` });

        const plan: WorkflowPlan | null = attempt === 0
          ? await this.generatePlan(goal)
          : await this.fixPlan(goal, lastPlan!, events[events.length - 1]?.message ?? '');

        if (!plan) {
          emit({ phase: 'error', message: 'LLM did not return a valid plan.' });
          if (attempt < this.maxRetries) {
            retries++;
            emit({ phase: 'retry', message: `Retrying (${retries}/${this.maxRetries})...` });
            continue;
          }
          return { success: false, events, retries, error: 'Failed to generate plan' };
        }

        lastPlan = plan;
        emit({ phase: 'plan', message: `Plan: "${plan.name}" with ${plan.steps.length} nodes`, data: plan });

        // ── Circuit Breaker Check ─────────────────────────────────────
        const n8nTypes = plan.steps.map((s: WorkflowStep) => s.node.n8nType);
        const blocked = this.circuitBreaker.checkPlan(n8nTypes);
        if (blocked.length > 0) {
          const blockedNames = blocked.map(b => b.target).join(', ');
          emit({ phase: 'circuit-break', message: `Blocked nodes: ${blockedNames}. Requesting alternatives.` });

          // Ask LLM for alternatives
          const altPlan = await this.requestAlternatives(goal, plan, blocked.map(b => b.target));
          if (altPlan) {
            lastPlan = altPlan;
            emit({ phase: 'plan', message: `Alternative plan: "${altPlan.name}"`, data: altPlan });
          } else {
            return { success: false, plan, events, retries, error: `Blocked by circuit breaker: ${blockedNames}` };
          }
        }

        // ── Step 2: COMPOSE ───────────────────────────────────────────
        emit({ phase: 'compose', message: 'Composing workflow JSON...' });
        const rawWorkflow = this.orchestrator.compose(lastPlan!);

        // ── Step 2.5: BIND CREDENTIALS ──────────────────────────────
        const credResult = await this.orchestrator.bindCredentials(rawWorkflow);
        const workflow = credResult.workflow;
        lastWorkflow = workflow;

        if (credResult.bound.length > 0) {
          const boundNames = credResult.bound.map(b => `${b.node}→${b.credentialName}`).join(', ');
          emit({ phase: 'compose', message: `Auto-bound credentials: ${boundNames}` });
        }
        if (credResult.missing.length > 0) {
          const missingNames = credResult.missing.map(m => `${m.node}:${m.credentialType}`).join(', ');
          emit({ phase: 'validate', message: `Missing credentials (manual setup needed): ${missingNames}` });
        }

        // ── Step 3: VALIDATE ──────────────────────────────────────────
        emit({ phase: 'validate', message: 'Validating...' });
        const validation = this.orchestrator.validate(workflow);

        if (!validation.valid) {
          const errorMsg = validation.errors.map(e => e.message).join('; ');
          emit({ phase: 'error', message: `Validation failed: ${errorMsg}` });

          // Learn from validation errors — record anti-patterns per node type
          for (const ve of validation.errors) {
            // Resolve node name → n8nType from the workflow
            const wfNode = ve.node ? workflow.nodes.find(n => n.name === ve.node) : undefined;
            const nodeType = wfNode?.type ?? ve.node ?? 'unknown';
            this.circuitBreaker.recordError(nodeType, `Validation: ${ve.message}`);
          }

          if (attempt < this.maxRetries) {
            retries++;
            emit({ phase: 'retry', message: `Retrying with fixes (${retries}/${this.maxRetries})...` });
            continue;
          }
          return { success: false, workflow, plan: lastPlan, events, retries, error: errorMsg };
        }

        if (validation.warnings.length > 0) {
          emit({ phase: 'validate', message: `Warnings: ${validation.warnings.map(w => w.message).join('; ')}` });
        }

        // ── Step 4: DEPLOY ────────────────────────────────────────────
        emit({ phase: 'deploy', message: 'Deploying to n8n...' });
        const deployResult = await this.orchestrator.deploy(workflow, this.autoActivate);

        if (!deployResult.success) {
          emit({ phase: 'error', message: `Deploy failed: ${deployResult.error}` });

          // Record errors for circuit breaker
          saveWorkflowError(this.store, n8nTypes, goal, deployResult.error ?? 'Deploy failed');
          for (const t of n8nTypes) this.circuitBreaker.recordError(t, deployResult.error ?? '');

          if (attempt < this.maxRetries) {
            retries++;
            emit({ phase: 'retry', message: `Retrying (${retries}/${this.maxRetries})...` });
            continue;
          }
          return { success: false, workflow, deployResult, plan: lastPlan, events, retries, error: deployResult.error };
        }

        // ── Step 5: LEARN ─────────────────────────────────────────────
        emit({ phase: 'learn', message: `Deployed! ID: ${deployResult.workflowId}. Learning pattern...` });

        saveWorkflowSkill(this.store, workflow, goal, [goal], this.secrets);
        for (const t of n8nTypes) this.circuitBreaker.recordSuccess(t);

        // Re-index
        this.orchestrator.initialize();

        emit({
          phase: 'done',
          message: `Workflow "${lastPlan!.name}" deployed and active at ${deployResult.workflowUrl}`,
          data: { workflowId: deployResult.workflowId, workflowUrl: deployResult.workflowUrl },
        });

        return {
          success: true,
          workflow,
          deployResult,
          plan: lastPlan,
          events,
          retries,
        };

      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        emit({ phase: 'error', message: `Unexpected error: ${msg}` });
        if (attempt < this.maxRetries) {
          retries++;
          emit({ phase: 'retry', message: `Retrying (${retries}/${this.maxRetries})...` });
          continue;
        }
        return { success: false, events, retries, error: msg };
      }
    }

    return { success: false, events, retries, error: 'Max retries exceeded' };
  }

  /**
   * Execute multiple goals in sequence, learning from each.
   */
  async executeBatch(goals: string[]): Promise<AutonomousResult[]> {
    const results: AutonomousResult[] = [];
    for (const goal of goals) {
      results.push(await this.execute(goal));
    }
    return results;
  }

  // ─── LLM Interactions ──────────────────────────────────────────────────────

  private async generatePlan(goal: string): Promise<WorkflowPlan | null> {
    const context = this.orchestrator.generateContext(goal);

    // Include previously learned patterns as few-shot examples
    const learnedPatterns = recallWorkflowSkills(this.store, goal, 3);
    let fewShot = '';
    if (learnedPatterns.length > 0) {
      fewShot = '\n\n## Previously Successful Patterns\n';
      for (const p of learnedPatterns) {
        fewShot += `- "${p.name}": ${p.nodes.map(n => n.n8nType).join(' → ')}\n`;
      }
    }

    // Include anti-patterns from circuit breaker (deduplicated, enriched)
    const antiPatterns = this.circuitBreaker.getAntiPatterns(10);
    let errorContext = '';
    if (antiPatterns.length > 0) {
      errorContext = '\n\n## Known Issues (avoid these mistakes)\n';
      for (const ap of antiPatterns) {
        errorContext += `- ${ap.target}: ${ap.error}`;
        if (ap.resolution) errorContext += ` → Fix: ${ap.resolution}`;
        errorContext += '\n';
      }
    }

    const messages: LlmMessage[] = [
      { role: 'system', content: AUTONOMOUS_SYSTEM_PROMPT },
      { role: 'user', content: `${context}${fewShot}${errorContext}\n\n## Goal\n${goal}` },
    ];

    // Try with inline retry on parse failure
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await this.llm.chat(messages, { temperature: 0.2, maxTokens: 4096 });
      const plan = this.parsePlan(response.content);
      if (plan) return plan;

      // Feed error back for retry
      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: 'ERROR: Your response was not valid JSON with fields name, steps[], connections[]. Respond with ONLY a ```json code block containing the workflow plan.' });
    }
    return null;
  }

  private async fixPlan(goal: string, failedPlan: WorkflowPlan, errors: string): Promise<WorkflowPlan | null> {
    const context = this.orchestrator.generateContext(goal);
    const messages: LlmMessage[] = [
      { role: 'system', content: AUTONOMOUS_SYSTEM_PROMPT },
      { role: 'user', content: context },
      { role: 'assistant', content: '```json\n' + JSON.stringify(planToRaw(failedPlan), null, 2) + '\n```' },
      { role: 'user', content: `${FIX_PROMPT}${errors}\n\nFix and return corrected JSON only.` },
    ];

    const response = await this.llm.chat(messages, { temperature: 0.1, maxTokens: 4096 });
    return this.parsePlan(response.content);
  }

  private async requestAlternatives(goal: string, plan: WorkflowPlan, blockedTypes: string[]): Promise<WorkflowPlan | null> {
    const context = this.orchestrator.generateContext(goal);

    // Build detailed block reasons from circuit breaker
    const blockDetails = blockedTypes.map(t => {
      const result = this.circuitBreaker.check(t);
      let detail = `- ${t}: ${result.message}`;
      if (result.resolutions.length > 0) {
        detail += `\n  Known fixes: ${result.resolutions.join('; ')}`;
      }
      return detail;
    }).join('\n');

    const messages: LlmMessage[] = [
      { role: 'system', content: AUTONOMOUS_SYSTEM_PROMPT },
      { role: 'user', content: `${context}\n\n## Goal\n${goal}\n\n## BLOCKED NODE TYPES (do NOT use these)\n${blockDetails}\n\nFind alternative nodes to achieve the same goal. Or if a known fix exists, apply it.` },
    ];

    const response = await this.llm.chat(messages, { temperature: 0.3, maxTokens: 4096 });
    return this.parsePlan(response.content);
  }

  // ─── Plan Parsing ──────────────────────────────────────────────────────────

  private parsePlan(response: string): WorkflowPlan | null {
    // Use normalizeResponse to handle LLM output quirks
    const normalized = normalizeResponse(response);
    const jsonStr = normalized.json;
    if (!jsonStr) return null;

    try {
      const raw = JSON.parse(jsonStr) as {
        name: string;
        description: string;
        steps: {
          index: number;
          n8nType: string;
          role: string;
          label?: string;
          parameters?: Record<string, unknown>;
          credentials?: Record<string, { id: string; name: string }>;
        }[];
        connections: {
          from: number;
          to: number;
          fromOutput?: number;
          toInput?: number;
          type?: string;
        }[];
      };

      const steps: WorkflowStep[] = raw.steps.map((s, i) => {
        const nodeDef = this.orchestrator.getNodeDef(s.n8nType);
        const node: NodeDefinition = nodeDef ?? {
          id: s.n8nType,
          type: 'nodeDefinition',
          createdAt: '',
          updatedAt: '',
          tags: [],
          n8nType: s.n8nType,
          displayName: s.label || s.n8nType.split('.').pop() || s.n8nType,
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

        return {
          index: i,
          node,
          role: s.role,
          label: s.label,
          parameters: s.parameters,
          credentials: s.credentials,
        };
      });

      const connections: StepConnection[] = raw.connections.map(c => ({
        from: c.from,
        to: c.to,
        fromOutput: c.fromOutput,
        toInput: c.toInput,
        type: c.type,
      }));

      return { name: raw.name, description: raw.description, steps, connections };
    } catch {
      return null;
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function planToRaw(plan: WorkflowPlan) {
  return {
    name: plan.name,
    description: plan.description,
    steps: plan.steps.map((s, i) => ({
      index: i,
      n8nType: s.node.n8nType,
      role: s.role,
      label: s.label,
      parameters: s.parameters,
    })),
    connections: plan.connections,
  };
}
