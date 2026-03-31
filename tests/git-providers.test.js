import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseRemoteUrl } from '../src/services/git-providers.js';

describe('Git Providers', () => {
  describe('parseRemoteUrl', () => {
    it('parses SSH URL', () => {
      const { host, owner, repo } = parseRemoteUrl('git@gitea.example.com:Enigma/Nebula.git');
      assert.equal(host, 'gitea.example.com');
      assert.equal(owner, 'Enigma');
      assert.equal(repo, 'Nebula');
    });

    it('parses SSH URL without .git suffix', () => {
      const { host, owner, repo } = parseRemoteUrl('git@github.com:org/repo');
      assert.equal(host, 'github.com');
      assert.equal(owner, 'org');
      assert.equal(repo, 'repo');
    });

    it('parses HTTPS URL', () => {
      const { host, owner, repo } = parseRemoteUrl('https://github.com/anthropics/claude-code.git');
      assert.equal(host, 'github.com');
      assert.equal(owner, 'anthropics');
      assert.equal(repo, 'claude-code');
    });

    it('parses HTTPS URL without .git suffix', () => {
      const { host, owner, repo } = parseRemoteUrl('https://gitea.local:3080/Enigma/Rosetta');
      assert.equal(host, 'gitea.local:3080');
      assert.equal(owner, 'Enigma');
      assert.equal(repo, 'Rosetta');
    });

    it('parses SSH URL with IP host', () => {
      const { host, owner, repo } = parseRemoteUrl('git@10.0.0.1:MyOrg/MyRepo.git');
      assert.equal(host, '10.0.0.1');
      assert.equal(owner, 'MyOrg');
      assert.equal(repo, 'MyRepo');
    });

    it('throws on invalid URL', () => {
      assert.throws(() => parseRemoteUrl('not-a-url'), /Cannot parse/);
    });
  });
});
