/**
 * Built-in Workflow Patterns
 *
 * Common workflow templates that seed the store.
 * These give the agent proven patterns to draw from even before learning from usage.
 */

import type { WorkflowPattern } from '../types/entities.js';
import { Store } from '../storage/store.js';

const SEED_PATTERNS: Omit<WorkflowPattern, 'id' | 'createdAt' | 'updatedAt'>[] = [
  {
    type: 'workflowPattern',
    tags: ['webhook', 'http', 'api'],
    name: 'Webhook API endpoint',
    description: 'Receives HTTP requests via webhook, processes data, and responds',
    useCases: ['REST API endpoint', 'webhook receiver', 'HTTP callback'],
    nodes: [
      { n8nType: 'n8n-nodes-base.webhook', label: 'Webhook', parameters: { httpMethod: 'POST', path: 'webhook' }, position: [250, 300] },
      { n8nType: 'n8n-nodes-base.set', label: 'Process Data', parameters: {}, position: [550, 300] },
      { n8nType: 'n8n-nodes-base.respondToWebhook', label: 'Respond', parameters: {}, position: [850, 300] },
    ],
    connections: [
      { from: { node: 'Webhook', output: 0 }, to: { node: 'Process Data', input: 0 } },
      { from: { node: 'Process Data', output: 0 }, to: { node: 'Respond', input: 0 } },
    ],
    status: 'proven',
    successCount: 100,
    failCount: 0,
  },
  {
    type: 'workflowPattern',
    tags: ['schedule', 'cron', 'periodic'],
    name: 'Scheduled data sync',
    description: 'Runs on a schedule, fetches data from an API, and stores/sends it',
    useCases: ['periodic data sync', 'scheduled report', 'cron job'],
    nodes: [
      { n8nType: 'n8n-nodes-base.scheduleTrigger', label: 'Schedule', parameters: { rule: { interval: [{ field: 'hours', hoursInterval: 1 }] } }, position: [250, 300] },
      { n8nType: 'n8n-nodes-base.httpRequest', label: 'Fetch Data', parameters: { method: 'GET' }, position: [550, 300] },
      { n8nType: 'n8n-nodes-base.set', label: 'Transform', parameters: {}, position: [850, 300] },
    ],
    connections: [
      { from: { node: 'Schedule', output: 0 }, to: { node: 'Fetch Data', input: 0 } },
      { from: { node: 'Fetch Data', output: 0 }, to: { node: 'Transform', input: 0 } },
    ],
    status: 'proven',
    successCount: 80,
    failCount: 0,
  },
  {
    type: 'workflowPattern',
    tags: ['email', 'notification', 'conditional'],
    name: 'Email trigger with conditional routing',
    description: 'Triggers on incoming email, checks conditions, routes to different actions',
    useCases: ['email automation', 'email-triggered workflow', 'email classification'],
    nodes: [
      { n8nType: 'n8n-nodes-base.emailReadImap', label: 'Email Trigger', parameters: {}, position: [250, 300] },
      { n8nType: 'n8n-nodes-base.if', label: 'Check Condition', parameters: {}, position: [550, 300] },
      { n8nType: 'n8n-nodes-base.slack', label: 'Notify Slack', parameters: {}, position: [850, 200] },
      { n8nType: 'n8n-nodes-base.gmail', label: 'Reply Email', parameters: {}, position: [850, 400] },
    ],
    connections: [
      { from: { node: 'Email Trigger', output: 0 }, to: { node: 'Check Condition', input: 0 } },
      { from: { node: 'Check Condition', output: 0 }, to: { node: 'Notify Slack', input: 0 } },
      { from: { node: 'Check Condition', output: 1 }, to: { node: 'Reply Email', input: 0 } },
    ],
    status: 'proven',
    successCount: 60,
    failCount: 2,
  },
  {
    type: 'workflowPattern',
    tags: ['file', 'cloud', 'storage', 'google', 'drive'],
    name: 'File upload to cloud storage with notification',
    description: 'Receives a file, uploads to cloud storage, sends notification',
    useCases: ['file processing', 'cloud upload', 'attachment handling'],
    nodes: [
      { n8nType: 'n8n-nodes-base.webhook', label: 'Receive File', parameters: { httpMethod: 'POST' }, position: [250, 300] },
      { n8nType: 'n8n-nodes-base.googleDrive', label: 'Upload to Drive', parameters: { operation: 'upload' }, position: [550, 300] },
      { n8nType: 'n8n-nodes-base.slack', label: 'Notify', parameters: {}, position: [850, 300] },
    ],
    connections: [
      { from: { node: 'Receive File', output: 0 }, to: { node: 'Upload to Drive', input: 0 } },
      { from: { node: 'Upload to Drive', output: 0 }, to: { node: 'Notify', input: 0 } },
    ],
    status: 'proven',
    successCount: 50,
    failCount: 1,
  },
  {
    type: 'workflowPattern',
    tags: ['database', 'crud', 'api'],
    name: 'CRUD API with database',
    description: 'Webhook receives requests, routes by method, performs DB operations',
    useCases: ['REST CRUD', 'database API', 'backend endpoint'],
    nodes: [
      { n8nType: 'n8n-nodes-base.webhook', label: 'API Endpoint', parameters: { httpMethod: '={{$parameter.httpMethod}}', path: 'api/resource' }, position: [250, 300] },
      { n8nType: 'n8n-nodes-base.switch', label: 'Route by Method', parameters: {}, position: [550, 300] },
      { n8nType: 'n8n-nodes-base.postgres', label: 'DB Query', parameters: {}, position: [850, 200] },
      { n8nType: 'n8n-nodes-base.postgres', label: 'DB Insert', parameters: { operation: 'insert' }, position: [850, 400] },
      { n8nType: 'n8n-nodes-base.respondToWebhook', label: 'Respond', parameters: {}, position: [1150, 300] },
    ],
    connections: [
      { from: { node: 'API Endpoint', output: 0 }, to: { node: 'Route by Method', input: 0 } },
      { from: { node: 'Route by Method', output: 0 }, to: { node: 'DB Query', input: 0 } },
      { from: { node: 'Route by Method', output: 1 }, to: { node: 'DB Insert', input: 0 } },
      { from: { node: 'DB Query', output: 0 }, to: { node: 'Respond', input: 0 } },
      { from: { node: 'DB Insert', output: 0 }, to: { node: 'Respond', input: 0 } },
    ],
    status: 'proven',
    successCount: 40,
    failCount: 3,
  },
  {
    type: 'workflowPattern',
    tags: ['ai', 'langchain', 'agent', 'openai', 'chat'],
    name: 'AI Agent with tools',
    description: 'AI agent that can use tools to answer questions or perform actions',
    useCases: ['AI chatbot', 'AI agent', 'tool-calling agent', 'RAG'],
    nodes: [
      { n8nType: 'n8n-nodes-base.webhook', label: 'Chat Input', parameters: { httpMethod: 'POST', path: 'chat' }, position: [250, 300] },
      { n8nType: '@n8n/n8n-nodes-langchain.agent', label: 'AI Agent', parameters: {}, position: [550, 300] },
      { n8nType: '@n8n/n8n-nodes-langchain.lmChatOpenAi', label: 'OpenAI Model', parameters: {}, position: [550, 500] },
      { n8nType: 'n8n-nodes-base.respondToWebhook', label: 'Respond', parameters: {}, position: [850, 300] },
    ],
    connections: [
      { from: { node: 'Chat Input', output: 0 }, to: { node: 'AI Agent', input: 0 } },
      { from: { node: 'OpenAI Model', output: 0 }, to: { node: 'AI Agent', input: 0 } },
      { from: { node: 'AI Agent', output: 0 }, to: { node: 'Respond', input: 0 } },
    ],
    status: 'proven',
    successCount: 30,
    failCount: 2,
  },
  {
    type: 'workflowPattern',
    tags: ['error', 'monitoring', 'alert'],
    name: 'Error handler with alerting',
    description: 'Catches errors from other workflows, logs them, sends alerts',
    useCases: ['error monitoring', 'workflow alerting', 'error notification'],
    nodes: [
      { n8nType: 'n8n-nodes-base.errorTrigger', label: 'Error Trigger', parameters: {}, position: [250, 300] },
      { n8nType: 'n8n-nodes-base.set', label: 'Format Error', parameters: {}, position: [550, 300] },
      { n8nType: 'n8n-nodes-base.slack', label: 'Alert Slack', parameters: {}, position: [850, 200] },
      { n8nType: 'n8n-nodes-base.gmail', label: 'Alert Email', parameters: {}, position: [850, 400] },
    ],
    connections: [
      { from: { node: 'Error Trigger', output: 0 }, to: { node: 'Format Error', input: 0 } },
      { from: { node: 'Format Error', output: 0 }, to: { node: 'Alert Slack', input: 0 } },
      { from: { node: 'Format Error', output: 0 }, to: { node: 'Alert Email', input: 0 } },
    ],
    status: 'proven',
    successCount: 45,
    failCount: 0,
  },
  {
    type: 'workflowPattern',
    tags: ['batch', 'loop', 'pagination', 'bulk'],
    name: 'Batch processing with pagination',
    description: 'Fetches paginated data, processes in batches, aggregates results',
    useCases: ['bulk processing', 'paginated API', 'batch operations', 'data migration'],
    nodes: [
      { n8nType: 'n8n-nodes-base.manualTrigger', label: 'Start', parameters: {}, position: [250, 300] },
      { n8nType: 'n8n-nodes-base.httpRequest', label: 'Fetch Page', parameters: {}, position: [550, 300] },
      { n8nType: 'n8n-nodes-base.splitInBatches', label: 'Split', parameters: { batchSize: 10 }, position: [850, 300] },
      { n8nType: 'n8n-nodes-base.set', label: 'Process Item', parameters: {}, position: [1150, 300] },
    ],
    connections: [
      { from: { node: 'Start', output: 0 }, to: { node: 'Fetch Page', input: 0 } },
      { from: { node: 'Fetch Page', output: 0 }, to: { node: 'Split', input: 0 } },
      { from: { node: 'Split', output: 0 }, to: { node: 'Process Item', input: 0 } },
    ],
    status: 'proven',
    successCount: 35,
    failCount: 1,
  },
];

/** Seed the store with built-in workflow patterns */
export function seedPatterns(store: Store): number {
  let count = 0;
  const existing = store.count('workflowPattern');

  if (existing > 0) {
    return 0; // Already seeded
  }

  for (const pattern of SEED_PATTERNS) {
    store.save(pattern as WorkflowPattern);
    count++;
  }

  return count;
}
