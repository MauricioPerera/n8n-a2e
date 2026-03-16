/**
 * n8n REST API Client
 * Handles CRUD operations for workflows against a running n8n instance.
 */

import type { N8nWorkflow } from '../types/workflow.js';

export interface N8nClientConfig {
  baseUrl: string;
  apiKey: string;
}

interface PaginatedResponse<T> {
  data: T[];
  nextCursor?: string;
}

export class N8nClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(config: N8nClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}/api/v1${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        'X-N8N-API-KEY': this.apiKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`n8n API ${method} ${path} failed (${res.status}): ${text}`);
    }

    return res.json() as Promise<T>;
  }

  // ─── Workflows ──────────────────────────────────────────────────────────

  /** Create a new workflow (starts inactive) */
  async createWorkflow(workflow: N8nWorkflow): Promise<N8nWorkflow> {
    // Remove read-only fields before sending
    const { id, active, createdAt, updatedAt, tags, ...payload } = workflow as N8nWorkflow & { createdAt?: string; updatedAt?: string };
    return this.request<N8nWorkflow>('POST', '/workflows', payload);
  }

  /** Get a workflow by ID */
  async getWorkflow(id: string): Promise<N8nWorkflow> {
    return this.request<N8nWorkflow>('GET', `/workflows/${id}`);
  }

  /** List workflows with optional filters */
  async listWorkflows(params?: {
    active?: boolean;
    tags?: string;
    name?: string;
    limit?: number;
    cursor?: string;
  }): Promise<PaginatedResponse<N8nWorkflow>> {
    const query = new URLSearchParams();
    if (params?.active !== undefined) query.set('active', String(params.active));
    if (params?.tags) query.set('tags', params.tags);
    if (params?.name) query.set('name', params.name);
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.cursor) query.set('cursor', params.cursor);
    const qs = query.toString();
    return this.request<PaginatedResponse<N8nWorkflow>>(
      'GET',
      `/workflows${qs ? '?' + qs : ''}`
    );
  }

  /** Update a workflow */
  async updateWorkflow(id: string, workflow: Partial<N8nWorkflow>): Promise<N8nWorkflow> {
    return this.request<N8nWorkflow>('PUT', `/workflows/${id}`, workflow);
  }

  /** Delete a workflow */
  async deleteWorkflow(id: string): Promise<void> {
    await this.request<void>('DELETE', `/workflows/${id}`);
  }

  /** Activate a workflow */
  async activateWorkflow(id: string): Promise<N8nWorkflow> {
    return this.request<N8nWorkflow>('POST', `/workflows/${id}/activate`);
  }

  /** Deactivate a workflow */
  async deactivateWorkflow(id: string): Promise<N8nWorkflow> {
    return this.request<N8nWorkflow>('POST', `/workflows/${id}/deactivate`);
  }

  // ─── Executions ─────────────────────────────────────────────────────────

  /** List executions for a workflow */
  async listExecutions(workflowId: string, limit = 10): Promise<PaginatedResponse<unknown>> {
    return this.request<PaginatedResponse<unknown>>(
      'GET',
      `/executions?workflowId=${workflowId}&limit=${limit}`
    );
  }

  // ─── Health ─────────────────────────────────────────────────────────────

  /** Check if the n8n instance is reachable */
  async healthCheck(): Promise<boolean> {
    try {
      await this.request<unknown>('GET', '/workflows?limit=1');
      return true;
    } catch {
      return false;
    }
  }
}
