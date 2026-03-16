/**
 * Workflow Composer
 *
 * Takes a set of NodeDefinitions and a connection plan,
 * generates a valid n8n workflow JSON ready for the API.
 */

import { randomUUID } from 'node:crypto';
import type { NodeDefinition } from '../types/entities.js';
import type { N8nWorkflow, N8nWorkflowNode, N8nConnections, N8nConnection } from '../types/workflow.js';

// ─── Layout ──────────────────────────────────────────────────────────────────

const NODE_SPACING_X = 300;
const NODE_SPACING_Y = 200;
const START_X = 250;
const START_Y = 300;

export interface ComposerNode {
  /** Reference to a NodeDefinition */
  definition: NodeDefinition;
  /** Custom label for this node instance */
  label?: string;
  /** Parameter overrides */
  parameters?: Record<string, unknown>;
  /** Credential bindings: credentialType → { id, name } */
  credentials?: Record<string, { id: string; name: string }>;
  /** Disable the node? */
  disabled?: boolean;
}

export interface ComposerConnection {
  /** Index of source node in the nodes array */
  from: number;
  /** Output index of the source node (default 0) */
  fromOutput?: number;
  /** Index of target node in the nodes array */
  to: number;
  /** Input index of the target node (default 0) */
  toInput?: number;
  /** Connection type (default 'main') */
  type?: string;
}

export interface ComposeOptions {
  name: string;
  nodes: ComposerNode[];
  connections: ComposerConnection[];
  settings?: N8nWorkflow['settings'];
  tags?: string[];
}

/** Auto-layout nodes in a left-to-right flow */
function layoutNodes(nodes: ComposerNode[], connections: ComposerConnection[]): [number, number][] {
  const positions: [number, number][] = new Array(nodes.length);
  const depths = new Array(nodes.length).fill(0);

  // Calculate depth (distance from any root/trigger node) via BFS
  const adjacency: number[][] = nodes.map(() => []);
  for (const conn of connections) {
    // Safety: skip out-of-bounds indices
    if (conn.from >= 0 && conn.from < nodes.length && conn.to >= 0 && conn.to < nodes.length) {
      adjacency[conn.from].push(conn.to);
    }
  }

  // Find roots (nodes with no incoming connections)
  const hasIncoming = new Set(connections.map(c => c.to));
  const roots = nodes.map((_, i) => i).filter(i => !hasIncoming.has(i));

  // BFS from roots
  const queue = roots.length > 0 ? [...roots] : [0];
  const visited = new Set<number>();
  for (const r of queue) {
    visited.add(r);
    depths[r] = 0;
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of adjacency[current]) {
      if (!visited.has(next) || depths[next] < depths[current] + 1) {
        depths[next] = depths[current] + 1;
        if (!visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }
  }

  // Group by depth, assign y positions within each column
  const byDepth = new Map<number, number[]>();
  for (let i = 0; i < nodes.length; i++) {
    const d = depths[i];
    if (!byDepth.has(d)) byDepth.set(d, []);
    byDepth.get(d)!.push(i);
  }

  for (const [depth, indices] of byDepth) {
    const colHeight = indices.length * NODE_SPACING_Y;
    const startY = START_Y - colHeight / 2;
    for (let j = 0; j < indices.length; j++) {
      positions[indices[j]] = [
        START_X + depth * NODE_SPACING_X,
        startY + j * NODE_SPACING_Y,
      ];
    }
  }

  return positions;
}

/** Compose a complete n8n workflow JSON from high-level instructions */
export function composeWorkflow(options: ComposeOptions): N8nWorkflow {
  const { name, nodes: composerNodes, connections: composerConns, settings } = options;

  // Layout
  const positions = layoutNodes(composerNodes, composerConns);

  // Build node instances
  const nodeInstances: N8nWorkflowNode[] = composerNodes.map((cn, i) => {
    const versions = cn.definition.version;
    const latestVersion = versions[versions.length - 1];

    // Generate unique name: use label or displayName, deduplicate
    const baseName = cn.label || cn.definition.displayName;

    return {
      id: randomUUID(),
      name: baseName,
      type: cn.definition.n8nType,
      typeVersion: latestVersion,
      position: positions[i],
      parameters: cn.parameters ?? {},
      credentials: cn.credentials,
      disabled: cn.disabled,
    };
  });

  // Deduplicate names
  const nameCount = new Map<string, number>();
  for (const node of nodeInstances) {
    const count = nameCount.get(node.name) ?? 0;
    nameCount.set(node.name, count + 1);
    if (count > 0) {
      node.name = `${node.name} ${count}`;
    }
  }

  // Build connections (with bounds checking for LLM-generated plans)
  const n8nConnections: N8nConnections = {};
  for (const conn of composerConns) {
    // Skip invalid connection indices
    if (conn.from < 0 || conn.from >= nodeInstances.length ||
        conn.to < 0 || conn.to >= nodeInstances.length) {
      continue;
    }

    const sourceName = nodeInstances[conn.from].name;
    const connType = conn.type ?? 'main';
    // Coerce to number — LLMs sometimes return strings like "output 0"
    const outputIdx = typeof conn.fromOutput === 'number' ? conn.fromOutput : parseInt(String(conn.fromOutput ?? 0).replace(/\D/g, '') || '0', 10);

    if (!n8nConnections[sourceName]) {
      n8nConnections[sourceName] = {};
    }
    if (!n8nConnections[sourceName][connType]) {
      n8nConnections[sourceName][connType] = [];
    }

    // Ensure array is long enough for the output index
    while (n8nConnections[sourceName][connType].length <= outputIdx) {
      n8nConnections[sourceName][connType].push([]);
    }

    const inputIdx = typeof conn.toInput === 'number' ? conn.toInput : parseInt(String(conn.toInput ?? 0).replace(/\D/g, '') || '0', 10);
    const target: N8nConnection = {
      node: nodeInstances[conn.to].name,
      type: connType,
      index: inputIdx,
    };

    n8nConnections[sourceName][connType][outputIdx].push(target);
  }

  return {
    name,
    active: false,
    nodes: nodeInstances,
    connections: n8nConnections,
    settings: settings ?? {
      executionOrder: 'v1',
    },
  };
}
