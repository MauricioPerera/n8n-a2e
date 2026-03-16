/**
 * n8n-a2e Entity Types
 *
 * Inspired by RepoMemory v2's 5 primitives, adapted for n8n workflow composition.
 * Maps: Knowledge→NodeDefinition, Skills→WorkflowPattern, Memories→ExecutionContext,
 *       Sessions→ConversationHistory, Profiles→N8nInstance
 */

// ─── Base ────────────────────────────────────────────────────────────────────

export interface BaseEntity {
  id: string;
  createdAt: string;
  updatedAt: string;
  tags: string[];
}

// ─── NodeDefinition (replaces Knowledge) ─────────────────────────────────────
// Stores the extracted JSON schema of each n8n node

export type NodeCategory =
  | 'trigger'
  | 'action'
  | 'transform'
  | 'flow'       // IF, Switch, Merge, SplitInBatches
  | 'ai'         // LangChain, Agent, Tool nodes
  | 'output'
  | 'input'
  | 'utility';

export interface NodeParam {
  name: string;
  displayName: string;
  type: string;           // 'string' | 'number' | 'boolean' | 'options' | 'collection' | etc.
  default: unknown;
  required: boolean;
  description: string;
  options?: NodeParamOption[];
  displayOptions?: Record<string, unknown>;
}

export interface NodeParamOption {
  name: string;
  value: string | number | boolean;
  description?: string;
}

export interface NodeCredential {
  name: string;
  required: boolean;
  displayName?: string;
}

export interface NodeInput {
  type: string;     // 'main' | 'ai_tool' | 'ai_languageModel' | 'ai_memory' | etc.
  displayName?: string;
  required?: boolean;
  maxConnections?: number;
}

export interface NodeOutput {
  type: string;
  displayName?: string;
}

export interface NodeDefinition extends BaseEntity {
  type: 'nodeDefinition';
  /** Internal n8n type name, e.g. "n8n-nodes-base.slack" */
  n8nType: string;
  /** Human-readable name, e.g. "Slack" */
  displayName: string;
  /** Node version(s) */
  version: number[];
  /** Category for quick filtering */
  category: NodeCategory;
  /** Group from n8n, e.g. ['trigger'] */
  group: string[];
  /** One-line description */
  description: string;
  /** Node inputs */
  inputs: NodeInput[];
  /** Node outputs */
  outputs: NodeOutput[];
  /** Configurable parameters */
  properties: NodeParam[];
  /** Required credentials */
  credentials: NodeCredential[];
  /** Default values for the node */
  defaults: Record<string, unknown>;
  /** Icon reference */
  icon?: string;
  /** Subtitle expression */
  subtitle?: string;
  /** Documentation URL */
  documentationUrl?: string;
  /** Whether node can be used as AI tool */
  usableAsTool?: boolean;
}

// ─── WorkflowPattern (replaces Skills) ───────────────────────────────────────
// Stores proven workflow patterns / templates

export type PatternStatus = 'proven' | 'experimental' | 'deprecated';

export interface PatternNode {
  /** Reference to NodeDefinition.n8nType */
  n8nType: string;
  /** Display label in this pattern */
  label: string;
  /** Pre-filled parameters */
  parameters: Record<string, unknown>;
  /** Position hint */
  position: [number, number];
}

export interface PatternConnection {
  from: { node: string; output: number };
  to: { node: string; input: number };
  type?: string; // defaults to 'main'
}

export interface WorkflowPattern extends BaseEntity {
  type: 'workflowPattern';
  /** Pattern name, e.g. "Email attachment to cloud storage with notification" */
  name: string;
  /** Natural language description of what this pattern does */
  description: string;
  /** Use cases this pattern solves */
  useCases: string[];
  /** Nodes involved (by n8nType) */
  nodes: PatternNode[];
  /** How nodes connect */
  connections: PatternConnection[];
  /** Status */
  status: PatternStatus;
  /** How many times this pattern was used successfully */
  successCount: number;
  /** How many times it failed */
  failCount: number;
}

// ─── ExecutionContext (replaces Memories) ─────────────────────────────────────
// Stores facts, errors, fixes learned from workflow executions

export type ContextCategory = 'error' | 'fix' | 'optimization' | 'credential_issue' | 'api_change';

export interface ExecutionContext extends BaseEntity {
  type: 'executionContext';
  category: ContextCategory;
  /** Which node type this relates to */
  n8nType: string;
  /** What happened / what was learned */
  content: string;
  /** The fix or workaround if applicable */
  resolution?: string;
  /** Relevance score (decays over time) */
  relevance: number;
}

// ─── N8nInstance (replaces Profiles) ─────────────────────────────────────────
// Stores connection info for one or more n8n instances

export interface N8nInstance extends BaseEntity {
  type: 'n8nInstance';
  /** Friendly name */
  name: string;
  /** Base URL, e.g. "http://localhost:5678" */
  baseUrl: string;
  /** API key (stored, not embedded in code) */
  apiKey: string;
  /** Available node types on this instance (populated by discovery) */
  availableNodes: string[];
  /** Configured credentials on this instance */
  availableCredentials: { type: string; name: string; id: string }[];
  /** n8n version */
  version?: string;
}

// ─── Union & Maps ────────────────────────────────────────────────────────────

export type Entity = NodeDefinition | WorkflowPattern | ExecutionContext | N8nInstance;
export type EntityType = Entity['type'];

export const ENTITY_TYPES: EntityType[] = [
  'nodeDefinition',
  'workflowPattern',
  'executionContext',
  'n8nInstance',
];
