#!/usr/bin/env node
/**
 * Feedback Loop Evaluation
 *
 * Runs each model twice:
 *   Round 1: Baseline (no feedback)
 *   Round 2: With anti-pattern feedback from round 1 failures
 *
 * Measures whether models improve when given error context.
 *
 * Usage: node dist/eval/run-feedback-eval.js
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../storage/store.js';
import { Orchestrator } from '../agent/orchestrator.js';
import { ModelEvaluator, type EvalModelConfig, type EvalReport } from './evaluator.js';
import { DEFAULT_EVAL_GOALS } from './default-goals.js';

const DEFAULT_STORE_PATH = join(process.cwd(), '.n8n-a2e', 'store');

interface AppConfig {
  cfApiKey: string;
  cfAccountId: string;
}

function loadConfig(): AppConfig {
  const configPath = join(process.cwd(), '.n8n-a2e', 'config.json');
  const raw = readFileSync(configPath, 'utf-8');
  return JSON.parse(raw) as AppConfig;
}

async function main() {
  const config = loadConfig();

  // Setup
  const store = new Store({ root: DEFAULT_STORE_PATH });
  const orchestrator = new Orchestrator({ store });
  orchestrator.initialize();

  const stats = orchestrator.stats();
  console.log(`Store: ${stats.nodes} nodes, ${stats.patterns} patterns\n`);

  // Models to evaluate
  const models: EvalModelConfig[] = [
    {
      name: 'Llama 3.3 70B',
      provider: 'cloudflare',
      config: {
        apiKey: config.cfApiKey,
        accountId: config.cfAccountId,
        model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      },
    },
    {
      name: 'Qwen 3 30B',
      provider: 'cloudflare',
      config: {
        apiKey: config.cfApiKey,
        accountId: config.cfAccountId,
        model: '@cf/qwen/qwen3-30b-a3b-fp8',
      },
    },
    {
      name: 'Granite 4.0 Micro',
      provider: 'cloudflare',
      config: {
        apiKey: config.cfApiKey,
        accountId: config.cfAccountId,
        model: '@cf/ibm-granite/granite-4.0-h-micro',
      },
    },
  ];

  console.log('='.repeat(80));
  console.log('  n8n-a2e Feedback Loop Evaluation');
  console.log(`  ${DEFAULT_EVAL_GOALS.length} goals x ${models.length} models x 2 rounds`);
  console.log('  Round 1: Baseline | Round 2: With anti-pattern feedback');
  console.log('='.repeat(80));
  console.log('');

  const evaluator = new ModelEvaluator(store, orchestrator);
  const total = DEFAULT_EVAL_GOALS.length * models.length * 2;

  const { baseline, withFeedback } = await evaluator.runWithFeedback(
    DEFAULT_EVAL_GOALS,
    models,
    (done, _total, result) => {
      const status = result.deployReady ? '+' : result.planValid ? '~' : '-';
      console.log(`  [${done}/${total}] [${status}] ${result.model.padEnd(28)} "${result.goal.slice(0, 45)}..." ${result.latencyMs}ms`);
    }
  );

  // Print results
  console.log('\n');
  console.log('='.repeat(80));
  console.log('  ROUND 1: BASELINE (no feedback)');
  console.log('='.repeat(80));
  console.log(ModelEvaluator.formatReport(baseline));

  console.log('\n');
  console.log('='.repeat(80));
  console.log('  ROUND 2: WITH FEEDBACK (anti-patterns from round 1)');
  console.log('='.repeat(80));
  console.log(ModelEvaluator.formatReport(withFeedback));

  // Comparison table
  console.log('\n');
  console.log('='.repeat(80));
  console.log('  COMPARISON: Baseline vs Feedback');
  console.log('='.repeat(80));
  console.log('');

  const cols = ['Model', 'Base Deploy%', 'FB Deploy%', 'Delta', 'Base Valid%', 'FB Valid%', 'Delta'];
  const widths = [22, 13, 13, 8, 12, 12, 8];
  const header = cols.map((c, i) => c.padEnd(widths[i])).join(' ');
  console.log(header);
  console.log('-'.repeat(header.length));

  for (const model of models) {
    const baseSummary = baseline.summaries.find(s => s.model === model.name);
    const fbSummary = withFeedback.summaries.find(s => s.model === `${model.name} +feedback`);

    if (!baseSummary || !fbSummary) continue;

    const deployDelta = fbSummary.deployReadyRate - baseSummary.deployReadyRate;
    const validDelta = fbSummary.validationPassRate - baseSummary.validationPassRate;

    const deployDeltaStr = deployDelta > 0 ? `+${(deployDelta * 100).toFixed(0)}%` : `${(deployDelta * 100).toFixed(0)}%`;
    const validDeltaStr = validDelta > 0 ? `+${(validDelta * 100).toFixed(0)}%` : `${(validDelta * 100).toFixed(0)}%`;

    const row = [
      model.name.slice(0, 21).padEnd(widths[0]),
      `${(baseSummary.deployReadyRate * 100).toFixed(0)}%`.padEnd(widths[1]),
      `${(fbSummary.deployReadyRate * 100).toFixed(0)}%`.padEnd(widths[2]),
      deployDeltaStr.padEnd(widths[3]),
      `${(baseSummary.validationPassRate * 100).toFixed(0)}%`.padEnd(widths[4]),
      `${(fbSummary.validationPassRate * 100).toFixed(0)}%`.padEnd(widths[5]),
      validDeltaStr.padEnd(widths[6]),
    ];
    console.log(row.join(' '));
  }

  console.log('');
  console.log('='.repeat(80));
}

main().catch(err => {
  console.error('Eval failed:', err);
  process.exit(1);
});
