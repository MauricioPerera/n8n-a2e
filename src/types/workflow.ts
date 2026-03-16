/**
 * n8n Workflow JSON types
 * Mirrors the structure expected by the n8n REST API
 */

export interface N8nWorkflowNode {
  id: string;
  name: string;
  type: string;
  typeVersion: number;
  position: [number, number];
  parameters: Record<string, unknown>;
  credentials?: Record<string, { id: string; name: string }>;
  disabled?: boolean;
  executeOnce?: boolean;
  alwaysOutputData?: boolean;
  retryOnFail?: boolean;
  maxTries?: number;
  waitBetweenTries?: number;
  onError?: 'stopWorkflow' | 'continueRegularOutput' | 'continueErrorOutput';
  notes?: string;
  notesInFlow?: boolean;
  webhookId?: string;
}

export interface N8nConnection {
  node: string;
  type: string;
  index: number;
}

/** connections[sourceNodeName][connectionType][outputIndex] = N8nConnection[] */
export type N8nConnections = Record<
  string,
  Record<string, N8nConnection[][]>
>;

export interface N8nWorkflowSettings {
  saveExecutionProgress?: boolean;
  saveManualExecutions?: boolean;
  saveDataErrorExecution?: 'all' | 'none';
  saveDataSuccessExecution?: 'all' | 'none';
  executionTimeout?: number;
  errorWorkflow?: string;
  timezone?: string;
  executionOrder?: 'v0' | 'v1';
}

export interface N8nWorkflow {
  id?: string;
  name: string;
  active?: boolean;
  nodes: N8nWorkflowNode[];
  connections: N8nConnections;
  settings?: N8nWorkflowSettings;
  staticData?: unknown;
  tags?: { id: string; name: string }[];
  pinData?: Record<string, unknown>;
}

export interface N8nApiResponse<T> {
  data: T;
  nextCursor?: string;
}
