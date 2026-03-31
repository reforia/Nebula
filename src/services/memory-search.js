/**
 * BM25 in-memory search index for agent and project memories.
 * Rebuilt on server start and on every memory mutation.
 * At typical corpus sizes (30-120 docs), full rebuild is microseconds.
 */

import { getAll } from '../db.js';

// BM25 parameters
const K1 = 1.2;
const B = 0.75;

// Per-scope index: Map<scopeKey, { docs, avgDl, df, docCount }>
const indices = new Map();

function scopeKey(ownerType, ownerId) {
  return `${ownerType}:${ownerId}`;
}

/** Tokenize text into lowercase terms */
function tokenize(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(t => t.length > 1);
}

/** Build index for a single scope from its memories */
function buildScopeIndex(ownerType, ownerId) {
  const key = scopeKey(ownerType, ownerId);
  const memories = getAll(
    'SELECT id, title, description, content FROM memories WHERE owner_type = ? AND owner_id = ?',
    [ownerType, ownerId]
  );

  if (memories.length === 0) {
    indices.delete(key);
    return;
  }

  const docs = [];
  const df = new Map(); // term -> number of docs containing it
  let totalDl = 0;

  for (const mem of memories) {
    // Index title (boosted), description, and content
    const text = `${mem.title} ${mem.title} ${mem.title} ${mem.description} ${mem.content}`;
    const terms = tokenize(text);
    const tf = new Map();
    for (const term of terms) {
      tf.set(term, (tf.get(term) || 0) + 1);
    }

    docs.push({ id: mem.id, title: mem.title, description: mem.description, content: mem.content, tf, dl: terms.length });
    totalDl += terms.length;

    // Document frequency — count each term once per doc
    for (const term of tf.keys()) {
      df.set(term, (df.get(term) || 0) + 1);
    }
  }

  indices.set(key, {
    docs,
    avgDl: totalDl / docs.length,
    df,
    docCount: docs.length,
  });
}

/** Rebuild all indices from DB (called on server start) */
export function rebuildAllIndices() {
  indices.clear();
  const scopes = getAll('SELECT DISTINCT owner_type, owner_id FROM memories');
  for (const { owner_type, owner_id } of scopes) {
    buildScopeIndex(owner_type, owner_id);
  }
  console.log(`[memory-search] Rebuilt indices for ${scopes.length} scopes`);
}

/** Rebuild index for a single scope (called on memory mutation) */
export function rebuildIndex(ownerType, ownerId) {
  buildScopeIndex(ownerType, ownerId);
}

/**
 * Search memories within a scope using BM25 ranking.
 * Returns ranked results with snippets.
 */
export function search(ownerType, ownerId, query, limit = 20) {
  const key = scopeKey(ownerType, ownerId);
  const index = indices.get(key);
  if (!index) return [];

  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) return [];

  const { docs, avgDl, df, docCount } = index;
  const results = [];

  for (const doc of docs) {
    let score = 0;
    for (const term of queryTerms) {
      const termDf = df.get(term) || 0;
      const termTf = doc.tf.get(term) || 0;
      if (termTf === 0) continue;

      // BM25 score
      const idf = Math.log((docCount - termDf + 0.5) / (termDf + 0.5) + 1);
      const tfNorm = (termTf * (K1 + 1)) / (termTf + K1 * (1 - B + B * (doc.dl / avgDl)));
      score += idf * tfNorm;
    }

    if (score > 0) {
      results.push({
        id: doc.id,
        title: doc.title,
        description: doc.description,
        snippet: extractSnippet(doc.content, queryTerms),
        score,
      });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

/** Extract a relevant snippet from content around query terms */
function extractSnippet(content, queryTerms, maxLen = 200) {
  const lower = content.toLowerCase();
  let bestPos = -1;
  let bestCount = 0;

  // Find the position with most query term matches in a window
  for (let i = 0; i < lower.length; i += 20) {
    const window = lower.slice(i, i + maxLen);
    let count = 0;
    for (const term of queryTerms) {
      if (window.includes(term)) count++;
    }
    if (count > bestCount) {
      bestCount = count;
      bestPos = i;
    }
  }

  if (bestPos === -1) {
    // No match found, return start of content
    return content.slice(0, maxLen) + (content.length > maxLen ? '...' : '');
  }

  const start = Math.max(0, bestPos);
  const snippet = content.slice(start, start + maxLen);
  return (start > 0 ? '...' : '') + snippet + (start + maxLen < content.length ? '...' : '');
}
