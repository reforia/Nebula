import { useState } from 'react';
import { exportTemplate, importTemplate, getTemplate, OrgTemplate, TemplateSummary } from '../api/client';
import { useAuth } from '../contexts/AuthContext';

interface Props {
  availableTemplates: TemplateSummary[];
  setError: (e: string) => void;
  onRefresh?: () => void;
}

export default function SettingsTemplatesTab({ availableTemplates, setError, onRefresh }: Props) {
  const { currentOrg } = useAuth();
  const [importStatus, setImportStatus] = useState('');
  const [previewTemplate, setPreviewTemplate] = useState<OrgTemplate | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  return (
    <div className="space-y-4">
      <p className="text-[11px] text-nebula-muted">Apply a template to add pre-configured agents, skills, and tasks. Nothing existing is overwritten.</p>

      <div className="flex gap-2 items-center">
        <button
          onClick={async () => {
            try {
              const tpl = await exportTemplate();
              const blob = new Blob([JSON.stringify(tpl, null, 2)], { type: 'application/json' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `template-${(currentOrg?.name || 'org').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`;
              a.click();
              URL.revokeObjectURL(url);
            } catch (err: any) { setError(err.message); }
          }}
          className="px-3 py-1.5 text-xs bg-nebula-surface-2 border border-nebula-border rounded hover:bg-nebula-hover text-nebula-muted"
        >
          Export This Org
        </button>
        <label className="px-3 py-1.5 text-xs bg-nebula-surface-2 border border-nebula-border rounded hover:bg-nebula-hover text-nebula-muted cursor-pointer">
          Import from File
          <input type="file" accept=".json" className="hidden" onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            e.target.value = '';
            try {
              const text = await file.text();
              const tpl = JSON.parse(text);
              const agentCount = tpl.agents?.length || 0;
              const skillCount = (tpl.skills?.length || 0) + (tpl.agents || []).reduce((s: number, a: any) => s + (a.skills?.length || 0), 0);
              const taskCount = (tpl.agents || []).reduce((s: number, a: any) => s + (a.tasks?.length || 0), 0);
              if (!confirm(`Import "${tpl.name || 'template'}"?\n\n${agentCount} agents, ${skillCount} skills, ${taskCount} tasks\n\nThis will add to your org (nothing is overwritten).`)) return;
              const result = await importTemplate(tpl);
              setImportStatus(`Imported: ${result.created.agents} agents, ${result.created.skills} skills, ${result.created.tasks} tasks, ${result.created.mcp_servers} MCP servers`);
              setTimeout(() => setImportStatus(''), 5000);
              onRefresh?.();
            } catch (err: any) { setError(err.message || 'Invalid template file'); }
          }} />
        </label>
      </div>

      {importStatus && <p className="text-xs text-green-400">{importStatus}</p>}

      {availableTemplates.length > 0 && !previewTemplate && (
        <div className="grid grid-cols-2 gap-2">
          {availableTemplates.map(t => (
            <button
              key={t.id}
              onClick={async () => {
                setPreviewLoading(true);
                try {
                  const tpl = await getTemplate(t.id);
                  setPreviewTemplate(tpl);
                } catch (err: any) { setError(err.message); }
                finally { setPreviewLoading(false); }
              }}
              disabled={previewLoading}
              className="text-left bg-nebula-bg border border-nebula-border rounded-lg p-3 hover:border-nebula-accent/50 transition-colors disabled:opacity-50"
            >
              <div className="flex items-center gap-2 mb-1">
                {t.icon && <span className="text-lg">{t.icon}</span>}
                <span className="text-[13px] font-medium text-nebula-text">{t.name}</span>
              </div>
              <p className="text-[11px] text-nebula-muted line-clamp-2">{t.description}</p>
              <p className="text-[10px] text-nebula-muted mt-1.5">{t.agents} agents, {t.skills} skills, {t.tasks} tasks</p>
            </button>
          ))}
        </div>
      )}

      {previewTemplate && (
        <div className="bg-nebula-bg border border-nebula-border rounded-lg p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h5 className="text-sm font-medium text-nebula-text">{previewTemplate.name}</h5>
            <button onClick={() => setPreviewTemplate(null)} className="text-xs text-nebula-muted hover:text-nebula-text">&times; Close</button>
          </div>
          {previewTemplate.description && (
            <p className="text-[12px] text-nebula-muted">{previewTemplate.description}</p>
          )}

          <div>
            <p className="text-[11px] text-nebula-muted font-medium mb-1">Agents</p>
            <div className="space-y-1">
              {previewTemplate.agents.map((a: any, i: number) => (
                <div key={i} className="bg-nebula-surface border border-nebula-border rounded px-2.5 py-1.5">
                  <span className="text-[12px] text-nebula-text font-medium">{a.name}</span>
                  <span className="text-[10px] text-nebula-muted ml-2">{a.model}</span>
                  {a.tasks.length > 0 && <span className="text-[10px] text-nebula-accent ml-2">{a.tasks.length} tasks</span>}
                  <p className="text-[10px] text-nebula-muted mt-0.5 line-clamp-1">{a.role}</p>
                </div>
              ))}
            </div>
          </div>

          {previewTemplate.skills.length > 0 && (
            <div>
              <p className="text-[11px] text-nebula-muted font-medium mb-1">Org-wide Skills</p>
              <div className="flex flex-wrap gap-1">
                {previewTemplate.skills.map((s: any, i: number) => (
                  <span key={i} className="text-[10px] bg-nebula-surface border border-nebula-border rounded px-2 py-0.5 text-nebula-muted">{s.name}</span>
                ))}
              </div>
            </div>
          )}

          {(() => {
            const allContent = [
              ...previewTemplate.skills.map((s: any) => s.content),
              ...previewTemplate.agents.flatMap((a: any) => a.skills.map((s: any) => s.content)),
            ].join(' ');
            const refs = [...new Set([...allContent.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map(m => m[1]))];
            return refs.length > 0 ? (
              <div>
                <p className="text-[11px] text-yellow-400 font-medium mb-1">Required Secrets</p>
                <div className="flex flex-wrap gap-1">
                  {refs.map(r => (
                    <code key={r} className="text-[10px] bg-yellow-900/20 border border-yellow-600/30 rounded px-2 py-0.5 text-yellow-400">{`{{${r}}}`}</code>
                  ))}
                </div>
                <p className="text-[10px] text-nebula-muted mt-1">Configure these in the Secrets tab after importing.</p>
              </div>
            ) : null;
          })()}

          <button
            onClick={async () => {
              try {
                const result = await importTemplate(previewTemplate);
                setImportStatus(`Imported: ${result.created.agents} agents, ${result.created.skills} skills, ${result.created.tasks} tasks`);
                setPreviewTemplate(null);
                setTimeout(() => setImportStatus(''), 5000);
                onRefresh?.();
              } catch (err: any) { setError(err.message); }
            }}
            className="w-full py-2 text-xs bg-nebula-accent text-nebula-bg rounded hover:brightness-110 font-medium"
          >
            Apply Template
          </button>
        </div>
      )}

      <p className="text-[10px] text-nebula-muted">Add custom templates to <code className="text-nebula-accent">/data/templates/</code> as JSON files.</p>
    </div>
  );
}
