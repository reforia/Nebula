import { useState, useEffect } from 'react';
import {
  getSettings, updateSettings, getStatus, OrgStatus,
  getGlobalKnowledge, updateGlobalKnowledge,
  getSecrets, createSecret, deleteSecret, OrgSecret,
  updateOrg, getErrors, ExecutionError, getSecretRefs, SecretRef,
  listTemplates, TemplateSummary,
  getRuntimes, RuntimeInfo,
  getCleanupStatus, CleanupStatus,
} from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import SkillEditor from './SkillEditor';
import Modal from './Modal';
import McpServerEditor from './McpServerEditor';
import SecretsList from './SecretsList';
import SettingsGeneralTab from './SettingsGeneralTab';
import SettingsTemplatesTab from './SettingsTemplatesTab';
import SettingsRuntimesTab from './SettingsRuntimesTab';
import SettingsSystemTab from './SettingsSystemTab';

interface Props {
  onClose: () => void;
  onLogout: () => void;
  onRefresh?: () => void;
}

export default function GlobalSettings({ onClose, onRefresh }: Props) {
  const { currentOrg, refresh: refreshAuth } = useAuth();
  const { reportError } = useToast();
  const [tab, setTab] = useState<'general' | 'templates' | 'smtp' | 'runtimes' | 'knowledge' | 'skills' | 'mcp' | 'secrets' | 'system'>('general');
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [globalMd, setGlobalMd] = useState('');
  const [status, setStatus] = useState<OrgStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [orgName, setOrgName] = useState(currentOrg?.name || '');

  const [secrets, setSecrets] = useState<OrgSecret[]>([]);
  const [newSecretKey, setNewSecretKey] = useState('');

  const [errors, setErrors] = useState<ExecutionError[]>([]);
  const [showErrors, setShowErrors] = useState(false);

  const [secretRefs, setSecretRefs] = useState<SecretRef[]>([]);
  const [availableTemplates, setAvailableTemplates] = useState<TemplateSummary[]>([]);
  const [cleanupStatus, setCleanupStatus] = useState<CleanupStatus | null>(null);

  const [runtimes, setRuntimes] = useState<RuntimeInfo[]>([]);
  const [runtimeDefault, setRuntimeDefault] = useState('');
  const [runtimesLoading, setRuntimesLoading] = useState(true);

  const refreshSecrets = () => {
    getSecrets().then(setSecrets).catch(e => reportError(e, 'Failed to load secrets'));
    getSecretRefs('org').then(r => setSecretRefs(r.refs)).catch(e => reportError(e, 'Failed to load secret references'));
  };

  useEffect(() => {
    getSettings().then(setSettings).catch(e => reportError(e, 'Failed to load settings'));
    getGlobalKnowledge().then(r => setGlobalMd(r.content)).catch(e => reportError(e, 'Failed to load global knowledge'));
    getStatus().then(setStatus).catch(e => reportError(e, 'Failed to load org status'));
    refreshSecrets();
    listTemplates().then(setAvailableTemplates).catch(e => reportError(e, 'Failed to load templates'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    getRuntimes()
      .then(r => { setRuntimes(r.runtimes); setRuntimeDefault(r.default); })
      .catch(e => reportError(e, 'Failed to load runtimes'))
      .finally(() => setRuntimesLoading(false));
  }, [reportError]);

  useEffect(() => {
    if (tab === 'system') {
      getCleanupStatus().then(setCleanupStatus).catch(() => {});
    }
  }, [tab]);

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      if (tab === 'general' && currentOrg && orgName.trim() && orgName.trim() !== currentOrg.name) {
        await updateOrg(currentOrg.id, orgName.trim());
        await refreshAuth();
      }
      await updateSettings(settings);
      if (tab === 'knowledge') {
        await updateGlobalKnowledge(globalMd);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const updateSetting = (key: string, value: string) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  };

  return (
    <Modal onClose={onClose} variant="panel">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-semibold">Settings</h2>
        <button onClick={onClose} className="text-nebula-muted hover:text-nebula-text text-xl">&times;</button>
      </div>

      <div className="flex flex-wrap gap-1 mb-6 border-b border-nebula-border">
        {(['general', 'knowledge', 'runtimes', 'skills', 'mcp', 'smtp', 'templates', 'secrets', 'system'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-2 text-xs capitalize -mb-px border-b-2 transition-colors ${
              tab === t ? 'border-nebula-accent text-nebula-text' : 'border-transparent text-nebula-muted hover:text-nebula-text'
            }`}
          >
            {t === 'mcp' ? 'MCP' : t === 'smtp' ? 'SMTP' : t}
          </button>
        ))}
      </div>

      {tab === 'general' && (
        <SettingsGeneralTab
          orgName={orgName} setOrgName={setOrgName}
          settings={settings} updateSetting={updateSetting}
          status={status} setStatus={setStatus}
          errors={errors} setErrors={setErrors}
          showErrors={showErrors} setShowErrors={setShowErrors}
        />
      )}

      {tab === 'templates' && (
        <SettingsTemplatesTab
          availableTemplates={availableTemplates}
          setError={setError}
          onRefresh={onRefresh}
        />
      )}

      {tab === 'smtp' && (
        <div className="space-y-3">
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="text-xs text-nebula-muted block mb-1">SMTP Host</label>
              <input value={settings.smtp_host || ''} onChange={e => updateSetting('smtp_host', e.target.value)} placeholder="smtp.gmail.com" className="w-full px-3 py-2 bg-nebula-bg border border-nebula-border rounded text-sm text-nebula-text focus:outline-none focus:border-nebula-accent" />
            </div>
            <div className="w-24">
              <label className="text-xs text-nebula-muted block mb-1">Port</label>
              <input value={settings.smtp_port || '587'} onChange={e => updateSetting('smtp_port', e.target.value)} className="w-full px-3 py-2 bg-nebula-bg border border-nebula-border rounded text-sm text-nebula-text focus:outline-none focus:border-nebula-accent" />
            </div>
          </div>
          <div>
            <label className="text-xs text-nebula-muted block mb-1">Username</label>
            <input value={settings.smtp_user || ''} onChange={e => updateSetting('smtp_user', e.target.value)} className="w-full px-3 py-2 bg-nebula-bg border border-nebula-border rounded text-sm text-nebula-text focus:outline-none focus:border-nebula-accent" />
          </div>
          <div>
            <label className="text-xs text-nebula-muted block mb-1">Password</label>
            <input type="password" value={settings.smtp_pass || ''} onChange={e => updateSetting('smtp_pass', e.target.value)} className="w-full px-3 py-2 bg-nebula-bg border border-nebula-border rounded text-sm text-nebula-text focus:outline-none focus:border-nebula-accent" />
          </div>
          <div>
            <label className="text-xs text-nebula-muted block mb-1">From Address</label>
            <input value={settings.smtp_from || ''} onChange={e => updateSetting('smtp_from', e.target.value)} placeholder="nebula@example.com" className="w-full px-3 py-2 bg-nebula-bg border border-nebula-border rounded text-sm text-nebula-text focus:outline-none focus:border-nebula-accent" />
          </div>
          <div>
            <label className="text-xs text-nebula-muted block mb-1">Notify To</label>
            <input value={settings.notify_email_to || ''} onChange={e => updateSetting('notify_email_to', e.target.value)} placeholder="you@example.com" className="w-full px-3 py-2 bg-nebula-bg border border-nebula-border rounded text-sm text-nebula-text focus:outline-none focus:border-nebula-accent" />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={settings.notifications_enabled === '1'} onChange={e => updateSetting('notifications_enabled', e.target.checked ? '1' : '0')} className="accent-nebula-accent" />
            Enable email notifications
          </label>

          <div className="pt-4 mt-4 border-t border-nebula-border">
            <h4 className="text-sm font-medium mb-3">Mail Access (IMAP — for agents)</h4>
            <p className="text-[11px] text-nebula-muted mb-3">Uses SMTP username/password above. Only need to set IMAP host.</p>
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="text-xs text-nebula-muted block mb-1">IMAP Host</label>
                <input value={settings.imap_host || ''} onChange={e => updateSetting('imap_host', e.target.value)} placeholder="imap.gmail.com" className="w-full px-3 py-2 bg-nebula-bg border border-nebula-border rounded text-sm text-nebula-text focus:outline-none focus:border-nebula-accent" />
              </div>
              <div className="w-24">
                <label className="text-xs text-nebula-muted block mb-1">Port</label>
                <input value={settings.imap_port || '993'} onChange={e => updateSetting('imap_port', e.target.value)} className="w-full px-3 py-2 bg-nebula-bg border border-nebula-border rounded text-sm text-nebula-text focus:outline-none focus:border-nebula-accent" />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm mt-3">
              <input type="checkbox" checked={settings.mail_enabled === '1'} onChange={e => updateSetting('mail_enabled', e.target.checked ? '1' : '0')} className="accent-nebula-accent" />
              Enable mail access for agents
            </label>
          </div>
        </div>
      )}

      {tab === 'runtimes' && (
        <SettingsRuntimesTab
          runtimes={runtimes} setRuntimes={setRuntimes}
          runtimeDefault={runtimeDefault} setRuntimeDefault={setRuntimeDefault}
          runtimesLoading={runtimesLoading}
        />
      )}

      {tab === 'knowledge' && (
        <div>
          <label className="text-xs text-nebula-muted block mb-2">Global CLAUDE.md — shared context for all agents</label>
          <textarea
            value={globalMd}
            onChange={e => setGlobalMd(e.target.value)}
            rows={20}
            className="w-full px-3 py-2 bg-nebula-bg border border-nebula-border rounded text-sm text-nebula-text font-mono focus:outline-none focus:border-nebula-accent resize-y"
            spellCheck={false}
          />
        </div>
      )}

      {tab === 'skills' && <SkillEditor scope="org" onMutate={refreshSecrets} />}
      {tab === 'mcp' && <McpServerEditor scope="org" onMutate={refreshSecrets} />}

      {tab === 'secrets' && (
        <div className="space-y-4">
          <p className="text-xs text-nebula-muted">
            Store API tokens and credentials securely. Reference them in custom skills as <code className="text-nebula-accent">{'{{KEY_NAME}}'}</code> — values are resolved at runtime and never shown in the UI.
          </p>
          <SecretsList
            load={() => getSecrets()}
            create={(key, value) => createSecret(key, value)}
            remove={(id) => deleteSecret(id)}
          />
          {secretRefs.filter(r => !r.configured).length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs text-nebula-muted font-medium">Required by skills (not yet configured):</p>
              {secretRefs.filter(r => !r.configured).map(r => (
                <div key={r.key} className="flex items-center justify-between bg-nebula-bg border border-yellow-600/30 rounded-lg px-3 py-2">
                  <div className="flex-1 min-w-0">
                    <code className="text-sm text-yellow-400 font-mono">{`{{${r.key}}}`}</code>
                    <span className="text-[11px] text-nebula-muted ml-3">
                      used by: {r.sources.map(s => s.name).join(', ')}
                    </span>
                  </div>
                  <button
                    onClick={() => { setNewSecretKey(r.key); }}
                    className="text-xs text-nebula-accent hover:brightness-110 px-2"
                  >
                    Configure
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="bg-nebula-surface-2 border border-nebula-border rounded-lg p-3 mt-4">
            <p className="text-xs text-nebula-muted mb-1.5 font-medium">Usage in custom skills:</p>
            <code className="text-[11px] text-nebula-accent block">curl -H "Authorization: Bearer {'{{GITEA_TOKEN}}'}" ...</code>
            <p className="text-[11px] text-nebula-muted mt-2">Secrets are replaced at execution time. The actual values never appear in conversation history, skill definitions, or the UI.</p>
          </div>
        </div>
      )}

      {tab === 'system' && (
        <SettingsSystemTab
          status={status} settings={settings} updateSetting={updateSetting}
          cleanupStatus={cleanupStatus} setCleanupStatus={setCleanupStatus}
          setError={setError}
        />
      )}

      {error && <p className="text-red-400 text-sm mt-4">{error}</p>}

      <div className="flex justify-end gap-2 mt-6 pt-4 border-t border-nebula-border">
        <button onClick={onClose} className="px-4 py-2 text-sm text-nebula-muted hover:text-nebula-text">Close</button>
        <button onClick={handleSave} disabled={saving} className="px-4 py-2 text-sm bg-nebula-accent text-white rounded hover:opacity-90 disabled:opacity-50">
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </Modal>
  );
}
