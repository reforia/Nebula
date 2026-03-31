import { useState, useEffect, useCallback, useRef } from 'react';
import { getVaultFiles, getAgentVaultFileContent, uploadVaultFile, deleteVaultFile, VaultFile } from '../api/client';
import MarkdownViewer from './MarkdownViewer';

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

interface Props {
  agentId: string;
}

export default function VaultFiles({ agentId }: Props) {
  const [files, setFiles] = useState<VaultFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [viewing, setViewing] = useState<{ name: string; content: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await getVaultFiles(agentId);
      setFiles(data);
    } catch (err) {
      console.error('Failed to load vault files:', err);
    }
  }, [agentId]);

  useEffect(() => { refresh(); }, [refresh]);

  const handleUpload = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setUploading(true);
    try {
      for (const file of Array.from(fileList)) {
        await uploadVaultFile(agentId, file);
      }
      refresh();
    } catch (err: any) {
      alert('Upload failed: ' + err.message);
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (name: string) => {
    if (!confirm(`Delete "${name}"?`)) return;
    await deleteVaultFile(agentId, name);
    refresh();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    handleUpload(e.dataTransfer.files);
  };

  const handleFileClick = async (file: VaultFile) => {
    if (!file.name.endsWith('.md')) return;
    try {
      const content = await getAgentVaultFileContent(agentId, file.name);
      setViewing({ name: file.name, content });
    } catch (err) {
      console.error('Failed to load file:', err);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium">Vault Files</h3>
        <span className="text-[11px] text-nebula-muted">{files.length} file{files.length !== 1 ? 's' : ''}</span>
      </div>

      {/* Drop zone */}
      <div
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors mb-4 ${
          dragOver ? 'border-nebula-accent/50 bg-nebula-accent-glow' : 'border-nebula-border hover:border-nebula-border-light'
        }`}
      >
        <input ref={fileInputRef} type="file" multiple onChange={e => handleUpload(e.target.files)} className="hidden" />
        <p className="text-sm text-nebula-muted">
          {uploading ? 'Uploading...' : 'Drop files here or click to upload'}
        </p>
        <p className="text-[11px] text-nebula-muted/50 mt-1">Max 50MB per file</p>
      </div>

      {/* File list */}
      {files.length > 0 && (
        <div className="space-y-1">
          {files.map(file => {
            const isMd = file.name.endsWith('.md');
            return (
              <div key={file.name} className="flex items-center justify-between bg-nebula-bg border border-nebula-border rounded-lg px-3 py-2">
                <div className="min-w-0 flex-1">
                  {isMd ? (
                    <button
                      onClick={() => handleFileClick(file)}
                      className="text-[13px] text-nebula-text hover:text-nebula-accent truncate block text-left"
                    >
                      {file.name}
                    </button>
                  ) : (
                    <a
                      href={`/api/agents/${agentId}/vault/${encodeURIComponent(file.name)}`}
                      className="text-[13px] text-nebula-text hover:text-nebula-accent truncate block"
                      download
                    >
                      {file.name}
                    </a>
                  )}
                  <span className="text-[10px] text-nebula-muted">{formatSize(file.size)}</span>
                </div>
                <button
                  onClick={() => handleDelete(file.name)}
                  className="ml-2 p-1 text-nebula-muted hover:text-nebula-red text-xs flex-shrink-0"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                </button>
              </div>
            );
          })}
        </div>
      )}

      {viewing && (
        <MarkdownViewer
          initialContent={viewing.content}
          filePath={viewing.name}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  );
}
