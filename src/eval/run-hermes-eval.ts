#!/usr/bin/env node
/**
 * Ultra-small model stress test: Ollama local models.
 * Runs baseline vs feedback to see if sub-1B models can produce valid workflows.
 */

import { join } from 'node:path';
import { Store } from '../storage/store.js';
import { Orchestrator } from '../agent/orchestrator.js';
import { ModelEvaluator, type EvalModelConfig } from './evaluator.js';
import { DEFAULT_EVAL_GOALS } from './default-goals.js';

const DEFAULT_STORE_PATH = join(process.cwd(), '.n8n-a2e', 'store');

async function main() {
  const store = new Store({ root: DEFAULT_STORE_PATH });
  const orchestrator = new Orchestrator({ store });
  orchestrator.initialize();

  const stats = orchestrator.stats();
  console.log(`Store: ${stats.nodes} nodes, ${stats.patterns} patterns\n`);

  const models: EvalModelConfig[] = [
    {
      name: 'Qwen 3.5 0.8B',
      provider: 'ollama',
      config: {
        model: 'qwen3.5:0.8b',
      },
    },
    {
      name: 'Qwen 3 0.6B',
      provider: 'ollama',
      config: {
        model: 'qwen3:0.6b',
      },
    },
  ];

  console.log('='.repeat(80));
  console.log('  Ultra-Small Ollama Stress Test');
  console.log(`  ${DEFAULT_EVAL_GOALS.length} goals x ${models.length} models x 2 rounds`);
  console.log('='.repeat(80));
  console.log('');

  const evaluator = new ModelEvaluator(store, orchestrator);
  const total = DEFAULT_EVAL_GOALS.length * models.length * 2;

  const { baseline, withFeedback } = await evaluator.runWithFeedback(
    DEFAULT_EVAL_GOALS,
    models,
    (done, _total, result) => {
      const status = result.deployReady ? '+' : result.planValid ? '~' : result.jsonValid ? 'J' : '-';
      console.log(`  [${done}/${total}] [${status}] ${result.model.padEnd(28)} "${result.goal.slice(0, 45)}..." ${result.latencyMs}ms${result.error ? ` ERR: ${result.error.slice(0, 60)}` : ''}`);
    }
  );

  // Print results
  console.log('\n');
  console.log(ModelEvaluator.formatReport(baseline));
  console.log('\n');
  console.log(ModelEvaluator.formatReport(withFeedback));

  // Comparison
  const baseSummary = baseline.summaries[0];
  const fbSummary = withFeedback.summaries[0];

  console.log('\n');
  console.log('='.repeat(80));
  console.log('  COMPARISON: Baseline vs Feedback');
  console.log('='.repeat(80));
  console.log('');
  console.log(`  Metric              Baseline    Feedback    Delta`);
  console.log(`  ${'─'.repeat(55)}`);

  const metrics: [string, number, number][] = [
    ['JSON Valid', baseSummary.jsonValidRate, fbSummary.jsonValidRate],
    ['Plan Valid', baseSummary.planValidRate, fbSummary.planValidRate],
    ['Validation Pass', baseSummary.validationPassRate, fbSummary.validationPassRate],
    ['Deploy Ready', baseSummary.deployReadyRate, fbSummary.deployReadyRate],
  ];

  for (const [name, base, fb] of metrics) {
    const delta = fb - base;
    const deltaStr = delta > 0 ? `+${(delta * 100).toFixed(0)}%` : delta < 0 ? `${(delta * 100).toFixed(0)}%` : '0%';
    console.log(`  ${name.padEnd(20)} ${(base * 100).toFixed(0).padStart(4)}%       ${(fb * 100).toFixed(0).padStart(4)}%       ${deltaStr}`);
  }

  console.log(`\n  Avg Latency         ${baseSummary.avgLatencyMs}ms     ${fbSummary.avgLatencyMs}ms`);
  console.log(`  Avg Nodes           ${baseSummary.avgNodeCount}          ${fbSummary.avgNodeCount}`);
  console.log(`  Normalize Fixes     ${baseSummary.totalNormalizeFixes}            ${fbSummary.totalNormalizeFixes}`);
  console.log('');
  console.log('='.repeat(80));
}

main().catch(err => {
  console.error('Eval failed:', err);
  process.exit(1);
});
