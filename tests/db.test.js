import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { getAll, getOne, run, getSetting, setSetting, getOrgSetting, setOrgSetting, db } from './setup.js';

/** Generate a short unique suffix to avoid collisions */
function uid() { return crypto.randomUUID().slice(0, 12); }

/** Create a test user + org in the DB directly, returns { userId, orgId } */
function createTestUserAndOrg(label = 'test') {
  const suffix = uid();
  const userId = `${label}-user-${suffix}`;
  const email = `${label}-${suffix}@example.com`;
  run(
    "INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, 'hash')",
    [userId, email, `${label} User`]
  );
  const orgId = `${label}-org-${suffix}`;
  run(
    'INSERT INTO organizations (id, name, owner_id) VALUES (?, ?, ?)',
    [orgId, `${label} Org`, userId]
  );
  return { userId, orgId };
}

describe('Database layer', () => {
  describe('schema', () => {
    it('creates all required tables', () => {
      const tables = getAll(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
      ).map(r => r.name).sort();

      assert.deepStrictEqual(tables, [
        '_migrations', 'agent_secrets', 'agents', 'conversations', 'custom_skills', 'mcp_servers', 'memories', 'messages', 'org_secrets', 'org_settings', 'organizations',
        'project_agents', 'project_checklist', 'project_deliverables', 'project_links', 'project_milestones', 'project_secrets', 'projects',
        'settings', 'tasks', 'usage_events', 'users',
      ]);
    });

    it('creates indexes on messages', () => {
      const indexes = getAll(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='messages'"
      ).map(r => r.name).sort();

      assert.ok(indexes.includes('idx_messages_agent_time'));
      assert.ok(indexes.includes('idx_messages_unread'));
    });

    it('has WAL journal mode', () => {
      const mode = db.pragma('journal_mode', { simple: true });
      assert.equal(mode, 'wal');
    });

    it('has foreign keys enabled', () => {
      const fk = db.pragma('foreign_keys', { simple: true });
      assert.equal(fk, 1);
    });

    it('agents table has org_id column', () => {
      const cols = getAll("PRAGMA table_info(agents)").map(r => r.name);
      assert.ok(cols.includes('org_id'));
    });
  });

  describe('default settings', () => {
    it('populates max_concurrent_agents', () => {
      assert.equal(getSetting('max_concurrent_agents'), '2');
    });

    it('does not have smtp defaults in system settings', () => {
      // smtp settings are now org-scoped, not in the settings table
      assert.equal(getSetting('smtp_host'), null);
      assert.equal(getSetting('smtp_port'), null);
      assert.equal(getSetting('notifications_enabled'), null);
    });
  });

  describe('query helpers', () => {
    it('getAll returns array', () => {
      const rows = getAll('SELECT 1 as val UNION SELECT 2');
      assert.equal(rows.length, 2);
      assert.equal(rows[0].val, 1);
    });

    it('getOne returns single row', () => {
      const row = getOne('SELECT 42 as val');
      assert.equal(row.val, 42);
    });

    it('getOne returns undefined for no match', () => {
      const row = getOne('SELECT * FROM agents WHERE id = ?', ['nonexistent']);
      assert.equal(row, undefined);
    });

    it('run executes insert/update', () => {
      run("INSERT INTO settings (key, value) VALUES ('test_key', 'test_val')");
      const row = getOne("SELECT value FROM settings WHERE key = 'test_key'");
      assert.equal(row.value, 'test_val');
      // Clean up
      run("DELETE FROM settings WHERE key = 'test_key'");
    });
  });

  describe('getSetting / setSetting', () => {
    it('returns null for unknown key', () => {
      assert.equal(getSetting('nonexistent_key'), null);
    });

    it('sets and gets a value', () => {
      setSetting('test_setting', 'hello');
      assert.equal(getSetting('test_setting'), 'hello');
      // Clean up
      run("DELETE FROM settings WHERE key = 'test_setting'");
    });

    it('overwrites existing value', () => {
      setSetting('test_overwrite', 'first');
      setSetting('test_overwrite', 'second');
      assert.equal(getSetting('test_overwrite'), 'second');
      run("DELETE FROM settings WHERE key = 'test_overwrite'");
    });
  });

  describe('getOrgSetting / setOrgSetting', () => {
    let orgId;

    beforeEach(() => {
      const ctx = createTestUserAndOrg('orgsetting');
      orgId = ctx.orgId;
    });

    it('returns null for unknown key', () => {
      assert.equal(getOrgSetting(orgId, 'nonexistent_key'), null);
    });

    it('sets and gets a value', () => {
      setOrgSetting(orgId, 'smtp_host', 'mail.test.com');
      assert.equal(getOrgSetting(orgId, 'smtp_host'), 'mail.test.com');
    });

    it('overwrites existing value', () => {
      setOrgSetting(orgId, 'smtp_port', '25');
      setOrgSetting(orgId, 'smtp_port', '587');
      assert.equal(getOrgSetting(orgId, 'smtp_port'), '587');
    });

    it('is scoped to org', () => {
      const ctx2 = createTestUserAndOrg('orgsetting2');

      setOrgSetting(orgId, 'smtp_host', 'org1.mail.com');
      setOrgSetting(ctx2.orgId, 'smtp_host', 'org2.mail.com');
      assert.equal(getOrgSetting(orgId, 'smtp_host'), 'org1.mail.com');
      assert.equal(getOrgSetting(ctx2.orgId, 'smtp_host'), 'org2.mail.com');
    });
  });

  describe('foreign key constraints', () => {
    let orgId;

    beforeEach(() => {
      const ctx = createTestUserAndOrg('fk');
      orgId = ctx.orgId;
    });

    it('rejects message with nonexistent agent_id', () => {
      assert.throws(() => {
        run(
          "INSERT INTO messages (id, agent_id, role, content) VALUES (?, 'no-such-agent', 'user', 'hi')",
          [uid()]
        );
      }, /FOREIGN KEY/);
    });

    it('cascades delete from agents to messages', () => {
      const agentId = `cascade-agent-${uid()}`;
      const sessionId = `cascade-sess-${uid()}`;
      run(
        "INSERT INTO agents (id, org_id, name, session_id) VALUES (?, ?, ?, ?)",
        [agentId, orgId, `CascadeBot-${uid()}`, sessionId]
      );
      const msgId = `cm-${uid()}`;
      run(
        "INSERT INTO messages (id, agent_id, role, content) VALUES (?, ?, 'user', 'test')",
        [msgId, agentId]
      );
      assert.equal(getOne('SELECT COUNT(*) as c FROM messages WHERE agent_id = ?', [agentId]).c, 1);

      run('DELETE FROM agents WHERE id = ?', [agentId]);
      assert.equal(getOne('SELECT COUNT(*) as c FROM messages WHERE agent_id = ?', [agentId]).c, 0);
    });

    it('cascades delete from agents to tasks', () => {
      const agentId = `cascade-task-agent-${uid()}`;
      const sessionId = `cascade-task-sess-${uid()}`;
      run(
        "INSERT INTO agents (id, org_id, name, session_id) VALUES (?, ?, ?, ?)",
        [agentId, orgId, `TaskCascadeBot-${uid()}`, sessionId]
      );
      run(
        "INSERT INTO tasks (id, agent_id, name, prompt, cron_expression) VALUES (?, ?, 'test', 'do thing', '* * * * *')",
        [`ct-${uid()}`, agentId]
      );
      run('DELETE FROM agents WHERE id = ?', [agentId]);
      assert.equal(getOne('SELECT COUNT(*) as c FROM tasks WHERE agent_id = ?', [agentId]).c, 0);
    });
  });

  describe('agents table constraints', () => {
    let orgId;

    beforeEach(() => {
      const ctx = createTestUserAndOrg('uniq');
      orgId = ctx.orgId;
    });

    it('enforces unique name within org', () => {
      const name = `UniqueBot-${uid()}`;
      const id1 = uid();
      const id2 = uid();
      run("INSERT INTO agents (id, org_id, name, session_id) VALUES (?, ?, ?, ?)", [id1, orgId, name, `s-${uid()}`]);
      assert.throws(() => {
        run("INSERT INTO agents (id, org_id, name, session_id) VALUES (?, ?, ?, ?)", [id2, orgId, name, `s-${uid()}`]);
      }, /UNIQUE/);
    });

    it('enforces unique session_id', () => {
      const sessionId = `same-session-${uid()}`;
      const id1 = uid();
      const id2 = uid();
      run("INSERT INTO agents (id, org_id, name, session_id) VALUES (?, ?, ?, ?)", [id1, orgId, `Bot1-${uid()}`, sessionId]);
      assert.throws(() => {
        run("INSERT INTO agents (id, org_id, name, session_id) VALUES (?, ?, ?, ?)", [id2, orgId, `Bot2-${uid()}`, sessionId]);
      }, /UNIQUE/);
    });

    it('sets default values correctly', () => {
      const id = `def-${uid()}`;
      const sessId = `def-sess-${uid()}`;
      run("INSERT INTO agents (id, org_id, name, session_id) VALUES (?, ?, ?, ?)", [id, orgId, `DefaultBot-${uid()}`, sessId]);
      const agent = getOne('SELECT * FROM agents WHERE id = ?', [id]);

      assert.equal(agent.role, '');
      assert.equal(agent.allowed_tools, 'Read,Grep,Glob,WebFetch,Bash');
      assert.equal(agent.model, 'claude-sonnet-4-6');
      assert.equal(agent.security_tier, 'standard');
      assert.equal(agent.enabled, 1);
      assert.equal(agent.notify_email, 1);
      assert.equal(agent.sort_order, 0);
      assert.equal(agent.session_initialized, 0);
      assert.equal(agent.org_id, orgId);
      assert.ok(agent.created_at);
      assert.ok(agent.updated_at);
    });
  });
});
