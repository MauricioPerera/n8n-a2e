/**
 * Model Evaluator
 *
 * Runs a set of test goals against different LLM providers and produces
 * a structured comparison. Measures:
 * - Plan generation success
 * - JSON validity (normalize fixes needed)
 * - Validation pass rate
 * - Deploy success rate
 * - Latency and token usage
 * - Retry count
 */

import type { LlmProvider, LlmMessage, LlmResponse } from '../llm/provider.js';
import { createProvider, type ProviderType } from '../llm/provider.js';
import { Orchestrator, type WorkflowPlan } from '../agent/orchestrator.js';
import { CircuitBreaker } from '../autonomous/circuit-breaker.js';
import { normalizeResponse } from '../autonomous/normalize.js';
import type { Store } from '../storage/store.js';
import type { N8nInstance } from '../types/entities.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface EvalGoal {
  /** Natural language goal */
  goal: string;
  /** Expected minimum node count (optional) */
  minNodes?: number;
  /** Expected node types that should appear (optional) */
  expectedTypes?: string[];
  /** Tags for grouping results */
  tags?: string[];
}

export interface EvalModelConfig {
  /** Display name for this model configuration */
  name: string;
  /** LLM provider type */
  provider: ProviderType;
  /** Provider config (apiKey, model, etc.) */
  config: Record<string, unknown>;
}

export interface EvalRunResult {
  model: string;
  goal: string;
  /** Did it produce valid JSON? */
  jsonValid: boolean;
  /** Fixes applied by normalizeResponse */
  normalizeFixes: string[];
  /** Did it produce a parseable WorkflowPlan? */
  planValid: boolean;
  /** Number of nodes in the plan */
  nodeCount: number;
  /** Node types in the plan */
  nodeTypes: string[];
  /** Did validation pass? */
  validationPassed: boolean;
  /** Validation errors */
  validationErrors: string[];
  /** Validation warnings */
  validationWarnings: string[];
  /** Would deploy succeed? (dry run) */
  deployReady: boolean;
  /** Credential binding results */
  credentialsBound: number;
  credentialsMissing: number;
  /** Latency in ms */
  latencyMs: number;
  /** Token usage */
  inputTokens: number;
  outputTokens: number;
  /** Raw LLM response (for debugging) */
  rawResponse?: string;
  /** Error message if failed */
  error?: string;
}

export interface EvalSummary {
  model: string;
  totalGoals: number;
  jsonValidRate: number;
  planValidRate: number;
  validationPassRate: number;
  deployReadyRate: number;
  avgLatencyMs: number;
  avgInputTokens: number;
  avgOutputTokens: number;
  avgNodeCount: number;
  totalNormalizeFixes: number;
}

export interface EvalReport {
  timestamp: string;
  goals: EvalGoal[];
  models: EvalModelConfig[];
  results: EvalRunResult[];
  summaries: EvalSummary[];
}

// ─── System Prompt (same as autonomous agent) ────────────────────────────────

