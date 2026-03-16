/**
 * Workflow Validator
 *
 * Validates a composed workflow JSON before sending to n8n API.
 * Checks: required params, connection integrity, trigger presence, credential bindings.
 */

import type { N8nWorkflow } from '../types/workflow.js';
import type { NodeDefinition } from '../types/entities.js';

export interface ValidationError {
  severity: 'error' | 'warning';
  node?: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationError[];
}

export function validateWorkflow(
  workflow: N8nWorkflow,
  nodeDefinitions: Map<string, NodeDefinition>
): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];

  // 1. Must have at least one node
  if (workflow.nodes.length === 0) {
    errors.push({ severity: 'error', message: 'Workflow has no nodes' });
  }

  // 2. Must have a name
  if (!workflow.name?.trim()) {
    errors.push({ severity: 'error', message: 'Workflow must have a name' });
  }

  // 3. Check for trigger node
  const hasTrigger = workflow.nodes.some(n => {
    const def = nodeDefinitions.get(n.type);
    return def?.category === 'trigger' || n.type.toLowerCase().includes('trigger');
  });
  if (!hasTrigger) {
    warnings.push({
      severity: 'warning',
      message: 'Workflow has no trigger node. It can only be executed manually.',
    });
  }

  // 4. Check each node
  const nodeNames = new Set<string>();
  for (const node of workflow.nodes) {
    // Duplicate names
    if (nodeNames.has(node.name)) {
      errors.push({
        severity: 'error',
        node: node.name,
        message: `Duplicate node name: "${node.name}"`,
      });
    }
    nodeNames.add(node.name);

    // Check node type exists in definitions
    const def = nodeDefinitions.get(node.type);
    if (!def) {
      warnings.push({
        severity: 'warning',
        node: node.name,
        message: `Node type "${node.type}" not found in extracted definitions`,
      });
      continue;
    }

    // Check required parameters
    for (const prop of def.properties) {
      if (prop.required && !(prop.name in (node.parameters ?? {}))) {
        // Skip if there's a displayOptions condition (might not be visible)
        if (!prop.displayOptions) {
          errors.push({
            severity: 'error',
            node: node.name,
            message: `Missing required parameter: "${prop.displayName}" (${prop.name})`,
          });
        }
      }
    }

    // Check credentials
    for (const cred of def.credentials) {
      if (cred.required && !node.credentials?.[cred.name]) {
        warnings.push({
          severity: 'warning',
          node: node.name,
          message: `Missing credential: "${cred.name}"`,
        });
      }
    }
  }

  // 5. Check connection integrity
  for (const [sourceName, connTypes] of Object.entries(workflow.connections)) {
    if (!nodeNames.has(sourceName)) {
      errors.push({
        severity: 'error',
        message: `Connection references non-existent source node: "${sourceName}"`,
      });
    }
    for (const outputs of Object.values(connTypes)) {
      for (const connections of outputs) {
        for (const conn of connections) {
          if (!nodeNames.has(conn.node)) {
            errors.push({
              severity: 'error',
              message: `Connection references non-existent target node: "${conn.node}"`,
            });
          }
        }
      }
    }
  }

  // 6. Check for orphan nodes (no connections)
  const connected = new Set<string>();
  for (const [source, connTypes] of Object.entries(workflow.connections)) {
    connected.add(source);
    for (const outputs of Object.values(connTypes)) {
      for (const connections of outputs) {
        for (const conn of connections) {
          connected.add(conn.node);
        }
      }
    }
  }
  for (const node of workflow.nodes) {
    if (!connected.has(node.name) && workflow.nodes.length > 1) {
      warnings.push({
        severity: 'warning',
        node: node.name,
        message: `Node "${node.name}" is not connected to any other node`,
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
