/**
 * Simple HTTP server for n8n-a2e Web UI.
 * Zero dependencies — uses Node.js built-in http module.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../storage/store.js';
import { Orchestrator } from '../agent/orchestrator.js';
import { WorkflowAgent } from '../llm/agent.js';
import { createProvider, type ProviderType } from '../llm/provider.js';
import type { N8nInstance } from '../types/entities.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface WebConfig {
  port?: number;
  storePath: string;
  instance?: N8nInstance;
  llmProvider: ProviderType;
  llmConfig: Record<string, unknown>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

function html(res: ServerResponse, content: string) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(content);
}

export function startWebServer(config: WebConfig) {
  const port = config.port ?? 3000;

  // Initialize store + orchestrator
  const store = new Store({ root: config.storePath });
  const orchestrator = new Orchestrator({
    store,
    instance: config.instance,
  });
  orchestrator.initialize();

  const stats = orchestrator.stats();
  console.log(`Store: ${stats.nodes} nodes, ${stats.patterns} patterns`);

  // Create LLM provider
  const llm = createProvider(config.llmProvider, config.llmConfig);
  console.log(`LLM: ${config.llmProvider}`);

  // Create agent
  const agent = new WorkflowAgent(llm, orchestrator, store);

  // Load HTML template
  const htmlPath = join(__dirname, 'index.html');
  let indexHtml: string;
  try {
    indexHtml = readFileSync(htmlPath, 'utf-8');
  } catch {
    // In dist/, look for the file relative to source
    const srcHtmlPath = join(__dirname, '..', '..', 'src', 'web', 'index.html');
    indexHtml = readFileSync(srcHtmlPath, 'utf-8');
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    try {
      // Serve UI
      if (url.pathname === '/' && req.method === 'GET') {
        html(res, indexHtml);
        return;
      }

      // Chat endpoint
      if (url.pathname === '/api/chat' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const message = body.message as string;

        if (!message?.trim()) {
          json(res, { error: 'Message is required' }, 400);
          return;
        }

        const response = await agent.chat(message);
        json(res, {
          message: response.message,
          action: response.action,
          workflow: response.workflow ?? null,
          deployResult: response.deployResult ?? null,
          nodeCount: response.workflow?.nodes?.length ?? 0,
        });
        return;
      }

      // Stats endpoint
      if (url.pathname === '/api/stats' && req.method === 'GET') {
        const s = orchestrator.stats();
        json(res, {
          nodes: s.nodes,
          patterns: s.patterns,
          provider: config.llmProvider,
        });
        return;
      }

      // Reset endpoint
      if (url.pathname === '/api/reset' && req.method === 'POST') {
        await agent.chat('/reset');
        json(res, { ok: true });
        return;
      }

      // 404
      json(res, { error: 'Not found' }, 404);
    } catch (err) {
      console.error('Request error:', err);
      json(res, { error: err instanceof Error ? err.message : 'Internal error' }, 500);
    }
  });

  server.listen(port, () => {
    console.log(`\nn8n-a2e Web UI: http://localhost:${port}\n`);
  });

  return server;
}
