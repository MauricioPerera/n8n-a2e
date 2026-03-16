/**
 * Plan Normalizer
 *
 * Fixes common LLM mistakes in workflow plans before composition:
 * - Removes connections with out-of-bounds indices
 * - Removes duplicate connections
 * - Removes self-loops
 * - Ensures all non-trigger nodes are connected (auto-chains orphans)
 * - Validates step indices are sequential
 */

import type { WorkflowPlan, StepConnection } from '../agent/orchestrator.js';

export interface NormalizePlanResult {
  plan: WorkflowPlan;
  fixes: string[];
}

export function normalizePlan(plan: WorkflowPlan): NormalizePlanResult {
  const fixes: string[] = [];
  const stepCount = plan.steps.length;

  if (stepCount === 0) {
    return { plan, fixes };
  }

  // Fix step indices if they don't match array position
  for (let i = 0; i < plan.steps.length; i++) {
    if (plan.steps[i].index !== i) {
      fixes.push(`Reindexed step ${plan.steps[i].index} → ${i}`);
      plan.steps[i].index = i;
    }
  }

  let connections = [...plan.connections];

  // 1. Remove out-of-bounds connections
  const validConns = connections.filter(c => {
    if (c.from < 0 || c.from >= stepCount || c.to < 0 || c.to >= stepCount) {
      fixes.push(`Removed out-of-bounds connection ${c.from}→${c.to} (max index: ${stepCount - 1})`);
      return false;
    }
    return true;
  });

  // 2. Remove self-loops
  const noLoops = validConns.filter(c => {
    if (c.from === c.to) {
      fixes.push(`Removed self-loop on step ${c.from}`);
      return false;
    }
    return true;
  });

  // 3. Remove duplicates
  const seen = new Set<string>();
  const deduped = noLoops.filter(c => {
    const key = `${c.from}-${c.to}-${c.fromOutput ?? 0}-${c.toInput ?? 0}-${c.type ?? 'main'}`;
    if (seen.has(key)) {
      fixes.push(`Removed duplicate connection ${c.from}→${c.to}`);
      return false;
    }
    seen.add(key);
    return true;
  });

  // 4. Find orphan nodes (no incoming connection, not index 0/trigger)
  const hasIncoming = new Set(deduped.map(c => c.to));
  const hasOutgoing = new Set(deduped.map(c => c.from));
  const connected = new Set([...hasIncoming, ...hasOutgoing]);

  // Auto-chain orphan nodes: connect them sequentially to form a linear flow
  const orphans: number[] = [];
  for (let i = 0; i < stepCount; i++) {
    if (i === 0) continue; // trigger/first node is always a root
    if (!hasIncoming.has(i)) {
      orphans.push(i);
    }
  }

  const autoChained: StepConnection[] = [];
  if (orphans.length > 0 && deduped.length === 0) {
    // No connections at all — create a linear chain
    for (let i = 0; i < stepCount - 1; i++) {
      autoChained.push({ from: i, to: i + 1 });
    }
    fixes.push(`Auto-chained all ${stepCount} steps (no connections provided)`);
  } else {
    // Connect individual orphans to the previous node in sequence
    for (const orphan of orphans) {
      // Find the best predecessor: the highest-indexed connected node before this one
      let pred = orphan - 1;
      while (pred >= 0 && !connected.has(pred) && pred !== 0) {
        pred--;
      }
      if (pred >= 0) {
        autoChained.push({ from: pred, to: orphan });
        connected.add(orphan);
        fixes.push(`Auto-connected orphan step ${orphan} to step ${pred}`);
      }
    }
  }

  // 5. Ensure totally disconnected nodes (not even outgoing) get chained
  const finalConns = [...deduped, ...autoChained];
  const finalConnected = new Set<number>();
  for (const c of finalConns) {
    finalConnected.add(c.from);
    finalConnected.add(c.to);
  }

  for (let i = 1; i < stepCount; i++) {
    if (!finalConnected.has(i)) {
      finalConns.push({ from: i - 1, to: i });
      fixes.push(`Auto-connected isolated step ${i} to step ${i - 1}`);
    }
  }

  return {
    plan: {
      ...plan,
      connections: finalConns,
    },
    fixes,
  };
}
