/**
 * Git hosting platform PR adapters (Gitea, GitHub).
 * Factory function returns provider-specific adapter based on project config.
 */

import https from 'node:https';
import http from 'node:http';

const insecureAgent = new https.Agent({ rejectUnauthorized: false });

/**
 * fetch() wrapper that tolerates self-signed TLS certificates when insecure=true.
 * Falls back to normal fetch() when insecure is false.
 * Returns a fetch-compatible Response object.
 */
function gitFetch(url, options = {}, insecure = false) {
  if (!insecure) return fetch(url, options);
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    };
    if (parsed.protocol === 'https:') reqOptions.agent = insecureAgent;
    const req = mod.request(reqOptions, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          headers: { get: (name) => res.headers[name.toLowerCase()] },
          json: () => Promise.resolve(JSON.parse(body)),
          text: () => Promise.resolve(body),
        });
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

/**
 * Parse owner/repo from a git remote URL.
 * Supports SSH (git@host:owner/repo.git) and HTTPS (https://host/owner/repo.git).
 */
function parseRemoteUrl(url) {
  // SSH: git@host:owner/repo.git
  const sshMatch = url.match(/[^@]+@([^:]+):(.+?)(?:\.git)?$/);
  if (sshMatch) {
    const [owner, repo] = sshMatch[2].split('/');
    return { host: sshMatch[1], owner, repo };
  }
  // HTTPS: https://host/owner/repo.git
  const httpsMatch = url.match(/https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpsMatch) {
    const parts = httpsMatch[2].split('/');
    return { host: httpsMatch[1], owner: parts[0], repo: parts[1] };
  }
  throw new Error(`Cannot parse git remote URL: ${url}`);
}

// ==================== Gitea Adapter ====================

function giteaAdapter({ host, owner, repo, token, apiUrl, insecure }) {
  let baseUrl;
  if (apiUrl) {
    // Explicit API URL override (e.g. "http://gitea.local:3000")
    baseUrl = `${apiUrl.replace(/\/$/, '')}/api/v1/repos/${owner}/${repo}`;
  } else {
    const protocol = host.includes('localhost') || /:\d+$/.test(host) ? 'http' : 'https';
    baseUrl = `${protocol}://${host}/api/v1/repos/${owner}/${repo}`;
  }
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `token ${token}`;
  const gf = (url, opts) => gitFetch(url, opts, insecure);

  return {
    async createPR(branch, title, body) {
      const defaultBranch = await getDefaultBranchFromApi();
      const res = await gf(`${baseUrl}/pulls`, {
        method: 'POST', headers,
        body: JSON.stringify({ head: branch, base: defaultBranch, title, body }),
      });
      if (!res.ok) throw new Error(`Gitea createPR failed: ${res.status} ${await res.text()}`);
      const pr = await res.json();
      return { number: pr.number, url: pr.url, html_url: pr.html_url };
    },

    async listPRs(state = 'open') {
      const res = await gf(`${baseUrl}/pulls?state=${state}&limit=50`, { headers });
      if (!res.ok) throw new Error(`Gitea listPRs failed: ${res.status}`);
      const prs = await res.json();
      return prs.map(pr => ({
        number: pr.number, branch: pr.head?.ref, title: pr.title,
        state: pr.state, url: pr.url, html_url: pr.html_url,
      }));
    },

    async mergePR(number, { deleteBranch = false } = {}) {
      const res = await gf(`${baseUrl}/pulls/${number}/merge`, {
        method: 'POST', headers,
        body: JSON.stringify({ Do: 'merge', delete_branch_after_merge: deleteBranch }),
      });
      if (!res.ok) throw new Error(`Gitea mergePR failed: ${res.status} ${await res.text()}`);
      return { ok: true };
    },

    async getPRStatus(number) {
      const res = await gf(`${baseUrl}/pulls/${number}`, { headers });
      if (!res.ok) throw new Error(`Gitea getPRStatus failed: ${res.status}`);
      const pr = await res.json();
      return { state: pr.state, mergeable: pr.mergeable, conflicts: !pr.mergeable };
    },

    async listWebhooks() {
      const res = await gf(`${baseUrl}/hooks`, { headers });
      if (!res.ok) throw new Error(`Gitea listWebhooks failed: ${res.status}`);
      return res.json();
    },

    async testWebhook(hookId) {
      const res = await gf(`${baseUrl}/hooks/${hookId}/tests`, { method: 'POST', headers });
      if (!res.ok) throw new Error(`Gitea testWebhook failed: ${res.status}`);
      return { ok: true };
    },

    async createWebhook(url, secret, events = ['push']) {
      const res = await gf(`${baseUrl}/hooks`, {
        method: 'POST', headers,
        body: JSON.stringify({ type: 'gitea', config: { url, content_type: 'json', secret }, events, active: true }),
      });
      if (!res.ok) throw new Error(`Gitea createWebhook failed: ${res.status}`);
      return res.json();
    },
  };

  async function getDefaultBranchFromApi() {
    try {
      const repoRes = await gf(`${baseUrl}`, { headers });
      const repoData = await repoRes.json();
      return repoData.default_branch || 'main';
    } catch {
      return 'main';
    }
  }
}

