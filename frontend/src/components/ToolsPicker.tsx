import { useMemo } from 'react';

const TOOL_GROUPS: { label: string; tools: { name: string; desc: string }[] }[] = [
  {
    label: 'File Access',
    tools: [
      { name: 'Read', desc: 'Read files' },
      { name: 'Write', desc: 'Create files' },
      { name: 'Edit', desc: 'Edit files' },
      { name: 'Glob', desc: 'Find files by pattern' },
      { name: 'Grep', desc: 'Search file contents' },
    ],
  },
  {
    label: 'Execution',
    tools: [
      { name: 'Bash', desc: 'Run shell commands' },
    ],
  },
  {
    label: 'Web',
    tools: [
      { name: 'WebFetch', desc: 'Fetch URLs' },
      { name: 'WebSearch', desc: 'Web search' },
    ],
  },
  {
    label: 'Notebook',
    tools: [
      { name: 'NotebookEdit', desc: 'Edit Jupyter notebooks' },
    ],
  },
];

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** When false, hide Web tools group (runtime doesn't have built-in web tools) */
  hasBuiltinWebTools?: boolean;
}

export default function ToolsPicker({ value, onChange, hasBuiltinWebTools = true }: Props) {
  const selected = useMemo(
    () => new Set(value.split(',').map(t => t.trim()).filter(Boolean)),
    [value]
  );

  const toggle = (tool: string) => {
    const next = new Set(selected);
    if (next.has(tool)) {
      next.delete(tool);
    } else {
      next.add(tool);
    }
    onChange([...next].join(','));
  };

  return (
    <div className="space-y-2">
      {TOOL_GROUPS.filter(group => hasBuiltinWebTools || group.label !== 'Web').map(group => (
        <div key={group.label}>
          <p className="text-[10px] text-nebula-muted uppercase tracking-wider mb-1">{group.label}</p>
          <div className="flex flex-wrap gap-1.5">
            {group.tools.map(tool => {
              const isOn = selected.has(tool.name);
              return (
                <button
                  key={tool.name}
                  type="button"
                  onClick={() => toggle(tool.name)}
                  title={tool.desc}
                  className={`px-2.5 py-1 text-[12px] rounded-md border transition-colors ${
                    isOn
                      ? 'bg-nebula-accent/10 border-nebula-accent/30 text-nebula-accent font-medium'
                      : 'bg-nebula-bg border-nebula-border text-nebula-muted hover:border-nebula-border-light'
                  }`}
                >
                  {tool.name}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
