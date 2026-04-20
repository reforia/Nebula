/**
 * Walk NDJSON-ish output from a CLI stdout. Splits on newlines, keeps only
 * lines that look like JSON objects, parses each, and calls `processEvent`
 * for every successful parse.
 *
 * Handles the recurring PTY quirk where multiple top-level JSON objects end
 * up on the same line without a separator (e.g. `{...}{...}{...}` in a burst
 * write). In that case we split at top-level object boundaries (`}` followed
 * by `{`) and try each fragment independently.
 *
 * Shared by the Claude Code, OpenCode, Codex, and Gemini backends — keep
 * behavior changes here rather than editing each adapter.
 */
export function processJsonLines(rawOutput, processEvent) {
  const lines = rawOutput.split('\n').filter(l => l.trim().startsWith('{'));
  for (const line of lines) {
    try {
      processEvent(JSON.parse(line));
    } catch {
      const parts = line.split(/(?<=\})\s*(?=\{)/);
      if (parts.length > 1) {
        for (const part of parts) {
          try { processEvent(JSON.parse(part)); } catch { /* skip */ }
        }
      }
    }
  }
}
