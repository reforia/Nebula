import { dismissError, dismissAllErrors, getErrors, getStatus, ExecutionError, OrgStatus } from '../api/client';
import { useToast } from '../contexts/ToastContext';

function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + 'B';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

interface Props {
  orgName: string;
  setOrgName: (v: string) => void;
  settings: Record<string, string>;
  updateSetting: (key: string, value: string) => void;
  status: OrgStatus | null;
  setStatus: (s: OrgStatus) => void;
  errors: ExecutionError[];
  setErrors: (e: ExecutionError[]) => void;
  showErrors: boolean;
  setShowErrors: (v: boolean) => void;
}

export default function SettingsGeneralTab({
  orgName, setOrgName, settings, updateSetting,
  status, setStatus, errors, setErrors, showErrors, setShowErrors,
}: Props) {
  const { reportError } = useToast();

  return (
    <div className="space-y-5">
      <div>
        <label className="text-xs text-nebula-muted block mb-1">Organization Name</label>
        <input
          value={orgName}
          onChange={e => setOrgName(e.target.value)}
          className="w-full px-3 py-2 bg-nebula-bg border border-nebula-border rounded text-sm text-nebula-text focus:outline-none focus:border-nebula-accent"
        />
      </div>

      <div>
        <label className="text-xs text-nebula-muted block mb-1">Default Agent Timeout (minutes)</label>
        <input
          type="number"
          value={Math.round(parseInt(settings.default_timeout_ms || '600000') / 60000)}
          onChange={e => updateSetting('default_timeout_ms', String((parseInt(e.target.value) || 10) * 60000))}
          min={1} max={120}
          className="w-full px-3 py-2 bg-nebula-bg border border-nebula-border rounded text-sm text-nebula-text focus:outline-none focus:border-nebula-accent"
        />
        <p className="text-[10px] text-nebula-muted mt-1">Default execution timeout for new agents. Each agent can override this in their settings.</p>
      </div>

      <div>
        <label className="text-xs text-nebula-muted block mb-1">Session Recovery Token Budget</label>
        <input
          type="number"
          value={parseInt(settings.recovery_token_budget || '25000') || 25000}
          onChange={e => updateSetting('recovery_token_budget', String(parseInt(e.target.value) || 25000))}
          min={1000} max={200000} step={1000}
          className="w-full px-3 py-2 bg-nebula-bg border border-nebula-border rounded text-sm text-nebula-text focus:outline-none focus:border-nebula-accent"
        />
        <p className="text-[10px] text-nebula-muted mt-1">Max tokens of conversation history to recover when an agent session resets (~4 chars/token). Each agent can override this.</p>
      </div>

      <div className="flex gap-3">
        <div className="flex-1">
          <label className="text-xs text-nebula-muted block mb-1">@Mention Context Messages</label>
          <input
            type="number"
            value={parseInt(settings.mention_context_messages || '10') || 10}
            onChange={e => updateSetting('mention_context_messages', String(parseInt(e.target.value) || 10))}
            min={1} max={50}
            className="w-full px-3 py-2 bg-nebula-bg border border-nebula-border rounded text-sm text-nebula-text focus:outline-none focus:border-nebula-accent"
          />
        </div>
        <div className="flex-1">
          <label className="text-xs text-nebula-muted block mb-1">Max Chars per Message</label>
          <input
            type="number"
            value={parseInt(settings.mention_context_chars || '0') || 0}
            onChange={e => updateSetting('mention_context_chars', String(parseInt(e.target.value) || 0))}
            min={0} max={10000} step={500}
            className="w-full px-3 py-2 bg-nebula-bg border border-nebula-border rounded text-sm text-nebula-text focus:outline-none focus:border-nebula-accent"
          />
        </div>
      </div>
      <p className="text-[10px] text-nebula-muted mt-1">How many recent messages are passed as context when an agent is @mentioned. Max chars = 0 means no truncation. Each agent can override.</p>

      <div className="flex items-center justify-between">
        <div>
          <label className="text-xs text-nebula-text block">Scheduled Tasks</label>
          <p className="text-[10px] text-nebula-muted">Enable or disable all cron and webhook task execution org-wide.</p>
        </div>
        <button
          onClick={() => updateSetting('cron_enabled', settings.cron_enabled === '0' ? '1' : '0')}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
            settings.cron_enabled !== '0' ? 'bg-nebula-accent' : 'bg-nebula-border'
          }`}
        >
          <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
            settings.cron_enabled !== '0' ? 'translate-x-[18px]' : 'translate-x-[3px]'
          }`} />
        </button>
      </div>

      <div>
        <label className="text-xs text-nebula-muted block mb-1">Task Stagger Delay (minutes)</label>
        <input
          type="number"
          value={Math.round(parseInt(settings.task_stagger_ms || '0') / 60000)}
          onChange={e => updateSetting('task_stagger_ms', String((parseInt(e.target.value) || 0) * 60000))}
          min={0} max={30}
          className="w-full px-3 py-2 bg-nebula-bg border border-nebula-border rounded text-sm text-nebula-text focus:outline-none focus:border-nebula-accent"
        />
        <p className="text-[10px] text-nebula-muted mt-1">Delay between concurrent cron tasks to avoid API rate limits. 0 = no stagger (all fire simultaneously).</p>
      </div>

      {status && (
        <div>
          <label className="text-xs text-nebula-muted block mb-2">Overview</label>
          <div className="grid grid-cols-3 gap-2">
            {[
              { label: 'Agents', value: status.agents },
              { label: 'Active Tasks', value: status.active_tasks },
              { label: 'Messages', value: status.total_messages.toLocaleString() },
            ].map(s => (
              <div key={s.label} className="bg-nebula-bg border border-nebula-border rounded-lg p-3 text-center">
                <p className="text-lg font-semibold text-nebula-text">{s.value}</p>
                <p className="text-[11px] text-nebula-muted">{s.label}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {status?.usage && (
        <div>
          <label className="text-xs text-nebula-muted block mb-2">Usage (last 30 days)</label>
          <div className="grid grid-cols-3 gap-2 mb-3">
            <div className="bg-nebula-bg border border-nebula-border rounded-lg p-3 text-center">
              <p className="text-lg font-semibold text-nebula-text">{status.usage.last_30d.executions.toLocaleString()}</p>
              <p className="text-[11px] text-nebula-muted">Executions</p>
            </div>
            <div className="bg-nebula-bg border border-nebula-border rounded-lg p-3 text-center">
              <p className="text-lg font-semibold text-nebula-text">{formatTokens(status.usage.last_30d.tokens_in + status.usage.last_30d.tokens_out)}</p>
              <p className="text-[11px] text-nebula-muted">Tokens</p>
            </div>
            <div className="bg-nebula-bg border border-nebula-border rounded-lg p-3 text-center">
              <p className="text-lg font-semibold text-nebula-text">${status.usage.last_30d.cost.toFixed(2)}</p>
              <p className="text-[11px] text-nebula-muted">Cost</p>
            </div>
          </div>

          <div className="bg-nebula-bg border border-nebula-border rounded-lg p-3 mb-3">
            <p className="text-[11px] text-nebula-muted mb-1">All time</p>
            <p className="text-sm text-nebula-text">
              {status.usage.total.executions.toLocaleString()} executions
              <span className="text-nebula-muted mx-1.5">/</span>
              {formatTokens(status.usage.total.tokens_in + status.usage.total.tokens_out)} tokens
              <span className="text-nebula-muted mx-1.5">/</span>
              ${status.usage.total.cost.toFixed(2)}
              {status.usage.total.errors > 0 && (
                <button
                  onClick={() => { setShowErrors(!showErrors); if (!showErrors) getErrors(50).then(setErrors).catch(e => reportError(e, 'Failed to load errors')); }}
                  className="text-nebula-red ml-2 hover:underline"
                >
                  ({status.usage.total.errors} errors)
                </button>
              )}
            </p>
          </div>

          {showErrors && (
            <div className="bg-nebula-bg border border-nebula-border rounded-lg p-3 mb-3">
              <div className="flex items-center justify-between mb-2">
                <p className="text-[11px] text-nebula-muted">Recent errors</p>
                <div className="flex items-center gap-2">
                  {errors.length > 0 && (
                    <button
                      onClick={async () => {
                        if (!confirm('Dismiss all errors?')) return;
                        await dismissAllErrors();
                        setErrors([]);
                        setShowErrors(false);
                        getStatus().then(setStatus).catch(e => reportError(e, 'Failed to refresh status'));
                      }}
                      className="text-[11px] text-nebula-red hover:text-red-300"
                    >
                      Dismiss all
                    </button>
                  )}
                  <button onClick={() => setShowErrors(false)} className="text-[11px] text-nebula-muted hover:text-nebula-text">&times;</button>
                </div>
              </div>
              {errors.length === 0 ? (
                <p className="text-[11px] text-nebula-muted text-center py-2">No errors recorded</p>
              ) : (
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {errors.map(e => (
                    <div key={e.id} className="border-b border-nebula-border pb-2 last:border-0 last:pb-0">
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="text-nebula-text">{e.agent_emoji} {e.agent_name}</span>
                        <div className="flex items-center gap-2">
                          <span className="text-nebula-muted">{new Date(e.created_at + 'Z').toLocaleString()}</span>
                          <button
                            onClick={async () => {
                              await dismissError(e.id);
                              setErrors(errors.filter(err => err.id !== e.id));
                              getStatus().then(setStatus).catch(e => reportError(e, 'Failed to refresh status'));
                            }}
                            className="text-nebula-muted hover:text-nebula-text text-[10px]"
                            title="Dismiss"
                          >
                            &times;
                          </button>
                        </div>
                      </div>
                      <p className="text-[11px] text-nebula-red mt-0.5 font-mono break-all">{e.error_message || 'Unknown error'}</p>
                      <p className="text-[10px] text-nebula-muted mt-0.5">{e.backend} / {e.model}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {status.usage.top_models.length > 0 && (
            <div className="bg-nebula-bg border border-nebula-border rounded-lg p-3 mb-3">
              <p className="text-[11px] text-nebula-muted mb-2">Top models</p>
              <div className="space-y-1.5">
                {status.usage.top_models.map(m => (
                  <div key={m.model} className="flex items-center justify-between text-[12px]">
                    <span className="text-nebula-text truncate flex-1 font-mono">{m.model}</span>
                    <span className="text-nebula-muted ml-2 flex-shrink-0">
                      {m.executions}x / ${m.cost.toFixed(2)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {status.usage.top_agents.length > 0 && (
            <div className="bg-nebula-bg border border-nebula-border rounded-lg p-3">
              <p className="text-[11px] text-nebula-muted mb-2">Top agents</p>
              <div className="space-y-1.5">
                {status.usage.top_agents.map(a => (
                  <div key={a.agent_id} className="flex items-center justify-between text-[12px]">
                    <span className="text-nebula-text truncate flex-1">{a.agent_emoji} {a.agent_name}</span>
                    <span className="text-nebula-muted ml-2 flex-shrink-0">
                      {a.executions}x / ${a.cost.toFixed(2)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
