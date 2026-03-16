/**
 * TF-IDF Search Engine for NodeDefinitions and WorkflowPatterns
 * Zero dependencies, Porter stemming, query expansion.
 */

import type { NodeDefinition, WorkflowPattern, Entity } from '../types/entities.js';

// ─── Porter Stemmer (simplified) ─────────────────────────────────────────────

const STEP2_SUFFIXES: [string, string][] = [
  ['ational', 'ate'], ['tional', 'tion'], ['enci', 'ence'], ['anci', 'ance'],
  ['izer', 'ize'], ['alli', 'al'], ['entli', 'ent'], ['eli', 'e'],
  ['ousli', 'ous'], ['ization', 'ize'], ['ation', 'ate'], ['ator', 'ate'],
  ['alism', 'al'], ['iveness', 'ive'], ['fulness', 'ful'], ['ousness', 'ous'],
  ['aliti', 'al'], ['iviti', 'ive'], ['biliti', 'ble'],
];

function stem(word: string): string {
  if (word.length < 3) return word;
  let w = word.toLowerCase();

  // Step 1a
  if (w.endsWith('sses')) w = w.slice(0, -2);
  else if (w.endsWith('ies')) w = w.slice(0, -2);
  else if (!w.endsWith('ss') && w.endsWith('s')) w = w.slice(0, -1);

  // Step 1b (simplified)
  if (w.endsWith('eed')) {
    w = w.slice(0, -1);
  } else if (w.endsWith('ed') && /[aeiou]/.test(w.slice(0, -2))) {
    w = w.slice(0, -2);
  } else if (w.endsWith('ing') && /[aeiou]/.test(w.slice(0, -3))) {
    w = w.slice(0, -3);
  }

  // Step 2 (simplified)
  for (const [suffix, replacement] of STEP2_SUFFIXES) {
    if (w.endsWith(suffix)) {
      w = w.slice(0, -suffix.length) + replacement;
      break;
    }
  }

  return w;
}

// ─── Tokenizer ───────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'and', 'or', 'but', 'if',
  'then', 'else', 'when', 'at', 'by', 'for', 'with', 'about', 'against',
  'between', 'through', 'during', 'before', 'after', 'above', 'below',
  'to', 'from', 'up', 'down', 'in', 'out', 'on', 'off', 'over', 'under',
  'of', 'no', 'not', 'this', 'that', 'these', 'those', 'it', 'its',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w))
    .map(stem);
}

// ─── Query Expansion (synonyms/abbreviations for n8n domain) ─────────────────

const EXPANSIONS: Record<string, string[]> = {
  'email': ['gmail', 'smtp', 'imap', 'mail', 'outlook', 'sendgrid'],
  'chat': ['slack', 'discord', 'telegram', 'mattermost', 'teams'],
  'database': ['mysql', 'postgres', 'mongodb', 'redis', 'sqlite', 'mariadb'],
  'file': ['ftp', 'sftp', 's3', 'drive', 'dropbox', 'onedrive'],
  'spreadsheet': ['sheets', 'excel', 'csv', 'airtable'],
  'crm': ['salesforce', 'hubspot', 'pipedrive', 'zoho'],
  'ai': ['openai', 'gpt', 'langchain', 'anthropic', 'ollama', 'agent'],
  'notification': ['slack', 'email', 'sms', 'push', 'webhook', 'telegram'],
  'schedule': ['cron', 'interval', 'timer', 'trigger'],
  'http': ['webhook', 'request', 'api', 'rest', 'fetch'],
  'transform': ['set', 'code', 'function', 'map', 'filter', 'aggregate'],
  'condition': ['if', 'switch', 'filter', 'branch'],
  'storage': ['s3', 'gcs', 'azure', 'drive', 'dropbox', 'minio'],
};

function expandQuery(tokens: string[]): string[] {
  const expanded = new Set(tokens);
  for (const token of tokens) {
    const synonyms = EXPANSIONS[token];
    if (synonyms) {
      for (const s of synonyms) expanded.add(stem(s));
    }
  }
  return [...expanded];
}

// ─── TF-IDF Index ────────────────────────────────────────────────────────────

interface IndexedDoc {
  id: string;
  entity: Entity;
  tokens: string[];
  tf: Map<string, number>;
}

export interface SearchResult {
  entity: Entity;
  score: number;
  matchedTerms: string[];
}

export class SearchEngine {
  private docs: IndexedDoc[] = [];
  private df: Map<string, number> = new Map();
  private totalDocs = 0;

  /** Build the index from entities */
  index(entities: Entity[]): void {
    this.docs = [];
    this.df = new Map();
    this.totalDocs = entities.length;

    for (const entity of entities) {
      const text = this.entityToText(entity);
      const tokens = tokenize(text);
      const tf = new Map<string, number>();

      for (const token of tokens) {
        tf.set(token, (tf.get(token) ?? 0) + 1);
      }

      // Normalize TF
      const maxTf = Math.max(...tf.values(), 1);
      for (const [term, count] of tf) {
        tf.set(term, count / maxTf);
      }

      // Update document frequency
      const uniqueTerms = new Set(tokens);
      for (const term of uniqueTerms) {
        this.df.set(term, (this.df.get(term) ?? 0) + 1);
      }

      this.docs.push({ id: entity.id, entity, tokens, tf });
    }
  }

  /** Search for entities matching a query */
  search(query: string, limit = 20): SearchResult[] {
    const queryTokens = tokenize(query);
    const expanded = expandQuery(queryTokens);

    const results: SearchResult[] = [];

    for (const doc of this.docs) {
      let score = 0;
      const matched: string[] = [];

      for (const term of expanded) {
        const tf = doc.tf.get(term) ?? 0;
        if (tf === 0) continue;

        const df = this.df.get(term) ?? 0;
        const idf = Math.log((this.totalDocs + 1) / (df + 1)) + 1;
        score += tf * idf;
        matched.push(term);
      }

      // Boost: tag overlap
      const entity = doc.entity;
      if ('tags' in entity && Array.isArray(entity.tags)) {
        const tagTokens = entity.tags.map(t => stem(t.toLowerCase()));
        for (const term of expanded) {
          if (tagTokens.includes(term)) score *= 1.3;
        }
      }

      if (score > 0) {
        results.push({ entity: doc.entity, score, matchedTerms: matched });
      }
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /** Convert entity to searchable text */
  private entityToText(entity: Entity): string {
    switch (entity.type) {
      case 'nodeDefinition': {
        const n = entity as NodeDefinition;
        const paramText = n.properties.map(p => `${p.displayName} ${p.description}`).join(' ');
        const credText = n.credentials.map(c => c.name).join(' ');
        return `${n.displayName} ${n.n8nType} ${n.description} ${n.category} ${n.group.join(' ')} ${paramText} ${credText} ${n.tags.join(' ')}`;
      }
      case 'workflowPattern': {
        const p = entity as WorkflowPattern;
        return `${p.name} ${p.description} ${p.useCases.join(' ')} ${p.nodes.map(n => n.n8nType).join(' ')} ${p.tags.join(' ')}`;
      }
      case 'executionContext':
        return `${entity.content} ${entity.n8nType} ${entity.resolution ?? ''} ${entity.tags.join(' ')}`;
      case 'n8nInstance':
        return `${entity.name} ${entity.baseUrl} ${entity.tags.join(' ')}`;
      default:
        return '';
    }
  }
}
