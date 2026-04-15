import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const GIT = 'git';

function exec(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], ...opts }).trim();
}

/**
 * Validate a branch name to prevent command injection.
 * Rejects names with shell metacharacters, allowing only safe git branch name chars.
 */
function validateBranchName(name) {
  if (!name || typeof name !== 'string') throw new Error('Branch name is required');
  // Allow alphanumeric, hyphens, underscores, dots, slashes (for feature/xyz)
  if (!/^[a-zA-Z0-9._\/-]+$/.test(name)) {
    throw new Error(`Invalid branch name: "${name}" — only alphanumeric, hyphens, underscores, dots, and slashes allowed`);
  }
  if (name.startsWith('-') || name.includes('..')) {
    throw new Error(`Invalid branch name: "${name}"`);
  }
}

/**
 * Initialize a new bare repo with scaffold commit, add remote, push.
 */
export function initProjectRepo(repoPath, remoteUrl, { name = 'Project', description = '' } = {}) {
  fs.mkdirSync(repoPath, { recursive: true });
  exec(`${GIT} init --bare`, { cwd: repoPath });

  // Set default branch to main
  exec(`${GIT} symbolic-ref HEAD refs/heads/main`, { cwd: repoPath });

  // Create scaffold in a temp directory (git init + add remote + push)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-repo-init-'));
  try {
    exec(`${GIT} init`, { cwd: tmpDir });
    exec(`${GIT} checkout -b main`, { cwd: tmpDir });
    exec(`${GIT} remote add origin "${repoPath}"`, { cwd: tmpDir });

    // Scaffold files
    fs.writeFileSync(path.join(tmpDir, 'README.md'), `# ${name}\n\n${description}\n`);
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), `# ${name}\n\nProject knowledge base. Agents update this file as they discover important information.\n`);
    fs.mkdirSync(path.join(tmpDir, 'vault'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'vault', '.gitkeep'), '');

    exec(`${GIT} add -A`, { cwd: tmpDir });
    exec(`${GIT} -c user.name="Nebula" -c user.email="nebula@local" commit -m "Initial project scaffold"`, { cwd: tmpDir });
    exec(`${GIT} push origin main`, { cwd: tmpDir });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // Add the actual upstream remote
  if (remoteUrl) {
    try {
      exec(`${GIT} remote add upstream "${remoteUrl}"`, { cwd: repoPath });
    } catch {
      // Remote might already exist
    }
  }
}

/**
 * Build an authenticated HTTPS clone URL by embedding token.
 * Supports Gitea/GitHub URL formats.
 */
function buildAuthenticatedUrl(url, token) {
  if (!token || !url) return url;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      parsed.username = token;
      parsed.password = '';
      return parsed.toString();
    }
  } catch {}
  return url;
}

/**
 * Clone an existing remote repo as a bare repo.
 * For HTTPS URLs, embeds token for auth and handles self-signed certs.
 * For SSH URLs, auto-accepts new host keys for non-interactive use.
 * @param {string} repoPath - where to create the bare repo
 * @param {string} remoteUrl - the SSH remote URL to store as origin
 * @param {Object} [options]
 * @param {string} [options.cloneUrl] - HTTPS clone URL (preferred for initial clone when token available)
 * @param {string} [options.token] - API token for HTTPS auth
 * @param {boolean} [options.insecureSsl] - skip SSL verification (self-signed certs)
 */
export function cloneRepo(repoPath, remoteUrl, { cloneUrl, token, insecureSsl } = {}) {
  const parentDir = path.dirname(repoPath);
  fs.mkdirSync(parentDir, { recursive: true });

  // Prefer HTTPS clone with token (most reliable — no SSH key setup needed)
  const useHttps = cloneUrl && token && /^https?:\/\//.test(cloneUrl);
  let url;
  const configFlags = [];

  if (useHttps) {
    url = buildAuthenticatedUrl(cloneUrl, token);
    if (insecureSsl) configFlags.push('-c http.sslVerify=false');
  } else {
    // SSH clone — auto-accept new host keys for non-interactive environments
    url = remoteUrl;
    configFlags.push('-c core.sshCommand="ssh -o StrictHostKeyChecking=accept-new"');
  }

  const flags = configFlags.length > 0 ? configFlags.join(' ') + ' ' : '';
  exec(`${GIT} ${flags}clone --bare "${url}" "${repoPath}"`);

  // After HTTPS clone, set origin to SSH URL for ongoing git operations (agents use SSH keys to push)
  if (useHttps && remoteUrl && remoteUrl !== cloneUrl) {
    try {
      exec(`${GIT} --git-dir="${repoPath}" remote set-url origin "${remoteUrl}"`);
    } catch {}
  }
}

