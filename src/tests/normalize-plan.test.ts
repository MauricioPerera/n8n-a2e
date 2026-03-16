/**
 * Tests for the Plan Normalizer.
 * Validates that LLM-generated plans are sanitized before composition.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePlan } from '../autonomous/normalize-plan.js';
import type { WorkflowPlan, WorkflowStep, StepConnection } from '../agent/orchestrator.js';
import type { NodeDefinition } from '../types/entities.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeNode(n8nType: string): NodeDefinition {
  return {
    id: n8nType,
    type: 'nodeDefinition',
    createdAt: '',
    updatedAt: '',
    tags: [],
    n8nType,
    displayName: n8nType.split('.').pop() || n8nType,
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

function makePlan(stepTypes: string[], connections: StepConnection[]): WorkflowPlan {
  const steps: WorkflowStep[] = stepTypes.map((t, i) => ({
    index: i,
    node: makeNode(t),
    role: i === 0 ? 'trigger' : 'action',
  }));
  return {
    name: 'Test Plan',
    description: 'test',
    steps,
    connections,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('normalizePlan', () => {
  it('should pass through a valid plan unchanged', () => {
    const plan = makePlan(
      ['n8n-nodes-base.manualTrigger', 'n8n-nodes-base.set', 'n8n-nodes-base.httpRequest'],
      [{ from: 0, to: 1 }, { from: 1, to: 2 }]
    );
    const { plan: result, fixes } = normalizePlan(plan);
    assert.equal(fixes.length, 0);
    assert.equal(result.connections.length, 2);
  });

  it('should remove out-of-bounds connections', () => {
    const plan = makePlan(
      ['n8n-nodes-base.manualTrigger', 'n8n-nodes-base.set'],
      [{ from: 0, to: 1 }, { from: 0, to: 5 }, { from: 3, to: 1 }]
    );
    const { plan: result, fixes } = normalizePlan(plan);
    assert.equal(result.connections.length, 1);
    assert.equal(fixes.length, 2);
    assert.ok(fixes.some(f => f.includes('out-of-bounds')));
  });

  it('should remove self-loops', () => {
    const plan = makePlan(
      ['n8n-nodes-base.manualTrigger', 'n8n-nodes-base.set'],
      [{ from: 0, to: 1 }, { from: 1, to: 1 }]
    );
    const { plan: result, fixes } = normalizePlan(plan);
    assert.equal(result.connections.length, 1);
    assert.ok(fixes.some(f => f.includes('self-loop')));
  });

  it('should remove duplicate connections', () => {
    const plan = makePlan(
      ['n8n-nodes-base.manualTrigger', 'n8n-nodes-base.set'],
      [{ from: 0, to: 1 }, { from: 0, to: 1 }, { from: 0, to: 1 }]
    );
    const { plan: result, fixes } = normalizePlan(plan);
    assert.equal(result.connections.length, 1);
    assert.ok(fixes.some(f => f.includes('duplicate')));
  });

  it('should auto-chain steps when no connections provided', () => {
    const plan = makePlan(
      ['n8n-nodes-base.manualTrigger', 'n8n-nodes-base.set', 'n8n-nodes-base.httpRequest'],
      []
    );
    const { plan: result, fixes } = normalizePlan(plan);
    assert.equal(result.connections.length, 2);
    assert.deepEqual(result.connections[0], { from: 0, to: 1 });
    assert.deepEqual(result.connections[1], { from: 1, to: 2 });
    assert.ok(fixes.some(f => f.includes('Auto-chained')));
  });

  it('should connect orphan nodes to previous step', () => {
    // Step 0→1 is connected, but step 2 is orphaned
    const plan = makePlan(
      ['n8n-nodes-base.manualTrigger', 'n8n-nodes-base.set', 'n8n-nodes-base.httpRequest'],
      [{ from: 0, to: 1 }]
    );
    const { plan: result, fixes } = normalizePlan(plan);
    assert.equal(result.connections.length, 2);
    assert.ok(result.connections.some(c => c.from === 1 && c.to === 2));
    assert.ok(fixes.some(f => f.includes('orphan')));
  });

  it('should handle plans where only some connections are out of bounds', () => {
    // 3 steps, but LLM gives connection to index 3 (doesn\'t exist)
    const plan = makePlan(
      ['n8n-nodes-base.manualTrigger', 'n8n-nodes-base.if', 'n8n-nodes-base.set'],
      [{ from: 0, to: 1 }, { from: 1, to: 3 }]
    );
    const { plan: result, fixes } = normalizePlan(plan);
    // Connection 1→3 removed, step 2 becomes orphan and gets auto-connected
    assert.ok(result.connections.some(c => c.from === 0 && c.to === 1));
    assert.ok(result.connections.some(c => c.to === 2));
    assert.ok(fixes.some(f => f.includes('out-of-bounds')));
  });

  it('should fix step indices that dont match array position', () => {
    const plan = makePlan(
      ['n8n-nodes-base.manualTrigger', 'n8n-nodes-base.set'],
      [{ from: 0, to: 1 }]
    );
    plan.steps[0].index = 5;
    plan.steps[1].index = 10;

    const { plan: result, fixes } = normalizePlan(plan);
    assert.equal(result.steps[0].index, 0);
    assert.equal(result.steps[1].index, 1);
    assert.ok(fixes.some(f => f.includes('Reindexed')));
  });

  it('should preserve valid fromOutput and toInput', () => {
    const plan = makePlan(
      ['n8n-nodes-base.manualTrigger', 'n8n-nodes-base.if', 'n8n-nodes-base.set', 'n8n-nodes-base.httpRequest'],
      [
        { from: 0, to: 1 },
        { from: 1, to: 2, fromOutput: 0 },
        { from: 1, to: 3, fromOutput: 1 },
      ]
    );
    const { plan: result, fixes } = normalizePlan(plan);
    assert.equal(fixes.length, 0);
    assert.equal(result.connections.length, 3);
    assert.equal(result.connections[1].fromOutput, 0);
    assert.equal(result.connections[2].fromOutput, 1);
  });

  it('should handle single-node plan', () => {
    const plan = makePlan(['n8n-nodes-base.manualTrigger'], []);
    const { plan: result, fixes } = normalizePlan(plan);
    assert.equal(fixes.length, 0);
    assert.equal(result.connections.length, 0);
  });

  it('should handle empty plan', () => {
    const plan: WorkflowPlan = { name: 'Empty', description: '', steps: [], connections: [] };
    const { plan: result, fixes } = normalizePlan(plan);
    assert.equal(fixes.length, 0);
    assert.equal(result.connections.length, 0);
  });

  it('should handle the classic 1B model failure: 1 step with connections to nonexistent nodes', () => {
    // LLM generates 1 step but connection from 0→1
    const plan = makePlan(
      ['n8n-nodes-base.webhook'],
      [{ from: 0, to: 1 }]
    );
    const { plan: result, fixes } = normalizePlan(plan);
    assert.equal(result.connections.length, 0);
    assert.ok(fixes.some(f => f.includes('out-of-bounds')));
  });
});
