interface Props {
  type: 'chat' | 'task' | 'error' | 'system' | 'agent';
  taskName?: string;
}

export default function StatusBadge({ type, taskName }: Props) {
  if (type === 'chat' || type === 'agent') return null;

  const styles: Record<string, string> = {
    task: 'bg-nebula-accent/10 text-nebula-accent border-nebula-accent/20',
    error: 'bg-nebula-red/10 text-nebula-red border-nebula-red/20',
    system: 'bg-nebula-surface-2 text-nebula-muted border-nebula-border',
  };

  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded-md border font-medium ${styles[type] || styles.system}`}>
      {type === 'task' && taskName ? taskName : type}
    </span>
  );
}
