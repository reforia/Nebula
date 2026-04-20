import { useState } from 'react';
import MarkdownViewer from './MarkdownViewer';
import { getProjectVaultFile } from '../api/client';
import { useToast } from '../contexts/ToastContext';

interface Props {
  projectId: string;
  files: string[];
  content: { path: string; content: string } | null;
  setContent: (c: { path: string; content: string } | null) => void;
}

export default function ProjectVaultTab({ projectId, files, content, setContent }: Props) {
  const { reportError } = useToast();
  const [mdViewing, setMdViewing] = useState<{ path: string; content: string } | null>(null);

  const openFile = async (filePath: string) => {
    try {
      const text = await getProjectVaultFile(projectId, filePath);
      if (filePath.endsWith('.md')) {
        setMdViewing({ path: filePath, content: text });
      } else {
        setContent({ path: filePath, content: text });
      }
    } catch (err) {
      reportError(err, 'Failed to open vault file');
    }
  };

  if (content) {
    return (
      <div className="p-6">
        <button onClick={() => setContent(null)} className="text-[12px] text-nebula-accent hover:underline mb-3 flex items-center gap-1">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
          Back to files
        </button>
        <div className="bg-nebula-surface border border-nebula-border rounded-lg p-4">
          <p className="text-[11px] text-nebula-muted font-mono mb-3">{content.path}</p>
          <pre className="text-[12px] text-nebula-text whitespace-pre-wrap font-mono leading-relaxed">{content.content}</pre>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      {files.length === 0 ? (
        <p className="text-center text-nebula-muted text-sm py-12">No files in vault yet</p>
      ) : (
        <div className="space-y-1">
          {files.map(f => (
            <button
              key={f} onClick={() => openFile(f)}
              className="w-full text-left px-4 py-2.5 bg-nebula-surface border border-nebula-border rounded-lg hover:bg-nebula-hover transition-colors flex items-center gap-3"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-nebula-muted"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
              <span className="text-[13px] text-nebula-text font-mono">{f}</span>
            </button>
          ))}
        </div>
      )}
      {mdViewing && (
        <MarkdownViewer
          initialContent={mdViewing.content}
          filePath={mdViewing.path}
          onClose={() => setMdViewing(null)}
        />
      )}
    </div>
  );
}
