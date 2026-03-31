/**
 * External knowledge base search adapters.
 * Called by the memory search endpoint to fan out queries to linked KBs.
 * Each provider adapter normalizes results to a common format.
 * Timeout after 5 seconds — local results always returned regardless.
 */

const KB_TIMEOUT_MS = 5000;

/**
 * Query an external KB provider.
 * @returns {Promise<Array<{id, title, snippet, url, score, source}>>}
 */
async function queryProvider(link, token, query) {
  const config = typeof link.config === 'string' ? JSON.parse(link.config) : (link.config || {});
  const provider = link.provider;

  switch (provider) {
    case 'youtrack_kb':
      return queryYouTrackKB(link.url, token, query, config);
    case 'confluence':
      return queryConfluence(link.url, token, query, config);
    case 'notion':
      return queryNotion(token, query);
    default:
      return [];
  }
}

async function queryYouTrackKB(baseUrl, token, query, config) {
  const projectFilter = config.project_id ? `project:${config.project_id} ` : '';
  const url = `${baseUrl}/api/articles?fields=id,summary,content&query=${encodeURIComponent(projectFilter + query)}&$top=10`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
    signal: AbortSignal.timeout(KB_TIMEOUT_MS),
  });
  if (!res.ok) return [];
  const articles = await res.json();
  return articles.map((a, i) => ({
    id: a.id,
    title: a.summary || a.id,
    snippet: (a.content || '').slice(0, 200),
    url: `${baseUrl}/articles/${a.id}`,
    score: 10 - i * 0.5, // Preserve provider ordering as score
    source: `kb:youtrack_kb`,
  }));
}

async function queryConfluence(baseUrl, token, query, config) {
  const spaceFilter = config.space_key ? `space=${config.space_key} AND ` : '';
  const cql = `${spaceFilter}type=page AND text~"${query.replace(/"/g, '\\"')}"`;
  const url = `${baseUrl}/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=10&expand=body.view`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Basic ${token}`, 'Accept': 'application/json' },
    signal: AbortSignal.timeout(KB_TIMEOUT_MS),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.results || []).map((p, i) => {
    // Extract text snippet from HTML body
    const html = p.body?.view?.value || '';
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return {
      id: p.id,
      title: p.title,
      snippet: text.slice(0, 200),
      url: `${baseUrl}${p._links?.webui || `/pages/${p.id}`}`,
      score: 10 - i * 0.5,
      source: `kb:confluence`,
    };
  });
}

async function queryNotion(token, query) {
  const res = await fetch('https://api.notion.com/v1/search', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query,
      filter: { property: 'object', value: 'page' },
      page_size: 10,
    }),
    signal: AbortSignal.timeout(KB_TIMEOUT_MS),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.results || []).map((page, i) => {
    // Extract title from properties
    const titleProp = Object.values(page.properties || {}).find(p => p.type === 'title');
    const title = titleProp?.title?.[0]?.plain_text || page.id;
    return {
      id: page.id,
      title,
      snippet: `Notion page: ${title}`,
      url: page.url || `https://notion.so/${page.id.replace(/-/g, '')}`,
      score: 10 - i * 0.5,
      source: `kb:notion`,
    };
  });
}

/**
 * Search all KB links for a project in parallel.
 * Returns results tagged with source. Gracefully degrades on failures.
 *
 * @param {Array} kbLinks - project_links rows with type='knowledge_base'
 * @param {function} tokenResolver - (link) => token string
 * @param {string} query - search query
 * @returns {Promise<Array>} normalized results
 */
export async function searchExternalKBs(kbLinks, tokenResolver, query) {
  if (!kbLinks.length) return [];

  const promises = kbLinks.map(async (link) => {
    try {
      const token = tokenResolver(link);
      if (!token) return [];
      return await queryProvider(link, token, query);
    } catch (err) {
      // Graceful degradation — log and return empty
      console.warn(`[kb-search] ${link.provider} query failed: ${err.message}`);
      return [];
    }
  });

  const results = await Promise.all(promises);
  return results.flat();
}
