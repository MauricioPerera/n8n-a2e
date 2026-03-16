/**
 * Workflow Skills — Autonomous Learning Layer
 *
 * Inspired by RepoMemory v2's workflow-skills.ts.
 * Saves successful workflows as reusable patterns, records errors as
 * ExecutionContexts, and mines sessions for A2E patterns.
 */

import { Store } from '../storage/store.js';
import type { WorkflowPattern, ExecutionContext } from '../types/entities.js';
import type { N8nWorkflow } from '../types/workflow.js';
import { sanitizeParameters } from './sanitize.js';
import { SearchEngine } from '../search/tfidf.js';

// ─── Save Success ──────────────────────────────────────────────────────────

/**
 * Save a successful workflow as a reusable WorkflowPattern.
 * Sanitizes parameters to remove credentials before persisting.
 */
export function saveWorkflowSkill(
  store: Store,
  workflow: N8nWorkflow,
  query: string,
  useCases: string[],
  secrets?: Map<string, string>
): WorkflowPattern {
  const pattern: WorkflowPattern = {
    id: '',
    type: 'workflowPattern',
    createdAt: '',
    updatedAt: '',
    tags: [
      'a2e-learned',
      ...workflow.nodes.map(n => n.type),
      ...extractOperationTags(workflow),
    ],
    name: workflow.name,
    description: `Learned from: "${query}"`,
    useCases,
    nodes: workflow.nodes.map(n => ({
      n8nType: n.type,
      label: n.name,
      parameters: sanitizeParameters(n.parameters ?? {}, secrets),
      position: n.position,
    })),
    connections: flattenConnections(workflow),
    status: 'experimental',
    successCount: 1,
    failCount: 0,
  };

  return store.save(pattern);
}

// ─── Save Error ────────────────────────────────────────────────────────────

/**
 * Record a workflow error as an ExecutionContext.
 * Used by the circuit breaker to prevent repeated failures.
 */
export function saveWorkflowError(
  store: Store,
  n8nTypes: string[],
  query: string,
  error: string,
  resolution?: string
): ExecutionContext[] {
  return n8nTypes.map(n8nType => {
    const ctx: ExecutionContext = {
      id: '',
      type: 'executionContext',
      createdAt: '',
      updatedAt: '',
      tags: ['a2e-error', n8nType],
      category: 'error',
      n8nType,
      content: `Failed workflow for "${query}": ${error}`,
      resolution,
      relevance: 1.0,
    };
    return store.save(ctx);
  });
}

// ─── Recall Patterns ───────────────────────────────────────────────────────

/**
 * Recall previously successful workflow patterns for a given query.
 * Uses TF-IDF search when a query is provided, falls back to success-sorted list.
 */
export function recallWorkflowSkills(
  store: Store,
  limitOrQuery: number | string = 3,
  limit = 3
): WorkflowPattern[] {
  const query = typeof limitOrQuery === 'string' ? limitOrQuery : undefined;
  const maxResults = typeof limitOrQuery === 'number' ? limitOrQuery : limit;

  const patterns = store.list<WorkflowPattern>('workflowPattern')
    .filter(p => p.tags.includes('a2e-learned') && p.status !== 'deprecated');

  if (!query || patterns.length === 0) {
    // No query — fall back to success-sorted
    return patterns
      .sort((a, b) => b.successCount - a.successCount)
      .slice(0, maxResults);
  }

  // Use TF-IDF search to rank patterns by relevance to the goal
  const engine = new SearchEngine();
  engine.index(patterns);
  const results = engine.search(query, maxResults);
  return results.map(r => r.entity as WorkflowPattern);
}

// ─── Increment Success/Fail ────────────────────────────────────────────────

/**
 * Increment the success count of a pattern that was reused.
 */
export function markPatternSuccess(store: Store, patternId: string): void {
  const pattern = store.get<WorkflowPattern>('workflowPattern', patternId);
  if (pattern) {
    pattern.successCount += 1;
    if (pattern.successCount >= 5 && pattern.status === 'experimental') {
      pattern.status = 'proven';
    }
    pattern.updatedAt = new Date().toISOString();
    store.save(pattern);
  }
}

/**
 * Increment the fail count; deprecate if too many failures.
 */
export function markPatternFailure(store: Store, patternId: string): void {
  const pattern = store.get<WorkflowPattern>('workflowPattern', patternId);
  if (pattern) {
    pattern.failCount += 1;
    if (pattern.failCount >= 5) {
      pattern.status = 'deprecated';
    }
    pattern.updatedAt = new Date().toISOString();
    store.save(pattern);
  }
}

// ─── Extract Fixes ─────────────────────────────────────────────────────────

/**
 * Save a fix/optimization learned from execution feedback.
 */
export function saveExecutionFix(
  store: Store,
  n8nType: string,
  content: string,
  resolution: string
): ExecutionContext {
  const ctx: ExecutionContext = {
    id: '',
    type: 'executionContext',
    createdAt: '',
    updatedAt: '',
    tags: ['a2e-fix', n8nType],
    category: 'fix',
    n8nType,
    content,
    resolution,
    relevance: 1.0,
  };
  return store.save(ctx);
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function flattenConnections(workflow: N8nWorkflow): WorkflowPattern['connections'] {
  const connections: WorkflowPattern['connections'] = [];
  for (const [sourceName, connTypes] of Object.entries(workflow.connections)) {
    for (const outputs of Object.values(connTypes)) {
      for (let outputIdx = 0; outputIdx < outputs.length; outputIdx++) {
        for (const conn of outputs[outputIdx]) {
          connections.push({
            from: { node: sourceName, output: outputIdx },
            to: { node: conn.node, input: conn.index },
          });
        }
      }
    }
  }
  return connections;
}

function extractOperationTags(workflow: N8nWorkflow): string[] {
  const tags: string[] = [];
  for (const node of workflow.nodes) {
    // Extract resource/operation from parameters (common n8n pattern)
    const resource = node.parameters?.resource;
    const operation = node.parameters?.operation;
    if (typeof resource === 'string') tags.push(resource);
    if (typeof operation === 'string') tags.push(operation);
  }
  return [...new Set(tags)];
}
