import { useState } from 'react';
import {
  McpServer,
  getOrgMcpServers, createOrgMcpServer, updateOrgMcpServer, deleteOrgMcpServer,
  getAgentMcpServers, createAgentMcpServer, updateAgentMcpServer, deleteAgentMcpServer,
} from '../api/client';
import CrudList from './CrudList';
import KeyValueEditor from './KeyValueEditor';

interface Props {
  scope: 'org' | 'agent';
  agentId?: string;
  onMutate?: () => void;
}

interface StdioConfig { command: string; args?: string[]; env?: Record<string, string>; }
interface RemoteConfig { url: string; headers?: Record<string, string>; }
type ServerConfig = StdioConfig | RemoteConfig;

function parseConfig(configStr: string): ServerConfig {
  try { return JSON.parse(configStr); } catch { return { command: '' }; }
}

export default function McpServerEditor({ scope, agentId, onMutate }: Props) {
  return (
    <CrudList<McpServer>
      onMutate={onMutate}
      scope={scope}
      agentId={agentId}
      orgLabel="Organization-wide MCP servers — available to all agents"
      agentLabel="Agent-specific MCP servers"
      emptyText="No MCP servers configured"
      addLabel="+ Add Server"
      itemKind="MCP server"
      load={() => scope === 'org' ? getOrgMcpServers() : getAgentMcpServers(agentId!)}
      onUpdate={async (server, updates) => {
        if (scope === 'org' || server.agent_id === null) {
          await updateOrgMcpServer(server.id, updates);
        } else {
          await updateAgentMcpServer(agentId!, server.id, updates);
        }
      }}
      onDelete={async (server) => {
        if (scope === 'org' || server.agent_id === null) {
          await deleteOrgMcpServer(server.id);
        } else {
          await deleteAgentMcpServer(agentId!, server.id);
        }
      }}
      renderCreateForm={({ onCreated }) => <CreateMcpForm scope={scope} agentId={agentId} onCreated={onCreated} />}
      renderSubtitle={(server) => {
        const config = parseConfig(server.config);
        const isStdio = server.transport === 'stdio';
        const detail = isStdio
          ? (config as StdioConfig).command ? ` — ${(config as StdioConfig).command}` : ''
          : (config as RemoteConfig).url ? ` — ${(config as RemoteConfig).url}` : '';
        return <p className="text-[11px] text-nebula-muted">{server.transport.toUpperCase()}{detail}</p>;
      }}
      renderEditor={(server, { items, setItems, saving, onSave }) => (
        <McpEditorFields server={server} items={items} setItems={setItems} saving={saving === server.id} onSave={onSave} />
      )}
      footer={
        <div className="bg-nebula-surface-2 border border-nebula-border rounded-lg p-3 mt-2">
          <p className="text-[11px] text-nebula-muted">
            MCP servers extend agent capabilities with external tools and data sources.
            Use <code className="text-nebula-accent">{'{{SECRET_NAME}}'}</code> in env vars and headers to reference vault secrets.
          </p>
        </div>
      }
    />
  );
}

