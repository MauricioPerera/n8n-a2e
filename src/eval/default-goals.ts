/**
 * Default evaluation goals for model comparison.
 * Covers a range of workflow complexity levels.
 */

import type { EvalGoal } from './evaluator.js';

export const DEFAULT_EVAL_GOALS: EvalGoal[] = [
  // ── Simple (2-3 nodes) ─────────────────────────────────────────────────────
  {
    goal: 'Create a webhook that returns a JSON response with a greeting message',
    minNodes: 2,
    expectedTypes: ['n8n-nodes-base.webhook'],
    tags: ['simple', 'webhook'],
  },
  {
    goal: 'Create a workflow that runs every hour and makes an HTTP GET request to https://api.example.com/status',
    minNodes: 2,
    expectedTypes: ['n8n-nodes-base.scheduleTrigger', 'n8n-nodes-base.httpRequest'],
    tags: ['simple', 'schedule', 'http'],
  },
  {
    goal: 'Create a manual trigger workflow that generates a random UUID and sets it as output',
    minNodes: 2,
    tags: ['simple', 'utility'],
  },

  // ── Medium (3-5 nodes) ─────────────────────────────────────────────────────
  {
    goal: 'Create a webhook that receives data, filters items where status is "active", and responds with the filtered results',
    minNodes: 3,
    expectedTypes: ['n8n-nodes-base.webhook', 'n8n-nodes-base.if'],
    tags: ['medium', 'filter', 'webhook'],
  },
  {
    goal: 'Create a scheduled workflow that fetches data from an API, transforms the response to extract only name and email fields, and stores the result',
    minNodes: 3,
    tags: ['medium', 'transform', 'http'],
  },

  // ── Complex (5+ nodes, branching) ──────────────────────────────────────────
  {
    goal: 'Create a webhook that receives a JSON payload with a "type" field. If type is "urgent", send a Slack notification. Otherwise, save the data to a spreadsheet.',
    minNodes: 4,
    expectedTypes: ['n8n-nodes-base.webhook', 'n8n-nodes-base.if'],
    tags: ['complex', 'branching', 'webhook'],
  },
  {
    goal: 'Create a workflow triggered by a schedule that calls 3 different APIs in sequence, merges the results, and sends a summary via email',
    minNodes: 5,
    tags: ['complex', 'multi-api', 'merge'],
  },
];
