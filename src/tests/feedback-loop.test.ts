/**
 * Tests for the RepoMemory-style feedback loop:
 * - CircuitBreaker with enriched error reasons
 * - Anti-pattern context injection
 * - Interactive mode (WorkflowAgent) feedback integration
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { Store } from '../storage/store.js';
import { CircuitBreaker, type CircuitBreakerResult } from '../autonomous/circuit-breaker.js';
import type { ExecutionContext } from '../types/entities.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTempStore(): { store: Store; root: string } {
  const root = join(tmpdir(), `n8n-a2e-test-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  const store = new Store({ root });
  return { store, root };
}

function cleanupStore(root: string): void {
  if (existsSync(root)) {
    rmSync(root, { recursive: true, force: true });
  }
}

// ─── CircuitBreaker Tests ──────────────────────────────────────────────────

describe('CircuitBreaker', () => {
  let store: Store;
  let root: string;

  before(() => {
    const tmp = createTempStore();
    store = tmp.store;
    root = tmp.root;
  });

  after(() => {
    cleanupStore(root);
  });

  it('should start with circuit closed (no errors)', () => {
    const cb = new CircuitBreaker(store);
    const result = cb.check('n8n-nodes-base.slack');
    assert.equal(result.open, false);
    assert.equal(result.errorCount, 0);
    assert.deepEqual(result.reasons, []);
    assert.deepEqual(result.resolutions, []);
  });

  it('should open circuit after threshold errors', () => {
    const cb = new CircuitBreaker(store, 3);
    cb.recordError('n8n-nodes-base.slack', 'Auth failed');
    cb.recordError('n8n-nodes-base.slack', 'Rate limited');
    cb.recordError('n8n-nodes-base.slack', 'Token expired');

    const result = cb.check('n8n-nodes-base.slack');
    assert.equal(result.open, true);
    assert.equal(result.errorCount, 3);
  });

  it('should include error reasons in check result', () => {
    const cb = new CircuitBreaker(store, 3);
    cb.recordError('n8n-nodes-base.httpRequest', 'Invalid URL format');
    cb.recordError('n8n-nodes-base.httpRequest', '404 Not Found');

    const result = cb.check('n8n-nodes-base.httpRequest');
    assert.equal(result.reasons.length, 2);
    assert.ok(result.reasons.includes('Invalid URL format'));
    assert.ok(result.reasons.includes('404 Not Found'));
  });

  it('should include reasons in the message when circuit is open', () => {
    const cb = new CircuitBreaker(store, 2);
    cb.recordError('n8n-nodes-base.gmail', 'Missing OAuth scope');
    cb.recordError('n8n-nodes-base.gmail', 'Credential not found');

    const result = cb.check('n8n-nodes-base.gmail');
    assert.equal(result.open, true);
    assert.ok(result.message.includes('Reasons:'));
    assert.ok(result.message.includes('Missing OAuth scope'));
  });

  it('should track known resolutions', () => {
    const cb = new CircuitBreaker(store, 5);
    cb.recordError('n8n-nodes-base.postgres', 'Connection refused', 'Use host.docker.internal instead of localhost');

    const result = cb.check('n8n-nodes-base.postgres');
    assert.equal(result.resolutions.length, 1);
    assert.equal(result.resolutions[0], 'Use host.docker.internal instead of localhost');
  });

  it('should not duplicate resolutions', () => {
    const cb = new CircuitBreaker(store, 5);
    cb.recordError('n8n-nodes-base.mysql', 'Timeout', 'Increase timeout to 30s');
    cb.recordError('n8n-nodes-base.mysql', 'Timeout again', 'Increase timeout to 30s');

    const result = cb.check('n8n-nodes-base.mysql');
    assert.equal(result.resolutions.length, 1);
  });

  it('should reset error count on success', () => {
    const cb = new CircuitBreaker(store, 3);
    cb.recordError('n8n-nodes-base.webhook', 'Error 1');
    cb.recordError('n8n-nodes-base.webhook', 'Error 2');
    assert.equal(cb.check('n8n-nodes-base.webhook').errorCount, 2);

    cb.recordSuccess('n8n-nodes-base.webhook');
    assert.equal(cb.check('n8n-nodes-base.webhook').errorCount, 0);
    assert.equal(cb.check('n8n-nodes-base.webhook').open, false);
  });

  it('should limit reasons to last 3 in check result', () => {
    const cb = new CircuitBreaker(store, 10);
    for (let i = 1; i <= 5; i++) {
      cb.recordError('n8n-nodes-base.ftp', `Error ${i}`);
    }

    const result = cb.check('n8n-nodes-base.ftp');
    assert.equal(result.reasons.length, 3);
    assert.ok(result.reasons.includes('Error 3'));
    assert.ok(result.reasons.includes('Error 4'));
    assert.ok(result.reasons.includes('Error 5'));
  });

  it('checkPlan should return only blocked types', () => {
    const cb = new CircuitBreaker(store, 2);
    cb.recordError('n8n-nodes-base.typeA', 'err');
    cb.recordError('n8n-nodes-base.typeA', 'err');
    // typeB has no errors

    const blocked = cb.checkPlan(['n8n-nodes-base.typeA', 'n8n-nodes-base.typeB']);
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0].target, 'n8n-nodes-base.typeA');
  });

  it('extractHost should parse URLs correctly', () => {
    assert.equal(CircuitBreaker.extractHost('https://api.example.com/v1'), 'api.example.com');
    assert.equal(CircuitBreaker.extractHost('http://localhost:5678'), 'localhost');
    assert.equal(CircuitBreaker.extractHost('not-a-url'), null);
  });
});

// ─── Anti-Pattern Tests ───────────────────────────────────────────────────────

describe('CircuitBreaker.getAntiPatterns', () => {
  let store: Store;
  let root: string;

  before(() => {
    const tmp = createTempStore();
    store = tmp.store;
    root = tmp.root;
  });

  after(() => {
    cleanupStore(root);
  });

  it('should return empty array when no errors', () => {
    const cb = new CircuitBreaker(store);
    const patterns = cb.getAntiPatterns();
    assert.equal(patterns.length, 0);
  });

  it('should return error/resolution pairs', () => {
    const cb = new CircuitBreaker(store);
    cb.recordError('n8n-nodes-base.slack', 'Missing bot token', 'Add xoxb- token in credentials');

    const patterns = cb.getAntiPatterns();
    assert.equal(patterns.length, 1);
    assert.equal(patterns[0].target, 'n8n-nodes-base.slack');
    assert.equal(patterns[0].error, 'Missing bot token');
    assert.equal(patterns[0].resolution, 'Add xoxb- token in credentials');
  });

  it('should deduplicate anti-patterns', () => {
    const cb = new CircuitBreaker(store);
    cb.recordError('n8n-nodes-base.httpRequest', 'Invalid URL');
    cb.recordError('n8n-nodes-base.httpRequest', 'Invalid URL');

    const patterns = cb.getAntiPatterns();
    // Should be deduplicated based on target + error prefix
    const httpPatterns = patterns.filter(p => p.target === 'n8n-nodes-base.httpRequest');
    assert.equal(httpPatterns.length, 1);
  });

  it('should respect maxItems limit', () => {
    const cb = new CircuitBreaker(store, 100);
    for (let i = 0; i < 20; i++) {
      cb.recordError(`type-${i}`, `Error for type ${i}`);
    }

    const patterns = cb.getAntiPatterns(5);
    assert.ok(patterns.length <= 5);
  });

  it('should include fix-only entries (no error, just resolution)', () => {
    const tmp = createTempStore();
    const freshStore = tmp.store;

    // Save a 'fix' context directly to the store
    const fixCtx: ExecutionContext = {
      id: randomUUID(),
      type: 'executionContext',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tags: ['a2e-fix'],
      category: 'fix',
      n8nType: 'n8n-nodes-base.merge',
      content: 'Merge node needs mode parameter',
      resolution: 'Always set mode to "combine" or "append"',
      relevance: 1.0,
    };
    freshStore.save(fixCtx);

    const cb = new CircuitBreaker(freshStore);
    const patterns = cb.getAntiPatterns();
    const mergePattern = patterns.find(p => p.target === 'n8n-nodes-base.merge');
    assert.ok(mergePattern, 'Should include fix-only pattern for merge node');
    assert.equal(mergePattern!.resolution, 'Always set mode to "combine" or "append"');

    cleanupStore(tmp.root);
  });
});

// ─── Store Persistence Tests ──────────────────────────────────────────────────

describe('CircuitBreaker persistence', () => {
  it('should load errors from stored ExecutionContexts', () => {
    const tmp = createTempStore();

    // Pre-populate store with error contexts
    for (let i = 0; i < 3; i++) {
      const ctx: ExecutionContext = {
        id: randomUUID(),
        type: 'executionContext',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tags: ['a2e-error', 'n8n-nodes-base.discord'],
        category: 'error',
        n8nType: 'n8n-nodes-base.discord',
        content: `Discord error ${i}`,
        relevance: 1.0,
      };
      tmp.store.save(ctx);
    }

    // Create a new circuit breaker — it should load from store
    const cb = new CircuitBreaker(tmp.store, 3);
    const result = cb.check('n8n-nodes-base.discord');
    assert.equal(result.open, true, 'Circuit should be open after 3 stored errors');
    assert.equal(result.errorCount, 3);

    cleanupStore(tmp.root);
  });

  it('should load resolutions from stored fix contexts', () => {
    const tmp = createTempStore();

    const ctx: ExecutionContext = {
      id: randomUUID(),
      type: 'executionContext',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tags: ['a2e-error'],
      category: 'error',
      n8nType: 'n8n-nodes-base.telegram',
      content: 'Bot token invalid',
      resolution: 'Regenerate token from BotFather',
      relevance: 1.0,
    };
    tmp.store.save(ctx);

    const cb = new CircuitBreaker(tmp.store);
    const result = cb.check('n8n-nodes-base.telegram');
    assert.equal(result.resolutions.length, 1);
    assert.equal(result.resolutions[0], 'Regenerate token from BotFather');

    cleanupStore(tmp.root);
  });

  it('should persist new errors to the store', () => {
    const tmp = createTempStore();
    const cb = new CircuitBreaker(tmp.store);

    cb.recordError('n8n-nodes-base.airtable', 'API key invalid');

    // Verify it was saved to the store
    const contexts = tmp.store.list<ExecutionContext>('executionContext');
    const airtableErrors = contexts.filter(
      c => c.n8nType === 'n8n-nodes-base.airtable' && c.category === 'error'
    );
    assert.equal(airtableErrors.length, 1);
    assert.equal(airtableErrors[0].content, 'API key invalid');

    cleanupStore(tmp.root);
  });
});

// ─── Integration: Anti-pattern context format ─────────────────────────────────

describe('Anti-pattern context format for LLM', () => {
  it('should produce LLM-injectable context string', () => {
    const tmp = createTempStore();
    const cb = new CircuitBreaker(tmp.store);

    cb.recordError('@n8n/n8n-nodes-langchain.mcpClientTool', 'Wrong type name used: toolMcp', 'Correct type is mcpClientTool');
    cb.recordError('n8n-nodes-base.executeWorkflow', 'Workflow not found', 'Use workflowId parameter, not name');

    const antiPatterns = cb.getAntiPatterns(10);

    // Build the context string as the agent does
    let context = '';
    if (antiPatterns.length > 0) {
      context = '\n\n## Known Issues (avoid these mistakes)\n';
      for (const ap of antiPatterns) {
        context += `- ${ap.target}: ${ap.error}`;
        if (ap.resolution) context += ` -> Fix: ${ap.resolution}`;
        context += '\n';
      }
    }

    assert.ok(context.includes('mcpClientTool'));
    assert.ok(context.includes('Wrong type name used'));
    assert.ok(context.includes('Correct type is mcpClientTool'));
    assert.ok(context.includes('executeWorkflow'));
    assert.ok(context.includes('Known Issues'));

    cleanupStore(tmp.root);
  });

  it('should include both errors and resolutions for blocked nodes', () => {
    const tmp = createTempStore();
    const cb = new CircuitBreaker(tmp.store, 2);

    cb.recordError('n8n-nodes-base.slack', 'Channel not found', 'Use channel ID not name');
    cb.recordError('n8n-nodes-base.slack', 'Missing scope: chat:write');

    const result = cb.check('n8n-nodes-base.slack');
    assert.equal(result.open, true);
    assert.ok(result.message.includes('Circuit OPEN'));
    assert.ok(result.reasons.length > 0);
    assert.ok(result.resolutions.length > 0);

    // Simulate what requestAlternatives() does
    let detail = `- ${result.target}: ${result.message}`;
    if (result.resolutions.length > 0) {
      detail += `\n  Known fixes: ${result.resolutions.join('; ')}`;
    }
    assert.ok(detail.includes('Known fixes'));
    assert.ok(detail.includes('Use channel ID not name'));

    cleanupStore(tmp.root);
  });
});
