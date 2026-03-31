interface Props {
  entries: [string, string][];
  onChange: (entries: [string, string][]) => void;
  keyPlaceholder: string;
  valuePlaceholder: string;
}

export default function KeyValueEditor({ entries, onChange, keyPlaceholder, valuePlaceholder }: Props) {
  return (
    <div className="space-y-1">
      {entries.map(([k, v], i) => (
        <div key={i} className="flex gap-1.5">
          <input
            value={k}
            onChange={e => {
              const next = [...entries] as [string, string][];
              next[i] = [e.target.value, v];
              onChange(next);
            }}
            placeholder={keyPlaceholder}
            className="flex-1 px-2 py-1 bg-nebula-surface border border-nebula-border rounded text-[12px] text-nebula-text font-mono focus:outline-none focus:border-nebula-accent/50"
          />
          <input
            value={v}
            onChange={e => {
              const next = [...entries] as [string, string][];
              next[i] = [k, e.target.value];
              onChange(next);
            }}
            placeholder={valuePlaceholder}
            className="flex-1 px-2 py-1 bg-nebula-surface border border-nebula-border rounded text-[12px] text-nebula-text font-mono focus:outline-none focus:border-nebula-accent/50"
          />
          <button
            onClick={() => onChange(entries.filter((_, j) => j !== i))}
            className="text-nebula-muted hover:text-nebula-red text-xs px-1"
          >&times;</button>
        </div>
      ))}
      <button
        onClick={() => onChange([...entries, ['', '']])}
        className="text-[11px] text-nebula-accent hover:underline"
      >+ Add</button>
    </div>
  );
}