// ==================== GitHub Adapter ====================

function githubAdapter({ owner, repo, token }) {
  const baseUrl = `https://api.github.com/repos/${owner}/${repo}`;
  const headers = { 'Content-Type': 'application/json', 'Accept': 'application/vnd.github+json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  return {
    async createPR(branch, title, body) {
      const defaultBranch = await getDefaultBranchFromApi();
      const res = await fetch(`${baseUrl}/pulls`, {
        method: 'POST', headers,
        body: JSON.stringify({ head: branch, base: defaultBranch, title, body }),
      });
      if (!res.ok) throw new Error(`GitHub createPR failed: ${res.status} ${await res.text()}`);
      const pr = await res.json();
      return { number: pr.number, url: pr.url, html_url: pr.html_url };
    },

    async listPRs(state = 'open') {
      const res = await fetch(`${baseUrl}/pulls?state=${state}&per_page=50`, { headers });
      if (!res.ok) throw new Error(`GitHub listPRs failed: ${res.status}`);
      const prs = await res.json();
      return prs.map(pr => ({
        number: pr.number, branch: pr.head?.ref, title: pr.title,
        state: pr.state, url: pr.url, html_url: pr.html_url,
      }));
    },

    async mergePR(number, { deleteBranch = false } = {}) {
      // Get branch name before merging (needed for deletion)
      let branchName = null;
      if (deleteBranch) {
        try {
          const prRes = await fetch(`${baseUrl}/pulls/${number}`, { headers });
          if (prRes.ok) branchName = (await prRes.json()).head?.ref;
        } catch {}
      }

      const res = await fetch(`${baseUrl}/pulls/${number}/merge`, {
        method: 'PUT', headers,
        body: JSON.stringify({ merge_method: 'merge' }),
      });
      if (!res.ok) throw new Error(`GitHub mergePR failed: ${res.status} ${await res.text()}`);

      // GitHub doesn't support delete_branch_after_merge in merge body — separate call
      if (deleteBranch && branchName) {
        try {
          await fetch(`${baseUrl}/git/refs/heads/${branchName}`, { method: 'DELETE', headers });
        } catch {}
      }

      return { ok: true };
    },

    async getPRStatus(number) {
      const res = await fetch(`${baseUrl}/pulls/${number}`, { headers });
      if (!res.ok) throw new Error(`GitHub getPRStatus failed: ${res.status}`);
      const pr = await res.json();
      return { state: pr.state, mergeable: pr.mergeable, conflicts: pr.mergeable === false };
    },

    async listWebhooks() {
      const res = await fetch(`${baseUrl}/hooks`, { headers });
      if (!res.ok) throw new Error(`GitHub listWebhooks failed: ${res.status}`);
      return res.json();
    },

    async testWebhook(hookId) {
      const res = await fetch(`${baseUrl}/hooks/${hookId}/pings`, { method: 'POST', headers });
      if (!res.ok) throw new Error(`GitHub testWebhook failed: ${res.status}`);
      return { ok: true };
    },

    async createWebhook(url, secret, events = ['push']) {
      const res = await fetch(`${baseUrl}/hooks`, {
        method: 'POST', headers,
        body: JSON.stringify({ name: 'web', config: { url, content_type: 'json', secret }, events, active: true }),
      });
      if (!res.ok) throw new Error(`GitHub createWebhook failed: ${res.status}`);
      return res.json();
    },
  };

  async function getDefaultBranchFromApi() {
    try {
      const repoRes = await fetch(`${baseUrl}`, { headers });
      const repoData = await repoRes.json();
      return repoData.default_branch || 'main';
    } catch {
      return 'main';
    }
  }
}

// ==================== Factory ====================

/**
 * Get a git provider adapter for a project.
 * @param {object} project - Project row from DB (needs git_remote_url, git_provider)
 * @param {string} token - API token for the hosting platform
 * @param {object} [opts]
 * @param {string} [opts.apiUrl] - Explicit API base URL (e.g. "http://gitea.local:3000" for Gitea on non-standard port)
 */
export function getGitProvider(project, token, opts = {}) {
  const { host, owner, repo } = parseRemoteUrl(project.git_remote_url);

  switch (project.git_provider) {
    case 'gitea':
      return giteaAdapter({ host, owner, repo, token, apiUrl: opts.apiUrl, insecure: opts.insecure });
    case 'github':
      return githubAdapter({ owner, repo, token });
    default:
      throw new Error(`Unsupported git provider: ${project.git_provider}`);
  }
}

export { parseRemoteUrl };

// ==================== Account-Level Adapters (user-scoped, not repo-scoped) ====================

