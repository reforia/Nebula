import { useState } from 'react';

interface ToolCall {
  name: string;
  input: Record<string, any>;
  output?: string;
  error?: boolean;
}

interface Props {
  tools: ToolCall[];
}

function toolIcon(name: string): string {
  switch (name) {
    case 'Read': return '📄';
    case 'Write': return '✏️';
    case 'Edit': return '✏️';
    case 'Bash': return '⚡';
    case 'Glob': return '🔍';
    case 'Grep': return '🔎';
    case 'WebFetch': return '🌐';
    case 'WebSearch': return '🌐';
    case 'Agent': return '🤖';
    case 'Task': return '📋';
    default: return '🔧';
  }
}

function toolSummary(tool: ToolCall): string {
  const { name, input } = tool;
  switch (name) {
    case 'Read': return input.file_path || 'file';
    case 'Write': return input.file_path || 'file';
    case 'Edit': return input.file_path || 'file';
    case 'Bash': return input.command?.slice(0, 80) || input.description || 'command';
    case 'Glob': return input.pattern || 'pattern';
    case 'Grep': return input.pattern || 'search';
    case 'WebFetch': return input.url?.slice(0, 60) || 'url';
    case 'WebSearch': return input.query?.slice(0, 60) || 'query';
    case 'Agent': return input.description || 'subagent';
    default: return Object.values(input).filter(v => typeof v === 'string').join(', ').slice(0, 60) || name;
  }
}

export default function ToolHistory({ tools }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [expandedTool, setExpandedTool] = useState<number | null>(null);

  if (tools.length === 0) return null;

  return (
    <div className="mt-2 border-t border-nebula-border/30 pt-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-[11px] text-nebula-muted/60 hover:text-nebula-muted transition-colors"
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          className={`transition-transform ${expanded ? 'rotate-90' : ''}`}>
          <path d="m9 18 6-6-6-6"/>
        </svg>
        {tools.length} tool call{tools.length !== 1 ? 's' : ''}
      </button>

      {expanded && (
        <div className="mt-1.5 space-y-0.5">
          {tools.map((tool, i) => (
            <div key={i} className="text-[11px]">
              <button
                onClick={() => setExpandedTool(expandedTool === i ? null : i)}
                className={`w-full text-left flex items-center gap-1.5 px-2 py-1 rounded hover:bg-nebula-bg/50 transition-colors ${
                  tool.error ? 'text-nebula-red/70' : 'text-nebula-muted/70'
                }`}
              >
                <span>{toolIcon(tool.name)}</span>
                <span className="font-medium text-nebula-muted">{tool.name}</span>
                <span className="truncate flex-1 opacity-60">{toolSummary(tool)}</span>
                {tool.output && (
                  <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                    className={`flex-shrink-0 transition-transform ${expandedTool === i ? 'rotate-90' : ''}`}>
                    <path d="m9 18 6-6-6-6"/>
                  </svg>
                )}
              </button>
              {expandedTool === i && tool.output && (
                <pre className="ml-7 mt-0.5 px-2 py-1.5 bg-nebula-bg/50 rounded text-[10px] text-nebula-muted/60 overflow-x-auto max-h-40 overflow-y-auto whitespace-pre-wrap break-all">
                  {tool.output}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
