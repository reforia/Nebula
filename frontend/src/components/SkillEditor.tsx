import { useState } from 'react';
import {
  CustomSkill,
  getOrgSkills, createOrgSkill, updateOrgSkill, deleteOrgSkill,
  getAgentSkills, createAgentSkill, updateAgentSkill, deleteAgentSkill,
} from '../api/client';
import CrudList from './CrudList';

interface Props {
  scope: 'org' | 'agent';
  agentId?: string;
  onMutate?: () => void;
}

export default function SkillEditor({ scope, agentId, onMutate }: Props) {
  return (
    <CrudList<CustomSkill>
      onMutate={onMutate}
      scope={scope}
      agentId={agentId}
      orgLabel="Organization-wide skills — available to all agents"
      agentLabel="Agent-specific skills"
      emptyText="No custom skills yet"
      addLabel="+ New Skill"
      itemKind="skill"
      load={() => scope === 'org' ? getOrgSkills() : getAgentSkills(agentId!)}
      onUpdate={async (skill, updates) => {
        if (scope === 'org' || skill.agent_id === null) {
          await updateOrgSkill(skill.id, updates);
        } else {
          await updateAgentSkill(agentId!, skill.id, updates);
        }
      }}
      onDelete={async (skill) => {
        if (scope === 'org' || skill.agent_id === null) {
          await deleteOrgSkill(skill.id);
        } else {
          await deleteAgentSkill(agentId!, skill.id);
        }
      }}
      renderCreateForm={({ onCreated }) => <CreateSkillForm scope={scope} agentId={agentId} onCreated={onCreated} />}
      renderSubtitle={(skill) => skill.description ? <p className="text-[11px] text-nebula-muted truncate">{skill.description}</p> : null}
      renderEditor={(skill, { items, setItems, saving, onSave }) => (
        <SkillEditorFields skill={skill} items={items} setItems={setItems} saving={saving === skill.id} onSave={onSave} />
      )}
    />
  );
}

function CreateSkillForm({ scope, agentId, onCreated }: { scope: 'org' | 'agent'; agentId?: string; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      if (scope === 'org') {
        await createOrgSkill({ name: name.trim(), description: description.trim() });
      } else {
        await createAgentSkill(agentId!, { name: name.trim(), description: description.trim() });
      }
      setName('');
      setDescription('');
      onCreated();
    } catch (err) {
      console.error('Failed to create skill:', err);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="bg-nebula-bg border border-nebula-border rounded-lg p-3 space-y-2">
      <input type="text" placeholder="Skill name (e.g. twitter-api)" value={name} onChange={e => setName(e.target.value)}
        className="w-full px-3 py-2 bg-nebula-surface border border-nebula-border rounded text-sm text-nebula-text focus:outline-none focus:border-nebula-accent/50" autoFocus />
      <input type="text" placeholder="Description (when should the agent use this?)" value={description} onChange={e => setDescription(e.target.value)}
        className="w-full px-3 py-2 bg-nebula-surface border border-nebula-border rounded text-sm text-nebula-text focus:outline-none focus:border-nebula-accent/50" />
      <button type="submit" className="px-3 py-1.5 text-[12px] bg-nebula-accent text-nebula-bg rounded font-medium hover:brightness-110">Create</button>
    </form>
  );
}

function SkillEditorFields({ skill, items, setItems, saving, onSave }: {
  skill: CustomSkill; items: CustomSkill[]; setItems: React.Dispatch<React.SetStateAction<CustomSkill[]>>;
  saving: boolean; onSave: (updates: Partial<CustomSkill>) => void;
}) {
  const update = (field: string, value: string) => {
    setItems(prev => prev.map(s => s.id === skill.id ? { ...s, [field]: value } : s));
  };

  return (
    <>
      <div>
        <label className="text-[10px] text-nebula-muted block mb-1">Name</label>
        <input value={skill.name} onChange={e => update('name', e.target.value)}
          className="w-full px-2 py-1.5 bg-nebula-surface border border-nebula-border rounded text-sm text-nebula-text font-mono focus:outline-none focus:border-nebula-accent/50" />
      </div>
      <div>
        <label className="text-[10px] text-nebula-muted block mb-1">Description (triggers skill activation)</label>
        <input value={skill.description} onChange={e => update('description', e.target.value)}
          className="w-full px-2 py-1.5 bg-nebula-surface border border-nebula-border rounded text-sm text-nebula-text focus:outline-none focus:border-nebula-accent/50" />
      </div>
      <div>
        <label className="text-[10px] text-nebula-muted block mb-1">Content (markdown — API docs, curl examples, credentials)</label>
        <textarea value={skill.content} onChange={e => update('content', e.target.value)} rows={12}
          className="w-full px-2 py-1.5 bg-nebula-surface border border-nebula-border rounded text-[12px] text-nebula-text font-mono focus:outline-none focus:border-nebula-accent/50 resize-y" spellCheck={false} />
      </div>
      <div className="flex justify-end">
        <button onClick={() => onSave({ name: skill.name, description: skill.description, content: skill.content })}
          disabled={saving} className="px-3 py-1.5 text-[12px] bg-nebula-accent text-nebula-bg rounded font-medium hover:brightness-110 disabled:opacity-50">
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </>
  );
}
