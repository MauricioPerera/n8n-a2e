/**
 * Hybrid Search Engine — TF-IDF + Vector (RRF fusion)
 *
 * Combines keyword search (existing TF-IDF with Porter stemming + query expansion)
 * with semantic vector search (pre-computed e5-small embeddings in PolarQuantizedStore).
 *
 * Falls back gracefully to TF-IDF-only if no vector index exists.
 *
 * Zero runtime dependencies — js-vector-store.js is vanilla JS loaded via createRequire.
 */

import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { SearchEngine, tokenize, expandQuery, type SearchResult } from './tfidf.js';
import type { Entity } from '../types/entities.js';

// Eagerly try to import js-vector-store (vanilla JS, zero deps)
let _vectorModule: VectorStoreModule | null = null;
try {
  // @ts-ignore — vanilla JS module with default export
  const mod = await import('./js-vector-store.js');
  _vectorModule = mod.default as VectorStoreModule;
} catch {
  // js-vector-store not available — vector search disabled
}

// ─── Types for js-vector-store (loaded dynamically) ────────────────────────

interface PolarStore {
  search(col: string, query: number[] | Float32Array, limit?: number): { id: string; score: number; metadata: Record<string, unknown> }[];
  count(col: string): number;
  has(col: string, id: string): boolean;
}

interface VectorStoreModule {
  PolarQuantizedStore: new (dir: string, dim: number, opts?: { bits?: number; seed?: number }) => PolarStore;
  cosineSim: (a: number[], b: number[], dims?: number) => number;
}

// ─── Query Embedding Cache ─────────────────────────────────────────────────

interface QueryCache {
  model: string;
  dim: number;
  queries: Record<string, number[]>;
}

// ─── Hybrid Search Engine ──────────────────────────────────────────────────

export class HybridSearchEngine {
  private tfidf: SearchEngine;
  private nodeStore: PolarStore | null = null;
  private patternStore: PolarStore | null = null;
  private queryCache: QueryCache | null = null;
  private cosineSim: ((a: number[], b: number[], dims?: number) => number) | null = null;
  private entityMap: Map<string, Entity> = new Map();
  private vectorDir: string;

  constructor(vectorDir: string) {
    this.tfidf = new SearchEngine();
    this.vectorDir = vectorDir;
  }

  /** Build TF-IDF index and load vector stores if available */
  index(entities: Entity[]): void {
    // Build TF-IDF index (always works)
    this.tfidf.index(entities);

    // Build entity lookup map (n8nType/id → entity)
    this.entityMap.clear();
    for (const e of entities) {
      if (e.type === 'nodeDefinition') {
        this.entityMap.set((e as { n8nType: string }).n8nType, e);
      }
      this.entityMap.set(e.id, e);
    }

    // Try to load vector stores
    this.loadVectorStores();
  }

  /** Search with hybrid RRF fusion (or TF-IDF fallback) */
  search(query: string, limit = 20): SearchResult[] {
    const tfidfResults = this.tfidf.search(query, limit * 3);

    // If no vector stores, return TF-IDF only
    if (!this.nodeStore || !this.queryCache) {
      return tfidfResults.slice(0, limit);
    }

    // Get vector results
    const vectorResults = this.vectorSearch(query, limit * 3);

    // If vector search returned nothing, fall back to TF-IDF
    if (vectorResults.length === 0) {
      return tfidfResults.slice(0, limit);
    }

    // RRF fusion
    return this.rrfFuse(tfidfResults, vectorResults, limit);
  }

  /** Check if vector index is loaded */
  hasVectorIndex(): boolean {
    return this.nodeStore !== null && this.queryCache !== null;
  }

  // ─── Private Methods ───────────────────────────────────────────────────

  private loadVectorStores(): void {
    const vectorDir = this.vectorDir;

    // Check if vector files exist
    const nodesManifest = resolve(vectorDir, 'nodes.p3.json');
    const queriesPath = resolve(vectorDir, 'queries.json');

    if (!existsSync(nodesManifest) || !existsSync(queriesPath)) {
      this.nodeStore = null;
      this.patternStore = null;
      this.queryCache = null;
      return;
    }

    try {
      if (!_vectorModule) return;

      this.cosineSim = _vectorModule.cosineSim;

      // Load query cache
      const rawQueries = readFileSync(queriesPath, 'utf-8');
      this.queryCache = JSON.parse(rawQueries) as QueryCache;

      // Create PolarQuantizedStore instances (they auto-load from disk)
      this.nodeStore = new _vectorModule.PolarQuantizedStore(vectorDir, this.queryCache.dim, {
        bits: 3, seed: 42,
      });

      // Load pattern store if it exists
      const patternsManifest = resolve(vectorDir, 'patterns.p3.json');
      if (existsSync(patternsManifest)) {
        this.patternStore = new _vectorModule.PolarQuantizedStore(vectorDir, this.queryCache.dim, {
          bits: 3, seed: 42,
        });
      }
    } catch {
      // Vector search not available — degrade gracefully
      this.nodeStore = null;
      this.patternStore = null;
      this.queryCache = null;
    }
  }