/**
 * Ensure scaffold files (CLAUDE.md, vault/) exist on default branch.
 * If missing, create them in a temp worktree and push.
 */
export function ensureScaffold(repoPath, { name = 'Project' } = {}) {
  const defaultBranch = getDefaultBranch(repoPath);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-scaffold-'));
  try {
    exec(`${GIT} --git-dir="${repoPath}" worktree add "${tmpDir}" ${defaultBranch}`);

    let changed = false;
    if (!fs.existsSync(path.join(tmpDir, 'CLAUDE.md'))) {
      fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), `# ${name}\n\nProject knowledge base. Agents update this file as they discover important information.\n`);
      changed = true;
    }
    if (!fs.existsSync(path.join(tmpDir, 'vault'))) {
      fs.mkdirSync(path.join(tmpDir, 'vault'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'vault', '.gitkeep'), '');
      changed = true;
    }
    if (!fs.existsSync(path.join(tmpDir, 'README.md'))) {
      fs.writeFileSync(path.join(tmpDir, 'README.md'), `# ${name}\n`);
      changed = true;
    }

    if (changed) {
      exec(`${GIT} add -A`, { cwd: tmpDir });
      exec(`${GIT} -c user.name="Nebula" -c user.email="nebula@local" commit -m "Add project scaffold"`, { cwd: tmpDir });
      // Push to remote if available
      try {
        exec(`${GIT} push`, { cwd: tmpDir });
      } catch {
        // No remote configured, skip
      }
    }
  } finally {
    try { exec(`${GIT} --git-dir="${repoPath}" worktree remove "${tmpDir}" --force`); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Detect the default branch (main, master, or first branch found).
 */
export function getDefaultBranch(repoPath) {
  try {
    const head = exec(`${GIT} --git-dir="${repoPath}" symbolic-ref HEAD`);
    return head.replace('refs/heads/', '');
  } catch {
    // No HEAD set, try common names
    try {
      exec(`${GIT} --git-dir="${repoPath}" rev-parse --verify main`);
      return 'main';
    } catch {
      try {
        exec(`${GIT} --git-dir="${repoPath}" rev-parse --verify master`);
        return 'master';
      } catch {
        return 'main';
      }
    }
  }
}

/**
 * Fetch from origin/upstream remote.
 */
export function syncRemote(repoPath, remote = 'origin') {
  exec(`${GIT} --git-dir="${repoPath}" fetch ${remote}`);
}

/**
 * Create a branch from the default branch and push to origin.
 */
export function createBranch(repoPath, branchName) {
  validateBranchName(branchName);
  const defaultBranch = getDefaultBranch(repoPath);
  exec(`${GIT} --git-dir="${repoPath}" branch "${branchName}" ${defaultBranch}`);
}

/**
 * Delete a branch locally and from remote.
 */
export function deleteBranch(repoPath, branchName) {
  validateBranchName(branchName);
  exec(`${GIT} --git-dir="${repoPath}" branch -D "${branchName}"`);
  try {
    exec(`${GIT} --git-dir="${repoPath}" push origin --delete "${branchName}"`);
  } catch {
    // Remote might not have the branch
  }
}

/**
 * Create a worktree checkout for a branch.
 */
export function createWorktree(repoPath, worktreePath, branchName) {
  validateBranchName(branchName);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  exec(`${GIT} --git-dir="${repoPath}" worktree add "${worktreePath}" "${branchName}"`);
}

/**
 * Remove a worktree.
 */
export function removeWorktree(repoPath, worktreePath) {
  try {
    exec(`${GIT} --git-dir="${repoPath}" worktree remove "${worktreePath}" --force`);
  } catch {
    // Worktree might already be gone
  }
  fs.rmSync(worktreePath, { recursive: true, force: true });
}

/**
 * List branches with ahead/behind counts relative to default branch.
 * Returns array of { name, ahead, behind }.
 */
export function listBranches(repoPath) {
  const defaultBranch = getDefaultBranch(repoPath);
  let output;
  try {
    output = exec(`${GIT} --git-dir="${repoPath}" for-each-ref --format="%(refname:short) %(upstream:track)" refs/heads/`);
  } catch {
    return [];
  }

  if (!output) return [];

  return output.split('\n').filter(Boolean).map(line => {
    const parts = line.trim().split(/\s+/);
    const name = parts[0];
    let ahead = 0, behind = 0;

    // Calculate ahead/behind relative to default branch
    if (name !== defaultBranch) {
      try {
        const counts = exec(`${GIT} --git-dir="${repoPath}" rev-list --left-right --count ${defaultBranch}...${name}`);
        const [b, a] = counts.split('\t').map(Number);
        behind = b || 0;
        ahead = a || 0;
      } catch {
        // Branch might not have common ancestor
      }
    }

    return { name, ahead, behind, is_default: name === defaultBranch };
  });
}

/**
 * Get diff stats for a branch against the default branch.
 */
export function diffBranch(repoPath, branchName) {
  const defaultBranch = getDefaultBranch(repoPath);
  try {
    const stat = exec(`${GIT} --git-dir="${repoPath}" diff --stat ${defaultBranch}...${branchName}`);
    const numstat = exec(`${GIT} --git-dir="${repoPath}" diff --numstat ${defaultBranch}...${branchName}`);

    const files = numstat.split('\n').filter(Boolean).map(line => {
      const [added, removed, file] = line.split('\t');
      return { file, added: parseInt(added) || 0, removed: parseInt(removed) || 0 };
    });

    return { stat, files };
  } catch {
    return { stat: '', files: [] };
  }
}

/**
 * Rebase a worktree on the latest default branch.
 */
export function rebaseWorktree(repoPath, worktreePath) {
  const defaultBranch = getDefaultBranch(repoPath);
  // Fetch latest from bare repo
  exec(`${GIT} fetch origin ${defaultBranch}`, { cwd: worktreePath });
  exec(`${GIT} -c user.name="Nebula" -c user.email="nebula@local" rebase origin/${defaultBranch}`, { cwd: worktreePath });
}

/**
 * Read vault directory listing from bare repo on default branch.
 */
export function listVault(repoPath) {
  const defaultBranch = getDefaultBranch(repoPath);
  try {
    const output = exec(`${GIT} --git-dir="${repoPath}" ls-tree --name-only -r HEAD:vault/`);
    return output.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Read a file from the vault on the default branch.
 */
export function readVaultFile(repoPath, filePath) {
  // Prevent path traversal
  if (filePath.includes('..') || filePath.startsWith('/')) return null;
  try {
    return exec(`${GIT} --git-dir="${repoPath}" show HEAD:vault/${filePath}`);
  } catch {
    return null;
  }
}

/**
 * Write a file to vault/ on the default branch via temp worktree.
 */
export function writeVaultFile(repoPath, filePath, content, { commitMessage } = {}) {
  if (filePath.includes('..') || filePath.startsWith('/')) {
    throw new Error('Invalid file path');
  }
  const defaultBranch = getDefaultBranch(repoPath);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-vault-write-'));
  try {
    exec(`${GIT} --git-dir="${repoPath}" worktree add "${tmpDir}" ${defaultBranch}`);
    const fullPath = path.join(tmpDir, 'vault', filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
    exec(`${GIT} add -A`, { cwd: tmpDir });
    // Check if there are changes to commit
    try {
      exec(`${GIT} diff --cached --quiet`, { cwd: tmpDir });
      // No changes — skip commit
    } catch {
      const msg = commitMessage || `Update vault/${filePath}`;
      exec(`${GIT} -c user.name="Nebula" -c user.email="nebula@local" commit -m "${msg.replace(/"/g, '\\"')}"`, { cwd: tmpDir });
    }
  } finally {
    try { exec(`${GIT} --git-dir="${repoPath}" worktree remove "${tmpDir}" --force`); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Replace a remote URL on a bare repo (e.g., after authenticated clone).
 */
export function setRemoteUrl(repoPath, remote, url) {
  exec(`${GIT} --git-dir="${repoPath}" remote set-url ${remote} "${url}"`);
}
