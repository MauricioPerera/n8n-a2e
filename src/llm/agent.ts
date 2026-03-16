/**
 * Conversational Workflow Agent
 *
 * Closes the loop: user speaks → LLM generates plan → orchestrator composes → deploys.
 * Maintains conversation state for iterative refinement.
 */

import type { LlmProvider, LlmMessage } from './provider.js';
import { buildCompositionPrompt, REFINE_PROMPT, ERROR_RECOVERY_PROMPT } from './prompts.js';
import { Orchestrator, type WorkflowPlan, type WorkflowStep, type StepConnection, type DeployResult } from '../agent/orchestrator.js';
import { CircuitBreaker } from '../autonomous/circuit-breaker.js';
import type { NodeDefinition } from '../types/entities.js';
import type { Store } from '../storage/store.js';
import type { N8nWorkflow } from '../types/workflow.js';
import { normalizeResponse } from '../autonomous/normalize.js';

export interface AgentSession {
  history: { role: 'user' | 'assistant'; content: string }[];
  lastPlan: WorkflowPlan | null;
  lastWorkflow: N8nWorkflow | null;
  lastDeployResult: DeployResult | null;
}

export interface AgentResponse {
  message: string;
  plan?: WorkflowPlan;
  workflow?: N8nWorkflow;
  deployResult?: DeployResult;
  action: 'plan' | 'deploy' | 'error' | 'chat';
}

export class WorkflowAgent {
  private llm: LlmProvider;
  private orchestrator: Orchestrator;
  private circuitBreaker: CircuitBreaker | null;
  private session: AgentSession;

  constructor(llm: LlmProvider, orchestrator: Orchestrator, store?: Store) {
    this.llm = llm;
    this.orchestrator = orchestrator;
    this.circuitBreaker = store ? new CircuitBreaker(store) : null;
    this.session = {
      history: [],
      lastPlan: null,
      lastWorkflow: null,
      lastDeployResult: null,
    };
  }

  /** Reset conversation state */
  reset(): void {
    this.session = {
      history: [],
      lastPlan: null,
      lastWorkflow: null,
      lastDeployResult: null,
    };
  }

  /** Process a user message and return the agent's response */
  async chat(userMessage: string): Promise<AgentResponse> {
    const lower = userMessage.toLowerCase().trim();

    // Command shortcuts
    if (lower === '/deploy' || lower === 'deploy' || lower === 'despliega') {
      return this.handleDeploy();
    }
    if (lower === '/activate' || lower === 'activate' || lower === 'activa') {
      return this.handleActivate();
    }
    if (lower === '/reset' || lower === 'reset') {
      this.reset();
      return { message: 'Session reset. Describe the workflow you want to create.', action: 'chat' };
    }
    if (lower === '/json' || lower === 'json' || lower === 'show json') {
      return this.handleShowJson();
    }

    // Generate or refine a workflow plan
    return this.handleCompose(userMessage);
  }

  private async handleCompose(userMessage: string): Promise<AgentResponse> {
    // Generate context from the orchestrator
    let context = this.orchestrator.generateContext(userMessage);

    // Inject anti-patterns from circuit breaker (feedback loop)
    if (this.circuitBreaker) {
      const antiPatterns = this.circuitBreaker.getAntiPatterns(5);
      if (antiPatterns.length > 0) {
        context += '\n\n## Known Issues (avoid these mistakes)\n';
        for (const ap of antiPatterns) {
          context += `- ${ap.target}: ${ap.error}`;
          if (ap.resolution) context += ` → Fix: ${ap.resolution}`;
          context += '\n';
        }
      }
    }

    // Build messages for the LLM
    const isRefining = this.session.lastPlan !== null;
    let messages: LlmMessage[];

    if (isRefining) {
      messages = buildCompositionPrompt(
        `${REFINE_PROMPT}\n\nCurrent plan:\n\`\`\`json\n${JSON.stringify(this.session.lastPlan, null, 2)}\n\`\`\`\n\nUser request: ${userMessage}`,
        context,
        this.session.history
      );
    } else {
      messages = buildCompositionPrompt(userMessage, context, this.session.history);
    }

    try {
      const response = await this.llm.chat(messages, {
        temperature: 0.3,
        maxTokens: 4096,
      });

      // Parse the plan from the response
      const plan = this.parsePlanFromResponse(response.content);

      if (plan) {
        this.session.lastPlan = plan;

        // Compose the workflow and auto-bind credentials
        const rawWorkflow = this.orchestrator.compose(plan);
        const credResult = await this.orchestrator.bindCredentials(rawWorkflow);
        const workflow = credResult.workflow;
        this.session.lastWorkflow = workflow;

        const validation = this.orchestrator.validate(workflow);

        // Update history
        this.session.history.push({ role: 'user', content: userMessage });
        this.session.history.push({ role: 'assistant', content: response.content });

        const warnings = validation.warnings.map(w => `  - ${w.message}`).join('\n');
        const errors = validation.errors.map(e => `  - ${e.message}`).join('\n');

        let statusMsg = `**${plan.name}**\n${plan.description}\n\n`;
        statusMsg += `Nodes: ${plan.steps.map(s => s.label || s.node.displayName).join(' → ')}\n\n`;

        // Credential binding info
        if (credResult.bound.length > 0) {
          statusMsg += `Credentials auto-bound: ${credResult.bound.map(b => `${b.credentialName} → ${b.node}`).join(', ')}\n`;
        }
        if (credResult.missing.length > 0) {
          statusMsg += `Missing credentials: ${credResult.missing.map(m => `${m.credentialType} for ${m.node}`).join(', ')}\n`;
        }

        if (validation.valid) {
          statusMsg += `\nValidation: OK`;
          if (warnings) statusMsg += `\nWarnings:\n${warnings}`;
          statusMsg += `\n\nType "deploy" to push to n8n, or describe changes to refine.`;
        } else {
          statusMsg += `\nValidation FAILED:\n${errors}`;
          if (warnings) statusMsg += `\nWarnings:\n${warnings}`;
          statusMsg += `\n\nDescribe changes to fix, or type "json" to see the raw workflow.`;
        }

        return {
          message: statusMsg,
          plan,
          workflow,
          action: 'plan',
        };
      } else {
        // LLM responded without a plan (conversational)
        this.session.history.push({ role: 'user', content: userMessage });
        this.session.history.push({ role: 'assistant', content: response.content });

        return {
          message: response.content,
          action: 'chat',
        };
      }
    } catch (err) {
      return {
        message: `LLM error: ${err instanceof Error ? err.message : String(err)}`,
        action: 'error',
      };
    }
  }

