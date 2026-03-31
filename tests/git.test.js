import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import {
  initProjectRepo, getDefaultBranch, createBranch, deleteBranch,
  createWorktree, removeWorktree, listBranches, diffBranch,
  listVault, readVaultFile, ensureScaffold,
} from '../src/services/git.js';

function exec(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], ...opts }).trim();
}

describe('Git Service', () => {
  let tmpDir, repoPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-git-test-'));
    repoPath = path.join(tmpDir, 'repo.git');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('initProjectRepo', () => {
    it('creates bare repo with scaffold files', () => {
      initProjectRepo(repoPath, null, { name: 'TestProj', description: 'A test project' });

      assert.ok(fs.existsSync(repoPath));
      assert.ok(fs.existsSync(path.join(repoPath, 'HEAD'))); // bare repo indicator

      // Check scaffold files exist in the repo
      const files = exec(`git --git-dir="${repoPath}" ls-tree --name-only HEAD`);
      assert.ok(files.includes('CLAUDE.md'));
      assert.ok(files.includes('README.md'));
      assert.ok(files.includes('vault'));
    });

    it('sets default branch to main', () => {
      initProjectRepo(repoPath, null, { name: 'TestProj' });
      assert.equal(getDefaultBranch(repoPath), 'main');
    });

    it('README contains project name and description', () => {
      initProjectRepo(repoPath, null, { name: 'MyProj', description: 'Cool project' });
      const readme = exec(`git --git-dir="${repoPath}" show HEAD:README.md`);
      assert.ok(readme.includes('MyProj'));
      assert.ok(readme.includes('Cool project'));
    });
  });

  describe('createBranch / deleteBranch', () => {
    beforeEach(() => {
      initProjectRepo(repoPath, null, { name: 'Test' });
    });

    it('creates a branch from default', () => {
      createBranch(repoPath, 'feature/auth');
      const branches = listBranches(repoPath);
      const names = branches.map(b => b.name);
      assert.ok(names.includes('feature/auth'));
      assert.ok(names.includes('main'));
    });

    it('deletes a branch', () => {
      createBranch(repoPath, 'feature/temp');
      deleteBranch(repoPath, 'feature/temp');
      const branches = listBranches(repoPath);
      const names = branches.map(b => b.name);
      assert.ok(!names.includes('feature/temp'));
    });
  });

  describe('createWorktree / removeWorktree', () => {
    beforeEach(() => {
      initProjectRepo(repoPath, null, { name: 'Test' });
    });

    it('creates and removes a worktree', () => {
      createBranch(repoPath, 'feature/auth');
      const worktreePath = path.join(tmpDir, 'worktree-auth');

      createWorktree(repoPath, worktreePath, 'feature/auth');
      assert.ok(fs.existsSync(worktreePath));
      assert.ok(fs.existsSync(path.join(worktreePath, 'CLAUDE.md')));

      removeWorktree(repoPath, worktreePath);
      assert.ok(!fs.existsSync(worktreePath));
    });

    it('two worktrees have independent changes', () => {
      createBranch(repoPath, 'feature/a');
      createBranch(repoPath, 'feature/b');

      const wtA = path.join(tmpDir, 'wt-a');
      const wtB = path.join(tmpDir, 'wt-b');

      createWorktree(repoPath, wtA, 'feature/a');
      createWorktree(repoPath, wtB, 'feature/b');

      // Make different changes in each
      fs.writeFileSync(path.join(wtA, 'fileA.txt'), 'content A');
      exec('git add fileA.txt && git -c user.name="Test" -c user.email="t@t" commit -m "add A"', { cwd: wtA });

      fs.writeFileSync(path.join(wtB, 'fileB.txt'), 'content B');
      exec('git add fileB.txt && git -c user.name="Test" -c user.email="t@t" commit -m "add B"', { cwd: wtB });

      // Verify independence
      assert.ok(fs.existsSync(path.join(wtA, 'fileA.txt')));
      assert.ok(!fs.existsSync(path.join(wtA, 'fileB.txt')));
      assert.ok(fs.existsSync(path.join(wtB, 'fileB.txt')));
      assert.ok(!fs.existsSync(path.join(wtB, 'fileA.txt')));

      removeWorktree(repoPath, wtA);
      removeWorktree(repoPath, wtB);
    });
  });

  describe('listBranches', () => {
    it('returns branches with ahead/behind counts', () => {
      initProjectRepo(repoPath, null, { name: 'Test' });
      createBranch(repoPath, 'feature/x');

      // Add a commit to feature/x via worktree
      const wt = path.join(tmpDir, 'wt-x');
      createWorktree(repoPath, wt, 'feature/x');
      fs.writeFileSync(path.join(wt, 'new.txt'), 'hello');
      exec('git add new.txt && git -c user.name="T" -c user.email="t@t" commit -m "add"', { cwd: wt });

      const branches = listBranches(repoPath);
      const featureBranch = branches.find(b => b.name === 'feature/x');
      assert.ok(featureBranch);
      assert.equal(featureBranch.ahead, 1);
      assert.equal(featureBranch.behind, 0);

      const mainBranch = branches.find(b => b.name === 'main');
      assert.ok(mainBranch);
      assert.equal(mainBranch.is_default, true);

      removeWorktree(repoPath, wt);
    });
  });

  describe('diffBranch', () => {
    it('returns diff stats for a branch', () => {
      initProjectRepo(repoPath, null, { name: 'Test' });
      createBranch(repoPath, 'feature/diff');

      const wt = path.join(tmpDir, 'wt-diff');
      createWorktree(repoPath, wt, 'feature/diff');
      fs.writeFileSync(path.join(wt, 'added.txt'), 'line1\nline2\n');
      exec('git add added.txt && git -c user.name="T" -c user.email="t@t" commit -m "add file"', { cwd: wt });

      const diff = diffBranch(repoPath, 'feature/diff');
      assert.ok(diff.files.length > 0);
      assert.equal(diff.files[0].file, 'added.txt');
      assert.equal(diff.files[0].added, 2);

      removeWorktree(repoPath, wt);
    });
  });

  describe('CLAUDE.md independence', () => {
    it('CLAUDE.md modified independently in two branches', () => {
      initProjectRepo(repoPath, null, { name: 'Test' });
      createBranch(repoPath, 'feature/a');
      createBranch(repoPath, 'feature/b');

      const wtA = path.join(tmpDir, 'wt-a');
      const wtB = path.join(tmpDir, 'wt-b');
      createWorktree(repoPath, wtA, 'feature/a');
      createWorktree(repoPath, wtB, 'feature/b');

      // Modify CLAUDE.md differently in each branch
      fs.appendFileSync(path.join(wtA, 'CLAUDE.md'), '\n## Discovery from branch A\n');
      exec('git add CLAUDE.md && git -c user.name="T" -c user.email="t@t" commit -m "update knowledge A"', { cwd: wtA });

      fs.appendFileSync(path.join(wtB, 'CLAUDE.md'), '\n## Discovery from branch B\n');
      exec('git add CLAUDE.md && git -c user.name="T" -c user.email="t@t" commit -m "update knowledge B"', { cwd: wtB });

      const contentA = fs.readFileSync(path.join(wtA, 'CLAUDE.md'), 'utf-8');
      const contentB = fs.readFileSync(path.join(wtB, 'CLAUDE.md'), 'utf-8');

      assert.ok(contentA.includes('branch A'));
      assert.ok(!contentA.includes('branch B'));
      assert.ok(contentB.includes('branch B'));
      assert.ok(!contentB.includes('branch A'));

      removeWorktree(repoPath, wtA);
      removeWorktree(repoPath, wtB);
    });
  });

  describe('vault operations', () => {
    it('lists and reads vault files from bare repo', () => {
      initProjectRepo(repoPath, null, { name: 'Test' });

      // Add a file to vault via a temp worktree on a helper branch
      createBranch(repoPath, 'vault-edit');
      const wt = path.join(tmpDir, 'wt-vault');
      createWorktree(repoPath, wt, 'vault-edit');

      fs.writeFileSync(path.join(wt, 'vault', 'spec.md'), '# API Spec\n\nEndpoints...\n');
      exec('git add vault/spec.md && git -c user.name="T" -c user.email="t@t" commit -m "add spec"', { cwd: wt });

      // Merge into main in bare repo
      exec(`git --git-dir="${repoPath}" fetch "${wt}" vault-edit`, { cwd: tmpDir });
      exec(`git --git-dir="${repoPath}" update-ref refs/heads/main refs/heads/vault-edit`, { cwd: tmpDir });
      removeWorktree(repoPath, wt);

      const files = listVault(repoPath);
      assert.ok(files.includes('spec.md'));

      const content = readVaultFile(repoPath, 'spec.md');
      assert.ok(content.includes('API Spec'));
    });
  });

  describe('ensureScaffold', () => {
    it('adds missing scaffold files to existing repo', () => {
      // Create a bare repo without scaffold
      fs.mkdirSync(repoPath, { recursive: true });
      exec('git init --bare', { cwd: repoPath });
      exec('git symbolic-ref HEAD refs/heads/main', { cwd: repoPath });

      // Create a temp clone, add initial commit without scaffold
      const tmpClone = path.join(tmpDir, 'clone');
      exec(`git init "${tmpClone}"`);
      exec('git checkout -b main', { cwd: tmpClone });
      exec(`git remote add origin "${repoPath}"`, { cwd: tmpClone });
      fs.writeFileSync(path.join(tmpClone, 'src.js'), 'console.log("hi")');
      exec('git add -A && git -c user.name="T" -c user.email="t@t" commit -m "init"', { cwd: tmpClone });
      exec('git push origin main', { cwd: tmpClone });
      fs.rmSync(tmpClone, { recursive: true, force: true });

      // Verify no CLAUDE.md yet
      const filesBefore = exec(`git --git-dir="${repoPath}" ls-tree --name-only HEAD`);
      assert.ok(!filesBefore.includes('CLAUDE.md'));

      // Run scaffold
      ensureScaffold(repoPath, { name: 'Existing' });

      // Verify scaffold added
      const filesAfter = exec(`git --git-dir="${repoPath}" ls-tree --name-only HEAD`);
      assert.ok(filesAfter.includes('CLAUDE.md'));
      assert.ok(filesAfter.includes('vault'));
      assert.ok(filesAfter.includes('README.md'));
      // Original file preserved
      assert.ok(filesAfter.includes('src.js'));
    });
  });
});
