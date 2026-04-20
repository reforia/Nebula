// Deterministic per-agent color derived from the agent name. Used for badges,
// @mention chips, and the sidebar avatar border so the same agent is visually
// recognizable across surfaces. Hue is biased toward warm tones (30–70°).
export function agentColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  const hue = 30 + (Math.abs(hash) % 40);
  return `hsl(${hue}, 55%, 58%)`;
}
