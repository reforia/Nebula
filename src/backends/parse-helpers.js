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
  // Streaming parser state. We accumulate into `buffer` and only fold a
  // non-'{'-starting line as a PTY-wrap continuation when the preceding
  // buffer isn't already a complete JSON object on its own — that
  // distinguishes a real wrap from unrelated log noise written between
  // JSON events (Gemini CLI prints errors like `[ERROR] [ImportProcessor]`
  // to the same stdout as stream-json).
  const rawLines = rawOutput.split('\n');
  let buffer = '';

  const flush = () => {
    if (!buffer) return;
    try {
      processEvent(JSON.parse(buffer));
      buffer = '';
      return;
    } catch { /* fall through to split */ }
    // Burst write of multiple top-level objects on one line.
    const parts = buffer.split(/(?<=\})\s*(?=\{)/);
    let leftover = '';
    for (const part of parts) {
      try { processEvent(JSON.parse(part)); }
      catch { leftover += part; }
    }
    buffer = leftover;
  };

  for (const line of rawLines) {
    if (line.trim().startsWith('{')) {
      flush();
      buffer = line;
      flush(); // parse immediately if the line is a complete object
    } else if (buffer) {
      // Two possibilities: PTY-wrapped continuation of the buffer, or log
      // noise that happens to follow a valid JSON event. Fold only if the
      // current buffer is incomplete JSON; otherwise flush the buffer as-is
      // and drop this line.
      try {
        processEvent(JSON.parse(buffer + line));
        buffer = '';
      } catch {
        try {
          processEvent(JSON.parse(buffer));
          buffer = '';
        } catch {
          buffer += line;
        }
      }
    }
  }

  flush();
}