  private async handleDeploy(): Promise<AgentResponse> {
    if (!this.session.lastWorkflow) {
      return { message: 'No workflow to deploy. Describe what you want first.', action: 'error' };
    }

    const result = await this.orchestrator.deploy(this.session.lastWorkflow);
    this.session.lastDeployResult = result;

    if (result.success) {
      // Learn from success + reset circuit breaker for used types
      if (this.session.lastPlan) {
        this.orchestrator.learn(
          this.session.lastWorkflow,
          [this.session.lastPlan.description]
        );
        if (this.circuitBreaker) {
          for (const s of this.session.lastPlan.steps) {
            this.circuitBreaker.recordSuccess(s.node.n8nType);
          }
        }
      }

      return {
        message: `Deployed successfully!\n  ID: ${result.workflowId}\n  URL: ${result.workflowUrl}\n\nType "activate" to enable it, or "reset" for a new workflow.`,
        deployResult: result,
        workflow: this.session.lastWorkflow,
        action: 'deploy',
      };
    } else {
      // Record deploy failure in circuit breaker
      if (this.circuitBreaker && this.session.lastWorkflow) {
        for (const node of this.session.lastWorkflow.nodes) {
          this.circuitBreaker.recordError(node.type, `Deploy: ${result.error ?? 'unknown'}`);
        }
      }
      return {
        message: `Deploy failed: ${result.error}\n\nDescribe changes to fix the issues.`,
        deployResult: result,
        action: 'error',
      };
    }
  }

  private async handleActivate(): Promise<AgentResponse> {
    if (!this.session.lastDeployResult?.workflowId) {
      return { message: 'No deployed workflow to activate.', action: 'error' };
    }

    try {
      const client = (this.orchestrator as unknown as { client: { activateWorkflow: (id: string) => Promise<unknown> } }).client;
      if (!client) {
        return { message: 'No n8n instance configured.', action: 'error' };
      }
      await client.activateWorkflow(this.session.lastDeployResult.workflowId);
      return {
        message: `Workflow ${this.session.lastDeployResult.workflowId} activated!`,
        action: 'deploy',
      };
    } catch (err) {
      return {
        message: `Activation failed: ${err instanceof Error ? err.message : String(err)}`,
        action: 'error',
      };
    }
  }

  private handleShowJson(): AgentResponse {
    if (!this.session.lastWorkflow) {
      return { message: 'No workflow composed yet.', action: 'error' };
    }
    return {
      message: '```json\n' + JSON.stringify(this.session.lastWorkflow, null, 2) + '\n```',
      workflow: this.session.lastWorkflow,
      action: 'chat',
    };
  }

  /** Extract a WorkflowPlan JSON from the LLM's markdown-wrapped response */
  private parsePlanFromResponse(response: string): WorkflowPlan | null {
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

      // Resolve steps: look up NodeDefinitions
      const steps: WorkflowStep[] = raw.steps.map((s, i) => {
        const nodeDef = this.orchestrator.getNodeDef(s.n8nType);
        if (!nodeDef) {
          // Create a minimal placeholder definition
          const placeholder: NodeDefinition = {
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
            node: placeholder,
            role: s.role,
            label: s.label,
            parameters: s.parameters,
            credentials: s.credentials,
          };
        }
        return {
          index: i,
          node: nodeDef,
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

      return {
        name: raw.name,
        description: raw.description,
        steps,
        connections,
      };
    } catch {
      return null;
    }
  }
}
