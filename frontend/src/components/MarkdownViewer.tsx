import { useState } from 'react';
import Modal from './Modal';
import MarkdownRenderer from './MarkdownRenderer';

interface Props {
  initialContent: string;
  filePath: string;
  editable?: boolean;
  onSave?: (content: string) => Promise<void>;
  onClose: () => void;
}

export default function MarkdownViewer({ initialContent, filePath, editable, onSave, onClose }: Props) {
  const [mode, setMode] = useState<'preview' | 'raw'>('preview');
  const [content, setContent] = useState(initialContent);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const dirty = editable && content !== initialContent;

  const handleSave = async () => {
    if (!onSave) return;
    setSaving(true);
    setError('');
    try {
      await onSave(content);
      onClose();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal onClose={onClose} size="xl" z={60}>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-nebula-text font-mono truncate">{filePath}</h3>
        <div className="flex items-center gap-1 bg-nebula-bg border border-nebula-border rounded-lg p-0.5 flex-shrink-0">
          <button
            onClick={() => setMode('preview')}
            className={`px-3 py-1 text-[11px] rounded-md transition-colors ${mode === 'preview' ? 'bg-nebula-surface text-nebula-text shadow-sm' : 'text-nebula-muted hover:text-nebula-text'}`}
          >Preview</button>
          <button
            onClick={() => setMode('raw')}
            className={`px-3 py-1 text-[11px] rounded-md transition-colors ${mode === 'raw' ? 'bg-nebula-surface text-nebula-text shadow-sm' : 'text-nebula-muted hover:text-nebula-text'}`}
          >Raw</button>
        </div>
      </div>
      {error && <p className="text-[11px] text-nebula-red mb-2">{error}</p>}
      <div className="bg-nebula-bg border border-nebula-border rounded-lg overflow-hidden">
        {mode === 'preview' ? (
          <div className="p-5 max-h-[60vh] overflow-y-auto">
            {content.trim() ? (
              <MarkdownRenderer content={content} />
            ) : (
              <p className="text-[13px] text-nebula-muted italic">Empty file</p>
            )}
          </div>
        ) : editable ? (
          <textarea
            value={content}
            onChange={e => setContent(e.target.value)}
            className="w-full h-[60vh] px-4 py-3 bg-transparent text-[13px] text-nebula-text font-mono focus:outline-none resize-none leading-relaxed"
            placeholder={`# ${filePath.replace('.md', '').replace(/-/g, ' ')}\n\nWrite your content here...`}
          />
        ) : (
          <pre className="p-4 max-h-[60vh] overflow-y-auto text-[12px] text-nebula-text whitespace-pre-wrap font-mono leading-relaxed">{content}</pre>
        )}
      </div>
      <div className="flex justify-end gap-2 pt-4">
        {editable ? (
          <>
            <button onClick={onClose} className="px-4 py-2 text-sm text-nebula-muted hover:text-nebula-text">Cancel</button>
            <button onClick={handleSave} disabled={saving || !dirty}
              className="px-4 py-2 text-sm bg-nebula-accent text-nebula-bg rounded-lg hover:brightness-110 disabled:opacity-50 font-medium">
              {saving ? 'Saving...' : 'Save'}
            </button>
          </>
        ) : (
          <button onClick={onClose} className="px-4 py-2 text-sm text-nebula-muted hover:text-nebula-text">Close</button>
        )}
      </div>
    </Modal>
  );
}
