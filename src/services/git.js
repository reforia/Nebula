import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const GIT = 'git';

// Argument-array exec — arguments are passed directly to the git binary
// without a shell, so values like remote URLs, branch names, commit
// messages, and file paths cannot be interpreted as shell metacharacters
// (`$()`, backticks, `;`, `|`, `&&`). Always prefer this over string
// interpolation for git commands.
function git(args, opts = {}) {
  return execFileSync(GIT, args, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...opts,
  }).toString().trim();
}

/**
 * Validate a branch name to prevent command injection and reject refs that
 * confuse git. Even with execFile we still want to reject names starting with
 * `-` (would be parsed as a flag) and the `..` range separator.
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
 * @param {string} repoPath - where to create the bare repo
 * @param {string} remoteUrl - SSH remote URL (stored as origin on bare repo)
 * @param {Object} options
 * @param {string} [options.cloneUrl] - HTTPS clone URL for pushing scaffold to remote
 * @param {string} [options.token] - API token for HTTPS push auth
 * @param {boolean} [options.insecureSsl] - skip SSL verification
 */
export function initProjectRepo(repoPath, remoteUrl, { name = 'Project', description = '', cloneUrl, token, insecureSsl } = {}) {
  fs.mkdirSync(repoPath, { recursive: true });
  git(['init', '--bare'], { cwd: repoPath });

  // Set default branch to main
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: repoPath });

  // Create scaffold in a temp directory (git init + add remote + push)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-repo-init-'));
  try {
    git(['init'], { cwd: tmpDir });
    git(['checkout', '-b', 'main'], { cwd: tmpDir });
    git(['remote', 'add', 'origin', repoPath], { cwd: tmpDir });

    // Scaffold files
    fs.writeFileSync(path.join(tmpDir, 'README.md'), `# ${name}\n\n${description}\n`);
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), `# ${name}\n\nProject knowledge base. Agents update this file as they discover important information.\n`);
    fs.mkdirSync(path.join(tmpDir, 'vault'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'vault', '.gitkeep'), '');

    git(['add', '-A'], { cwd: tmpDir });
    git([
      '-c', 'user.name=Nebula',
      '-c', 'user.email=nebula@local',
      'commit', '-m', 'Initial project scaffold',
    ], { cwd: tmpDir });
    git(['push', 'origin', 'main'], { cwd: tmpDir });

    // Push scaffold to the remote repo via HTTPS+token
    if (cloneUrl && token) {
      const authUrl = buildAuthenticatedUrl(cloneUrl, token);
      const sslFlags = insecureSsl ? ['-c', 'http.sslVerify=false'] : [];
      git(['remote', 'add', 'upstream', authUrl], { cwd: tmpDir });
      git([...sslFlags, 'push', 'upstream', 'main'], { cwd: tmpDir });
      // Remove the authenticated remote (token in URL)
      git(['remote', 'remove', 'upstream'], { cwd: tmpDir });
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // Set origin on bare repo to SSH URL (for ongoing agent operations)
  if (remoteUrl) {
    git([`--git-dir=${repoPath}`, 'remote', 'add', 'origin', remoteUrl], { cwd: repoPath });
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
  const configArgs = [];

  if (useHttps) {
    url = buildAuthenticatedUrl(cloneUrl, token);
    if (insecureSsl) configArgs.push('-c', 'http.sslVerify=false');
  } else {
    // SSH clone — auto-accept new host keys for non-interactive environments
    url = remoteUrl;
    configArgs.push('-c', 'core.sshCommand=ssh -o StrictHostKeyChecking=accept-new');
  }

  git([...configArgs, 'clone', '--bare', url, repoPath]);

  // After HTTPS clone, set origin to SSH URL for ongoing git operations (agents use SSH keys to push)
  if (useHttps && remoteUrl && remoteUrl !== cloneUrl) {
    try {
      git([`--git-dir=${repoPath}`, 'remote', 'set-url', 'origin', remoteUrl]);
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
    git([`--git-dir=${repoPath}`, 'worktree', 'add', tmpDir, defaultBranch]);

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
      git(['add', '-A'], { cwd: tmpDir });
      git([
        '-c', 'user.name=Nebula',
        '-c', 'user.email=nebula@local',
        'commit', '-m', 'Add project scaffold',
      ], { cwd: tmpDir });
      // Push to remote if available
      try {
        git(['push'], { cwd: tmpDir });
      } catch {
        // No remote configured, skip
      }
    }
  } finally {
    try { git([`--git-dir=${repoPath}`, 'worktree', 'remove', tmpDir, '--force']); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Detect the default branch (main, master, or first branch found).
 */
export function getDefaultBranch(repoPath) {
  try {
    const head = git([`--git-dir=${repoPath}`, 'symbolic-ref', 'HEAD']);
    return head.replace('refs/heads/', '');
  } catch {
    // No HEAD set, try common names
    try {
      git([`--git-dir=${repoPath}`, 'rev-parse', '--verify', 'main']);
      return 'main';
    } catch {
      try {
        git([`--git-dir=${repoPath}`, 'rev-parse', '--verify', 'master']);
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
  // Remote name must be a simple identifier — reject anything that could be
  // misinterpreted as a flag or ref range.
  if (typeof remote !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(remote) || remote.startsWith('-')) {
    throw new Error(`Invalid remote name: "${remote}"`);
  }
  git([`--git-dir=${repoPath}`, 'fetch', remote]);
}

/**
 * Create a branch from the default branch and push to origin.
 */
export function createBranch(repoPath, branchName) {
  validateBranchName(branchName);
  const defaultBranch = getDefaultBranch(repoPath);
  git([`--git-dir=${repoPath}`, 'branch', branchName, defaultBranch]);
}

/**
 * Delete a branch locally and from remote.
 */
export function deleteBranch(repoPath, branchName) {
  validateBranchName(branchName);
  git([`--git-dir=${repoPath}`, 'branch', '-D', branchName]);
  try {
    git([`--git-dir=${repoPath}`, 'push', 'origin', '--delete', branchName]);
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
  git([`--git-dir=${repoPath}`, 'worktree', 'add', worktreePath, branchName]);
}

/**
 * Remove a worktree.
 */
export function removeWorktree(repoPath, worktreePath) {
  try {
    git([`--git-dir=${repoPath}`, 'worktree', 'remove', worktreePath, '--force']);
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
    output = git([
      `--git-dir=${repoPath}`, 'for-each-ref',
      '--format=%(refname:short) %(upstream:track)',
      'refs/heads/',
    ]);
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
        const counts = git([
          `--git-dir=${repoPath}`, 'rev-list', '--left-right', '--count',
          `${defaultBranch}...${name}`,
        ]);
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
  validateBranchName(branchName);
  const defaultBranch = getDefaultBranch(repoPath);
  try {
    const stat = git([`--git-dir=${repoPath}`, 'diff', '--stat', `${defaultBranch}...${branchName}`]);
    const numstat = git([`--git-dir=${repoPath}`, 'diff', '--numstat', `${defaultBranch}...${branchName}`]);

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
  git(['fetch', 'origin', defaultBranch], { cwd: worktreePath });
  git([
    '-c', 'user.name=Nebula',
    '-c', 'user.email=nebula@local',
    'rebase', `origin/${defaultBranch}`,
  ], { cwd: worktreePath });
}

/**
 * Read vault directory listing from bare repo on default branch.
 */
export function listVault(repoPath) {
  try {
    const output = git([`--git-dir=${repoPath}`, 'ls-tree', '--name-only', '-r', 'HEAD:vault/']);
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
    return git([`--git-dir=${repoPath}`, 'show', `HEAD:vault/${filePath}`]);
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
    git([`--git-dir=${repoPath}`, 'worktree', 'add', tmpDir, defaultBranch]);
    const fullPath = path.join(tmpDir, 'vault', filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
    git(['add', '-A'], { cwd: tmpDir });
    // Check if there are changes to commit
    try {
      git(['diff', '--cached', '--quiet'], { cwd: tmpDir });
      // No changes — skip commit
    } catch {
      const msg = commitMessage || `Update vault/${filePath}`;
      git([
        '-c', 'user.name=Nebula',
        '-c', 'user.email=nebula@local',
        'commit', '-m', msg,
      ], { cwd: tmpDir });
    }
  } finally {
    try { git([`--git-dir=${repoPath}`, 'worktree', 'remove', tmpDir, '--force']); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Replace a remote URL on a bare repo (e.g., after authenticated clone).
 */
export function setRemoteUrl(repoPath, remote, url) {
  if (typeof remote !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(remote) || remote.startsWith('-')) {
    throw new Error(`Invalid remote name: "${remote}"`);
  }
  git([`--git-dir=${repoPath}`, 'remote', 'set-url', remote, url]);
}
