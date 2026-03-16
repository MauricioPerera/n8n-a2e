/**
 * Node Definition Extractor - from existing n8n workflows
 *
 * Analyzes workflow JSONs (from the API or from exported files)
 * to discover and catalog the node types that are actually in use.
 * Useful when you can read workflows but can't access /types/nodes.json.
 */

import type { NodeDefinition, NodeCategory } from '../types/entities.js';
import type { N8nWorkflow, N8nWorkflowNode } from '../types/workflow.js';
import { randomUUID } from 'node:crypto';

function inferCategory(node: N8nWorkflowNode): NodeCategory {
  const type = node.type.toLowerCase();
  if (type.includes('trigger') || type.includes('webhook') || type.includes('cron') || type.includes('schedule')) return 'trigger';
  if (type.includes('if') || type.includes('switch') || type.includes('merge') || type.includes('splitinbatches') || type.includes('filter')) return 'flow';
  if (type.includes('langchain') || type.includes('agent') || type.includes('lmchat') || type.includes('openai')) return 'ai';
  if (type.includes('code') || type.includes('function') || type.includes('set') || type.includes('datetime')) return 'utility';
  return 'action';
}

/**
 * Extract node definitions by analyzing workflow JSONs.
 * Deduplicates by n8nType, merging parameter info from all instances.
 */
export function extractFromWorkflows(workflows: N8nWorkflow[]): NodeDefinition[] {
  const nodeMap = new Map<string, {
    type: string;
    displayName: string;
    category: NodeCategory;
    version: Set<number>;
    paramKeys: Set<string>;
    credTypes: Set<string>;
    count: number;
  }>();

  for (const wf of workflows) {
    for (const node of wf.nodes) {
      const existing = nodeMap.get(node.type);

      if (existing) {
        existing.version.add(node.typeVersion);
        existing.count++;
        // Merge parameter keys
        if (node.parameters) {
          for (const key of Object.keys(node.parameters)) {
            existing.paramKeys.add(key);
          }
        }
        // Merge credential types
        if (node.credentials) {
          for (const credType of Object.keys(node.credentials)) {
            existing.credTypes.add(credType);
          }
        }
      } else {
        const paramKeys = new Set(Object.keys(node.parameters ?? {}));
        const credTypes = new Set(Object.keys(node.credentials ?? {}));
        const nameParts = node.type.split('.');
        const shortName = nameParts[nameParts.length - 1];

        nodeMap.set(node.type, {
          type: node.type,
          displayName: shortName.charAt(0).toUpperCase() + shortName.slice(1),
          category: inferCategory(node),
          version: new Set([node.typeVersion]),
          paramKeys,
          credTypes,
          count: 1,
        });
      }
    }
  }

  const now = new Date().toISOString();
  const definitions: NodeDefinition[] = [];

  for (const [n8nType, info] of nodeMap) {
    definitions.push({
      id: randomUUID(),
      type: 'nodeDefinition',
      createdAt: now,
      updatedAt: now,
      tags: [info.category, info.displayName.toLowerCase()],
      n8nType,
      displayName: info.displayName,
      version: [...info.version].sort(),
      category: info.category,
      group: info.category === 'trigger' ? ['trigger'] : [],
      description: `${info.displayName} node (discovered from ${info.count} workflow instance(s))`,
      inputs: [{ type: 'main' }],
      outputs: [{ type: 'main' }],
      properties: [...info.paramKeys].map(key => ({
        name: key,
        displayName: key.charAt(0).toUpperCase() + key.slice(1).replace(/([A-Z])/g, ' $1'),
        type: 'string',
        default: null,
        required: false,
        description: `Parameter discovered from workflows`,
      })),
      credentials: [...info.credTypes].map(cred => ({
        name: cred,
        required: true,
      })),
      defaults: { name: info.displayName },
    });
  }

  return definitions;
}
