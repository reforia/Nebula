import { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Props {
  content: string;
  highlight?: string;
}

/**
 * Split text into segments: @mentions get styled, search matches get highlighted.
 */
function renderText(text: string, highlight?: string): (string | JSX.Element)[] {
  // Combined regex: @notify AgentName or @AgentName, plus optional search highlight
  const mentionRe = /@notify\s+\S+|@\S+/g;

  // First pass: split by @mentions
  const parts: { text: string; isMention: boolean }[] = [];
  let lastIndex = 0;
  let match;
  while ((match = mentionRe.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ text: text.slice(lastIndex, match.index), isMention: false });
    }
    parts.push({ text: match[0], isMention: true });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    parts.push({ text: text.slice(lastIndex), isMention: false });
  }

  // Second pass: apply search highlight within each part
  const result: (string | JSX.Element)[] = [];
  let keyIdx = 0;

  for (const part of parts) {
    if (part.isMention) {
      result.push(
        <span key={keyIdx++} className="text-nebula-accent font-medium">{part.text}</span>
      );
    } else if (highlight) {
      const escaped = highlight.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const highlightRe = new RegExp(`(${escaped})`, 'gi');
      const segments = part.text.split(highlightRe);
      for (const seg of segments) {
        if (seg.toLowerCase() === highlight.toLowerCase()) {
          result.push(
            <mark key={keyIdx++} className="bg-nebula-accent/30 text-nebula-text rounded px-0.5">{seg}</mark>
          );
        } else {
          result.push(seg);
        }
      }
    } else {
      result.push(part.text);
    }
  }

  return result;
}

export default function MarkdownRenderer({ content, highlight }: Props) {
  // Custom components to inject @mention styling and search highlighting into text nodes
  const components = useMemo(() => ({
    // Override text rendering in paragraphs, list items, etc.
    p: ({ children, ...props }: any) => <p {...props}>{processChildren(children, highlight)}</p>,
    li: ({ children, ...props }: any) => <li {...props}>{processChildren(children, highlight)}</li>,
    td: ({ children, ...props }: any) => <td {...props}>{processChildren(children, highlight)}</td>,
    th: ({ children, ...props }: any) => <th {...props}>{processChildren(children, highlight)}</th>,
    strong: ({ children, ...props }: any) => <strong {...props}>{processChildren(children, highlight)}</strong>,
    em: ({ children, ...props }: any) => <em {...props}>{processChildren(children, highlight)}</em>,
  }), [highlight]);

  return (
    <div className="markdown-body text-[13px] leading-relaxed overflow-x-auto">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

function processChildren(children: any, highlight?: string): any {
  if (!children) return children;
  if (typeof children === 'string') {
    const parts = renderText(children, highlight);
    return parts.length === 1 && typeof parts[0] === 'string' ? parts[0] : <>{parts}</>;
  }
  if (Array.isArray(children)) {
    return children.map((child, i) => {
      if (typeof child === 'string') {
        const parts = renderText(child, highlight);
        return parts.length === 1 && typeof parts[0] === 'string' ? child : <span key={i}>{parts}</span>;
      }
      return child;
    });
  }
  return children;
}
