/**
 * Credential Auto-Matcher
 *
 * Automatically binds credentials to workflow nodes by matching
 * NodeDefinition.credentials[].name against available credentials on the instance.
 *
 * This eliminates the need for the LLM to know credential IDs and ensures
 * workflows are immediately executable after deploy.
 */

import type { N8nWorkflow, N8nWorkflowNode } from '../types/workflow.js';
import type { NodeDefinition } from '../types/entities.js';

export interface CredentialBinding {
  /** Credential type (e.g. "gmailOAuth2Api") */
  type: string;
  /** Credential ID in n8n */
  id: string;
  /** Credential display name */
  name: string;
}

export interface CredentialMatchResult {
  /** The workflow with credentials injected */
  workflow: N8nWorkflow;
  /** Credentials that were auto-bound */
  bound: { node: string; credentialType: string; credentialName: string }[];
  /** Credentials that are required but missing from the instance */
  missing: { node: string; credentialType: string; required: boolean }[];
  /** Credentials the LLM already provided (left untouched) */
  preserved: { node: string; credentialType: string }[];
}

/**
 * Auto-match credentials for all nodes in a workflow.
 *
 * Strategy:
 * 1. If a node already has a credential binding (from LLM), keep it
 * 2. Look up the NodeDefinition to find required credential types
 * 3. Match against availableCredentials by type
 * 4. If multiple credentials match the same type, pick the first one
 */
export function matchCredentials(
  workflow: N8nWorkflow,
  nodeDefinitions: Map<string, NodeDefinition>,
  availableCredentials: CredentialBinding[]
): CredentialMatchResult {
  const bound: CredentialMatchResult['bound'] = [];
  const missing: CredentialMatchResult['missing'] = [];
  const preserved: CredentialMatchResult['preserved'] = [];

  // Index available credentials by type
  const credsByType = new Map<string, CredentialBinding[]>();
  for (const cred of availableCredentials) {
    if (!credsByType.has(cred.type)) credsByType.set(cred.type, []);
    credsByType.get(cred.type)!.push(cred);
  }

  // Process each node
  const updatedNodes = workflow.nodes.map(node => {
    const def = nodeDefinitions.get(node.type);
    if (!def || def.credentials.length === 0) return node;

    const nodeCredentials = { ...(node.credentials ?? {}) };
    let changed = false;

    for (const credDef of def.credentials) {
      // Already has this credential type bound?
      if (nodeCredentials[credDef.name]) {
        preserved.push({ node: node.name, credentialType: credDef.name });
        continue;
      }

      // Try to find a matching credential on the instance
      const matches = credsByType.get(credDef.name);
      if (matches && matches.length > 0) {
        // Pick the first available credential of this type
        const match = matches[0];
        nodeCredentials[credDef.name] = { id: match.id, name: match.name };
        bound.push({
          node: node.name,
          credentialType: credDef.name,
          credentialName: match.name,
        });
        changed = true;
      } else {
        missing.push({
          node: node.name,
          credentialType: credDef.name,
          required: credDef.required,
        });
      }
    }

    if (changed) {
      return { ...node, credentials: nodeCredentials } as N8nWorkflowNode;
    }
    return node;
  });

  return {
    workflow: { ...workflow, nodes: updatedNodes },
    bound,
    missing,
    preserved,
  };
}

/**
 * Fetch fresh credentials from n8n instance via API.
 * Returns them in CredentialBinding format ready for matching.
 */
export async function fetchCredentials(
  baseUrl: string,
  apiKey: string
): Promise<CredentialBinding[]> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/v1/credentials`, {
      headers: {
        'X-N8N-API-KEY': apiKey,
        'Accept': 'application/json',
      },
    });

    if (!res.ok) return [];

    const body = await res.json() as { data: { id: string; name: string; type: string }[] };
    return (body.data ?? []).map(c => ({
      type: c.type,
      id: c.id,
      name: c.name,
    }));
  } catch {
    return [];
  }
}