function giteaAccountAdapter({ token, apiUrl, insecure }) {
  const baseUrl = `${apiUrl.replace(/\/$/, '')}/api/v1`;
  const headers = { 'Content-Type': 'application/json', 'Authorization': `token ${token}` };
  const gf = (url, opts) => gitFetch(url, opts, insecure);

  return {
    async getUser() {
      const res = await gf(`${baseUrl}/user`, { headers });
      if (!res.ok) throw new Error(`Auth failed: ${res.status}`);
      const data = await res.json();
      return { username: data.login, email: data.email };
    },

    async listRepos({ page = 1, perPage = 50, search = '' } = {}) {
      const q = search ? `&q=${encodeURIComponent(search)}` : '';
      const res = await gf(`${baseUrl}/repos/search?limit=${perPage}&page=${page}${q}&token=`, { headers });
      if (!res.ok) throw new Error(`List repos failed: ${res.status}`);
      const data = await res.json();
      const repos = (data.data || data).map(r => ({
        full_name: r.full_name, clone_url: r.clone_url, ssh_url: r.ssh_url,
        description: r.description || '', private: r.private, default_branch: r.default_branch || 'main',
      }));
      return { repos, total: data.total_count || repos.length };
    },

    async createRepo(name, { private: isPrivate = true } = {}) {
      const res = await gf(`${baseUrl}/user/repos`, {
        method: 'POST', headers,
        body: JSON.stringify({ name, private: isPrivate, auto_init: false }),
      });
      if (!res.ok) throw new Error(`Create repo failed: ${res.status} ${await res.text()}`);
      const data = await res.json();
      return { full_name: data.full_name, clone_url: data.clone_url, ssh_url: data.ssh_url, default_branch: data.default_branch || 'main' };
    },

    async checkPermissions() {
      const caps = { list_repos: false, read_repos: false, create_repos: false, create_webhooks: false };
      try {
        const res = await gf(`${baseUrl}/repos/search?limit=1`, { headers });
        caps.list_repos = res.ok;
        caps.read_repos = res.ok;
      } catch {}
      try {
        // Test create by checking if token can access user/repos endpoint
        const res = await gf(`${baseUrl}/user/repos?limit=1`, { headers });
        caps.create_repos = res.ok;
        caps.create_webhooks = res.ok; // Gitea: repo owners can manage hooks
      } catch {}
      return caps;
    },
  };
}

function githubAccountAdapter({ token }) {
  const baseUrl = 'https://api.github.com';
  const headers = { 'Content-Type': 'application/json', 'Accept': 'application/vnd.github+json', 'Authorization': `Bearer ${token}` };

  return {
    async getUser() {
      const res = await fetch(`${baseUrl}/user`, { headers });
      if (!res.ok) throw new Error(`Auth failed: ${res.status}`);
      const data = await res.json();
      return { username: data.login, email: data.email };
    },

    async listRepos({ page = 1, perPage = 50, search = '' } = {}) {
      let url;
      if (search) {
        const user = await this.getUser();
        url = `${baseUrl}/search/repositories?q=${encodeURIComponent(search)}+user:${user.username}&per_page=${perPage}&page=${page}`;
      } else {
        url = `${baseUrl}/user/repos?per_page=${perPage}&page=${page}&sort=updated`;
      }
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`List repos failed: ${res.status}`);
      const data = await res.json();
      const items = search ? data.items : data;
      const repos = items.map(r => ({
        full_name: r.full_name, clone_url: r.clone_url, ssh_url: r.ssh_url,
        description: r.description || '', private: r.private, default_branch: r.default_branch || 'main',
      }));
      return { repos, total: search ? data.total_count : repos.length };
    },

    async createRepo(name, { private: isPrivate = true } = {}) {
      const res = await fetch(`${baseUrl}/user/repos`, {
        method: 'POST', headers,
        body: JSON.stringify({ name, private: isPrivate, auto_init: false }),
      });
      if (!res.ok) throw new Error(`Create repo failed: ${res.status} ${await res.text()}`);
      const data = await res.json();
      return { full_name: data.full_name, clone_url: data.clone_url, ssh_url: data.ssh_url, default_branch: data.default_branch || 'main' };
    },

    async checkPermissions() {
      const caps = { list_repos: false, read_repos: false, create_repos: false, create_webhooks: false };
      try {
        const res = await fetch(`${baseUrl}/user/repos?per_page=1`, { headers });
        caps.list_repos = res.ok;
        caps.read_repos = res.ok;
        const scopes = res.headers.get('x-oauth-scopes') || '';
        caps.create_repos = scopes.includes('repo') || scopes.includes('public_repo');
        caps.create_webhooks = scopes.includes('admin:repo_hook') || scopes.includes('repo');
      } catch {}
      return caps;
    },
  };
}

/**
 * Get an account-level adapter for user operations (list repos, create repo, validate token).
 * Not repo-scoped — used during project creation wizard.
 */
export function getGitProviderAccount(provider, token, opts = {}) {
  switch (provider) {
    case 'gitea':
      if (!opts.apiUrl) throw new Error('Gitea requires an API URL');
      return giteaAccountAdapter({ token, apiUrl: opts.apiUrl, insecure: opts.insecure });
    case 'github':
      return githubAccountAdapter({ token });
    default:
      throw new Error(`Unsupported git provider: ${provider}`);
  }
}