  /** Find best matching pre-computed query embedding for the user's query */
  private findClosestQueryEmbedding(query: string): { phrase: string; embedding: number[] } | null {
    if (!this.queryCache || !this.cosineSim) return null;

    const queryTokens = new Set(expandQuery(tokenize(query)));
    let bestPhrase = '';
    let bestOverlap = 0;

    // Score each pre-computed phrase by token overlap with the user query
    for (const phrase of Object.keys(this.queryCache.queries)) {
      const phraseTokens = new Set(expandQuery(tokenize(phrase)));
      let overlap = 0;
      for (const t of queryTokens) {
        if (phraseTokens.has(t)) overlap++;
      }
      // Normalize by union size (Jaccard-like)
      const union = new Set([...queryTokens, ...phraseTokens]).size;
      const score = union > 0 ? overlap / union : 0;

      if (score > bestOverlap) {
        bestOverlap = score;
        bestPhrase = phrase;
      }
    }

    if (bestOverlap === 0 || !bestPhrase) return null;

    return {
      phrase: bestPhrase,
      embedding: this.queryCache.queries[bestPhrase],
    };
  }

  /** Search vector stores using the closest pre-computed query embedding */
  private vectorSearch(query: string, limit: number): SearchResult[] {
    const match = this.findClosestQueryEmbedding(query);
    if (!match) return [];

    const results: SearchResult[] = [];

    // Search node vectors
    if (this.nodeStore) {
      const nodeHits = this.nodeStore.search('nodes', match.embedding, limit);
      for (const hit of nodeHits) {
        const entity = this.entityMap.get(hit.id); // id is n8nType for nodes
        if (entity) {
          results.push({
            entity,
            score: hit.score,
            matchedTerms: [`vector:${match.phrase}`],
          });
        }
      }
    }

    // Search pattern vectors
    if (this.patternStore) {
      const patternHits = this.patternStore.search('patterns', match.embedding, limit);
      for (const hit of patternHits) {
        const entityId = (hit.metadata?.entityId as string) || hit.id;
        const entity = this.entityMap.get(entityId);
        if (entity) {
          results.push({
            entity,
            score: hit.score,
            matchedTerms: [`vector:${match.phrase}`],
          });
        }
      }
    }

    return results.sort((a, b) => b.score - a.score);
  }

  /**
   * Reciprocal Rank Fusion (RRF)
   * Combines two ranked lists into one using: score = Σ 1/(k + rank)
   * k=60 is standard (from the original RRF paper)
   */
  private rrfFuse(tfidfResults: SearchResult[], vectorResults: SearchResult[], limit: number): SearchResult[] {
    const k = 60;
    const scores = new Map<string, { score: number; entity: Entity; terms: string[] }>();

    // Helper to get a unique key for an entity
    const entityKey = (e: Entity): string => {
      if (e.type === 'nodeDefinition') return (e as { n8nType: string }).n8nType;
      return e.id;
    };

    // Score from TF-IDF rankings
    for (let i = 0; i < tfidfResults.length; i++) {
      const r = tfidfResults[i];
      const key = entityKey(r.entity);
      const existing = scores.get(key) ?? { score: 0, entity: r.entity, terms: [] };
      existing.score += 1 / (k + i + 1);
      existing.terms.push(...r.matchedTerms);
      scores.set(key, existing);
    }

    // Score from vector rankings
    for (let i = 0; i < vectorResults.length; i++) {
      const r = vectorResults[i];
      const key = entityKey(r.entity);
      const existing = scores.get(key) ?? { score: 0, entity: r.entity, terms: [] };
      existing.score += 1 / (k + i + 1);
      existing.terms.push(...r.matchedTerms);
      scores.set(key, existing);
    }

    return [...scores.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(s => ({
        entity: s.entity,
        score: s.score,
        matchedTerms: [...new Set(s.terms)],
      }));
  }
}