const EVAL_SYSTEM_PROMPT = `You are an autonomous n8n workflow composer. You receive a goal and produce a complete workflow plan as JSON.

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

// ─── Evaluator ───────────────────────────────────────────────────────────────

export class ModelEvaluator {
  private store: Store;
  private orchestrator: Orchestrator;
  private instance: N8nInstance | null;

  constructor(store: Store, orchestrator: Orchestrator, instance?: N8nInstance) {
    this.store = store;
    this.orchestrator = orchestrator;
    this.instance = instance ?? null;
  }

  /**
   * Run a single goal against a single model.
   * Includes inline retry: if the LLM response fails parsing, feeds the error
   * back and asks for a corrected response (up to maxRetries attempts).
   * @param antiPatternContext Optional context string with known issues to inject
   * @param maxRetries Max inline retries on parse/compose failure (default 1)
   */
  async runOne(goal: EvalGoal, modelConfig: EvalModelConfig, antiPatternContext?: string, maxRetries = 1): Promise<EvalRunResult> {
    const result: EvalRunResult = {
      model: modelConfig.name,
      goal: goal.goal,
      jsonValid: false,
      normalizeFixes: [],
      planValid: false,
      nodeCount: 0,
      nodeTypes: [],
      validationPassed: false,
      validationErrors: [],
      validationWarnings: [],
      deployReady: false,
      credentialsBound: 0,
      credentialsMissing: 0,
      latencyMs: 0,
      inputTokens: 0,
      outputTokens: 0,
    };

    try {
      // Create provider
      const llm = createProvider(modelConfig.provider, modelConfig.config);

      // Generate context
      const context = this.orchestrator.generateContext(goal.goal);
      const feedbackSection = antiPatternContext ? `\n\n${antiPatternContext}` : '';

      // Detect Qwen models — they enable "thinking" by default, which wastes tokens.
      // Append /no_think to disable reasoning mode.
      const modelId = String(modelConfig.config.model ?? '').toLowerCase();
      const isQwen = modelId.includes('qwen') || modelConfig.name.toLowerCase().includes('qwen');
      const noThinkSuffix = isQwen ? '\n\n/no_think' : '';

      // Build conversation messages (supports multi-turn retry)
      const messages: LlmMessage[] = [
        { role: 'system', content: EVAL_SYSTEM_PROMPT },
        { role: 'user', content: `${context}${feedbackSection}\n\n## Goal\n${goal.goal}${noThinkSuffix}` },
      ];

      let totalLatency = 0;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        // Call LLM
        const start = Date.now();
        const response = await llm.chat(messages, { temperature: 0.2, maxTokens: 4096 });
        totalLatency += Date.now() - start;
        result.latencyMs = totalLatency;
        result.inputTokens += response.usage?.inputTokens ?? 0;
        result.outputTokens += response.usage?.outputTokens ?? 0;
        result.rawResponse = response.content;

        // Step 1: Normalize
        const normalized = normalizeResponse(response.content);
        result.normalizeFixes = normalized.fixes;
        result.jsonValid = normalized.json !== null;

        if (!normalized.json) {
          const errMsg = 'Failed to extract valid JSON from response';
          if (attempt < maxRetries) {
            // Feed error back for retry
            messages.push({ role: 'assistant', content: response.content });
            messages.push({ role: 'user', content: `ERROR: ${errMsg}. Your response must be ONLY a JSON object wrapped in \`\`\`json code fences with fields: name, description, steps[], connections[]. Try again.` });
            continue;
          }
          result.error = errMsg;
          return result;
        }

        // Step 2: Parse plan
        type RawPlan = {
          name: string;
          description: string;
          steps: { index: number; n8nType: string; role: string; label?: string; parameters?: Record<string, unknown> }[];
          connections: { from: number; to: number; fromOutput?: number; toInput?: number; type?: string }[];
        };
        let raw: RawPlan;

        try {
          raw = JSON.parse(normalized.json);
        } catch {
          const errMsg = 'JSON parsed by normalizer but failed second parse';
          if (attempt < maxRetries) {
            messages.push({ role: 'assistant', content: response.content });
            messages.push({ role: 'user', content: `ERROR: ${errMsg}. Return valid JSON only.` });
            continue;
          }
          result.error = errMsg;
          return result;
        }

        if (!raw.name || !raw.steps || !raw.connections) {
          const missing = [!raw.name && 'name', !raw.steps && 'steps', !raw.connections && 'connections'].filter(Boolean).join(', ');
          const errMsg = `JSON missing required fields: ${missing}`;
          if (attempt < maxRetries) {
            messages.push({ role: 'assistant', content: response.content });
            messages.push({ role: 'user', content: `ERROR: ${errMsg}. The JSON must have "name" (string), "steps" (array of {index, n8nType, role, label, parameters}), and "connections" (array of {from, to}). Try again with the correct structure.` });
            continue;
          }
          result.error = `JSON missing required fields (${missing})`;
          return result;
        }

        result.planValid = true;
        result.nodeCount = raw.steps.length;
        result.nodeTypes = raw.steps.map(s => s.n8nType);

        // Step 3: Build WorkflowPlan and compose
        const plan = this.buildPlan(raw);
        let workflow;
        try {
          workflow = this.orchestrator.compose(plan);
        } catch (composeErr) {
          const errMsg = composeErr instanceof Error ? composeErr.message : String(composeErr);
          if (attempt < maxRetries) {
            messages.push({ role: 'assistant', content: response.content });
            messages.push({ role: 'user', content: `ERROR: Compose failed: ${errMsg}. Check that all connection indices reference valid step indices (0 to ${raw.steps.length - 1}). Fix and return corrected JSON.` });
            continue;
          }
          result.error = `Compose error: ${errMsg}`;
          return result;
        }

        // Step 4: Bind credentials
        try {
          const credResult = await this.orchestrator.bindCredentials(workflow);
          workflow = credResult.workflow;
          result.credentialsBound = credResult.bound.length;
          result.credentialsMissing = credResult.missing.length;
        } catch {
          // Credential binding is best-effort
        }

        // Step 5: Validate
        const validation = this.orchestrator.validate(workflow);
        result.validationPassed = validation.valid;
        result.validationErrors = validation.errors.map(e => e.message);
        result.validationWarnings = validation.warnings.map(w => w.message);

        // Deploy-ready = valid plan + validation passed
        result.deployReady = validation.valid;

        // Success — no need to retry
        return result;
      }

    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
    }

    return result;
  }

  /**
   * Run all goals against all models.
   */
  async runAll(
    goals: EvalGoal[],
    models: EvalModelConfig[],
    onProgress?: (done: number, total: number, result: EvalRunResult) => void
  ): Promise<EvalReport> {
    const results: EvalRunResult[] = [];
    const total = goals.length * models.length;
    let done = 0;

    for (const model of models) {
      for (const goal of goals) {
        const result = await this.runOne(goal, model);
        results.push(result);
        done++;
        onProgress?.(done, total, result);
      }
    }

    const summaries = this.summarize(results, models);

    return {
      timestamp: new Date().toISOString(),
      goals,
      models,
      results,
      summaries,
    };
  }

  /**
   * Run 2 rounds: baseline (no feedback) then with anti-pattern feedback from round 1.
   * This measures whether models learn from error context.
   */
  async runWithFeedback(
    goals: EvalGoal[],
    models: EvalModelConfig[],
    onProgress?: (done: number, total: number, result: EvalRunResult) => void
  ): Promise<{ baseline: EvalReport; withFeedback: EvalReport }> {
    // Round 1: Baseline (no feedback)
    const baselineResults: EvalRunResult[] = [];
    const total = goals.length * models.length * 2;
    let done = 0;

    for (const model of models) {
      for (const goal of goals) {
        const result = await this.runOne(goal, model);
        baselineResults.push(result);
        done++;
        onProgress?.(done, total, result);
      }
    }

    // Build anti-pattern context per model from round 1 failures
    const feedbackPerModel = new Map<string, string>();
    for (const model of models) {
      const modelResults = baselineResults.filter(r => r.model === model.name);
      const failures = modelResults.filter(r => !r.deployReady);

      if (failures.length === 0) {
        feedbackPerModel.set(model.name, '');
        continue;
      }

      let ctx = '## Known Issues (avoid these mistakes from previous attempts)\n';
      for (const f of failures) {
        if (f.validationErrors.length > 0) {
          ctx += `- Goal "${f.goal.slice(0, 60)}": ${f.validationErrors.join('; ')}\n`;
        }
        if (f.error) {
          ctx += `- Goal "${f.goal.slice(0, 60)}": ${f.error}\n`;
        }
        // Mention wrong node types if used
        for (const nt of f.nodeTypes) {
          if (!this.orchestrator.getNodeDef(nt)) {
            ctx += `- "${nt}" is NOT a valid node type. Do not use it.\n`;
          }
        }
      }
      feedbackPerModel.set(model.name, ctx);
    }

    // Round 2: With feedback
    const feedbackResults: EvalRunResult[] = [];

    for (const model of models) {
      const feedback = feedbackPerModel.get(model.name) ?? '';
      for (const goal of goals) {
        const result = await this.runOne(goal, model, feedback || undefined);
        // Tag the model name to distinguish from baseline
        result.model = `${model.name} +feedback`;
        feedbackResults.push(result);
        done++;
        onProgress?.(done, total, result);
      }
    }

    const baselineSummaries = this.summarize(baselineResults, models);
    const feedbackModels = models.map(m => ({ ...m, name: `${m.name} +feedback` }));
    const feedbackSummaries = this.summarize(feedbackResults, feedbackModels);

    return {
      baseline: {
        timestamp: new Date().toISOString(),
        goals,
        models,
        results: baselineResults,
        summaries: baselineSummaries,
      },
      withFeedback: {
        timestamp: new Date().toISOString(),
        goals,
        models: feedbackModels,
        results: feedbackResults,
        summaries: feedbackSummaries,
      },
    };
  }

  /**
   * Generate summary statistics per model.
   */
  private summarize(results: EvalRunResult[], models: EvalModelConfig[]): EvalSummary[] {
    return models.map(model => {
      const modelResults = results.filter(r => r.model === model.name);
      const n = modelResults.length || 1;

      return {
        model: model.name,
        totalGoals: modelResults.length,
        jsonValidRate: modelResults.filter(r => r.jsonValid).length / n,
        planValidRate: modelResults.filter(r => r.planValid).length / n,
        validationPassRate: modelResults.filter(r => r.validationPassed).length / n,
        deployReadyRate: modelResults.filter(r => r.deployReady).length / n,
        avgLatencyMs: Math.round(modelResults.reduce((sum, r) => sum + r.latencyMs, 0) / n),
        avgInputTokens: Math.round(modelResults.reduce((sum, r) => sum + r.inputTokens, 0) / n),
        avgOutputTokens: Math.round(modelResults.reduce((sum, r) => sum + r.outputTokens, 0) / n),
        avgNodeCount: +(modelResults.reduce((sum, r) => sum + r.nodeCount, 0) / n).toFixed(1),
        totalNormalizeFixes: modelResults.reduce((sum, r) => sum + r.normalizeFixes.length, 0),
      };
    });
  }

  /**
   * Format report as a readable table string.
   */
  static formatReport(report: EvalReport): string {
    const lines: string[] = [];
    lines.push(`\n${'═'.repeat(80)}`);
    lines.push(`  n8n-a2e Model Evaluation Report`);
    lines.push(`  ${report.timestamp}`);
    lines.push(`  ${report.goals.length} goals × ${report.models.length} models = ${report.results.length} runs`);
    lines.push(`${'═'.repeat(80)}\n`);

    // Summary table
    const cols = ['Model', 'JSON%', 'Plan%', 'Valid%', 'Deploy%', 'Latency', 'Tokens', 'Nodes', 'Fixes'];
    const widths = [25, 7, 7, 7, 8, 9, 9, 7, 7];

    const header = cols.map((c, i) => c.padEnd(widths[i])).join(' ');
    lines.push(header);
    lines.push('─'.repeat(header.length));

    for (const s of report.summaries) {
      const row = [
        s.model.slice(0, 24).padEnd(widths[0]),
        `${(s.jsonValidRate * 100).toFixed(0)}%`.padEnd(widths[1]),
        `${(s.planValidRate * 100).toFixed(0)}%`.padEnd(widths[2]),
        `${(s.validationPassRate * 100).toFixed(0)}%`.padEnd(widths[3]),
        `${(s.deployReadyRate * 100).toFixed(0)}%`.padEnd(widths[4]),
        `${s.avgLatencyMs}ms`.padEnd(widths[5]),
        `${s.avgInputTokens + s.avgOutputTokens}`.padEnd(widths[6]),
        `${s.avgNodeCount}`.padEnd(widths[7]),
        `${s.totalNormalizeFixes}`.padEnd(widths[8]),
      ];
      lines.push(row.join(' '));
    }

    // Per-goal details
    lines.push(`\n${'─'.repeat(80)}`);
    lines.push('  Per-Goal Results\n');

    for (const goal of report.goals) {
      lines.push(`  Goal: "${goal.goal}"`);
      const goalResults = report.results.filter(r => r.goal === goal.goal);
      for (const r of goalResults) {
        const status = r.deployReady ? 'READY' : r.planValid ? 'VALID' : r.jsonValid ? 'JSON' : 'FAIL';
        const icon = r.deployReady ? '+' : r.planValid ? '~' : '-';
        lines.push(`    [${icon}] ${r.model.padEnd(24)} ${status.padEnd(6)} ${r.nodeCount} nodes  ${r.latencyMs}ms${r.error ? `  ERR: ${r.error.slice(0, 50)}` : ''}`);
        if (r.normalizeFixes.length > 0) {
          lines.push(`        normalize fixes: ${r.normalizeFixes.join(', ')}`);
        }
        if (r.validationErrors.length > 0) {
          lines.push(`        errors: ${r.validationErrors.slice(0, 3).join('; ')}`);
        }
      }
      lines.push('');
    }

    lines.push(`${'═'.repeat(80)}`);
    return lines.join('\n');
  }

  /**
   * Build a WorkflowPlan from raw parsed JSON.
   */
  private buildPlan(raw: {
    name: string;
    description: string;
    steps: { index: number; n8nType: string; role: string; label?: string; parameters?: Record<string, unknown> }[];
    connections: { from: number; to: number; fromOutput?: number; toInput?: number; type?: string }[];
  }): WorkflowPlan {
    const steps = raw.steps.map((s, i) => {
      const nodeDef = this.orchestrator.getNodeDef(s.n8nType);
      const node = nodeDef ?? {
        id: s.n8nType,
        type: 'nodeDefinition' as const,
        createdAt: '',
        updatedAt: '',
        tags: [],
        n8nType: s.n8nType,
        displayName: s.label || s.n8nType.split('.').pop() || s.n8nType,
        version: [1],
        category: 'action' as const,
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
      };
    });

    return {
      name: raw.name,
      description: raw.description ?? '',
      steps,
      connections: raw.connections.map(c => ({
        from: c.from,
        to: c.to,
        fromOutput: c.fromOutput,
        toInput: c.toInput,
        type: c.type,
      })),
    };
  }
}