function CreateMcpForm({ scope, agentId, onCreated }: { scope: 'org' | 'agent'; agentId?: string; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<'stdio' | 'http' | 'sse'>('stdio');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const defaultConfig = transport === 'stdio' ? { command: '', args: [], env: {} } : { url: '', headers: {} };
    try {
      if (scope === 'org') {
        await createOrgMcpServer({ name: name.trim(), transport, config: JSON.stringify(defaultConfig) });
      } else {
        await createAgentMcpServer(agentId!, { name: name.trim(), transport, config: JSON.stringify(defaultConfig) });
      }
      setName('');
      setTransport('stdio');
      onCreated();
    } catch (err) {
      console.error('Failed to create MCP server:', err);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="bg-nebula-bg border border-nebula-border rounded-lg p-3 space-y-2">
      <input type="text" placeholder="Server name (e.g. filesystem, github)" value={name} onChange={e => setName(e.target.value)}
        className="w-full px-3 py-2 bg-nebula-surface border border-nebula-border rounded text-sm text-nebula-text focus:outline-none focus:border-nebula-accent/50" autoFocus />
      <div className="flex gap-2">
        {(['stdio', 'http', 'sse'] as const).map(t => (
          <button key={t} type="button" onClick={() => setTransport(t)}
            className={`flex-1 py-1.5 text-xs rounded border transition-colors ${
              transport === t ? 'bg-nebula-accent/10 border-nebula-accent/30 text-nebula-accent' : 'bg-nebula-bg border-nebula-border text-nebula-muted'
            }`}>{t.toUpperCase()}</button>
        ))}
      </div>
      <button type="submit" className="px-3 py-1.5 text-[12px] bg-nebula-accent text-nebula-bg rounded font-medium hover:brightness-110">Create</button>
    </form>
  );
}

function McpEditorFields({ server, items, setItems, saving, onSave }: {
  server: McpServer; items: McpServer[]; setItems: React.Dispatch<React.SetStateAction<McpServer[]>>;
  saving: boolean; onSave: (updates: Partial<McpServer>) => void;
}) {
  const config = parseConfig(server.config);
  const isStdio = server.transport === 'stdio';

  const updateLocal = (field: string, value: any) => {
    setItems(prev => prev.map(s => s.id === server.id ? { ...s, [field]: value } : s));
  };
  const updateConfig = (newConfig: ServerConfig) => {
    setItems(prev => prev.map(s => s.id === server.id ? { ...s, config: JSON.stringify(newConfig) } : s));
  };

  return (
    <div className="space-y-3">
      <div>
        <label className="text-[10px] text-nebula-muted block mb-1">Name</label>
        <input value={server.name} onChange={e => updateLocal('name', e.target.value)}
          className="w-full px-2 py-1.5 bg-nebula-surface border border-nebula-border rounded text-sm text-nebula-text font-mono focus:outline-none focus:border-nebula-accent/50" />
      </div>

      <div>
        <label className="text-[10px] text-nebula-muted block mb-1">Transport</label>
        <div className="flex gap-2">
          {(['stdio', 'http', 'sse'] as const).map(t => (
            <button key={t} type="button"
              onClick={() => {
                const newConfig = t === 'stdio' ? { command: '', args: [], env: {} } : { url: '', headers: {} };
                setItems(prev => prev.map(s => s.id === server.id ? { ...s, transport: t, config: JSON.stringify(newConfig) } : s));
              }}
              className={`flex-1 py-1.5 text-xs rounded border transition-colors ${
                server.transport === t ? 'bg-nebula-accent/10 border-nebula-accent/30 text-nebula-accent' : 'bg-nebula-bg border-nebula-border text-nebula-muted'
              }`}>{t.toUpperCase()}</button>
          ))}
        </div>
      </div>

      {isStdio ? (
        <>
          <div>
            <label className="text-[10px] text-nebula-muted block mb-1">Command</label>
            <input value={(config as StdioConfig).command || ''} onChange={e => updateConfig({ ...config as StdioConfig, command: e.target.value })}
              placeholder="npx" className="w-full px-2 py-1.5 bg-nebula-surface border border-nebula-border rounded text-sm text-nebula-text font-mono focus:outline-none focus:border-nebula-accent/50" />
          </div>
          <div>
            <label className="text-[10px] text-nebula-muted block mb-1">Arguments (one per line)</label>
            <textarea value={((config as StdioConfig).args || []).join('\n')}
              onChange={e => { const args = e.target.value.split('\n').filter(a => a.length > 0 || e.target.value.endsWith('\n')); updateConfig({ ...config as StdioConfig, args }); }}
              rows={3} placeholder={"-y\n@modelcontextprotocol/server-filesystem\n/data"}
              className="w-full px-2 py-1.5 bg-nebula-surface border border-nebula-border rounded text-[12px] text-nebula-text font-mono focus:outline-none focus:border-nebula-accent/50 resize-y" spellCheck={false} />
          </div>
          <div>
            <label className="text-[10px] text-nebula-muted block mb-1">Environment Variables <span className="text-nebula-accent">{'{{SECRET}}'} supported</span></label>
            <KeyValueEditor entries={Object.entries((config as StdioConfig).env || {})}
              onChange={entries => { const env = Object.fromEntries(entries.filter(([k]) => k)); updateConfig({ ...config as StdioConfig, env }); }}
              keyPlaceholder="KEY" valuePlaceholder="value or {{SECRET}}" />
          </div>
        </>
      ) : (
        <>
          <div>
            <label className="text-[10px] text-nebula-muted block mb-1">URL</label>
            <input value={(config as RemoteConfig).url || ''} onChange={e => updateConfig({ ...config as RemoteConfig, url: e.target.value })}
              placeholder="https://mcp.example.com/mcp" className="w-full px-2 py-1.5 bg-nebula-surface border border-nebula-border rounded text-sm text-nebula-text font-mono focus:outline-none focus:border-nebula-accent/50" />
          </div>
          <div>
            <label className="text-[10px] text-nebula-muted block mb-1">Headers <span className="text-nebula-accent">{'{{SECRET}}'} supported</span></label>
            <KeyValueEditor entries={Object.entries((config as RemoteConfig).headers || {})}
              onChange={entries => { const headers = Object.fromEntries(entries.filter(([k]) => k)); updateConfig({ ...config as RemoteConfig, headers }); }}
              keyPlaceholder="Header" valuePlaceholder="value or {{SECRET}}" />
          </div>
        </>
      )}

      <div className="flex justify-end">
        <button onClick={() => onSave({ name: server.name, transport: server.transport, config: server.config })}
          disabled={saving} className="px-3 py-1.5 text-[12px] bg-nebula-accent text-nebula-bg rounded font-medium hover:brightness-110 disabled:opacity-50">
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  );
}
