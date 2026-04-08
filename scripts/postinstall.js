import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

// node-pty ships a spawn-helper binary in its prebuilds.
// npm does not always preserve the execute bit, which causes
// "posix_spawnp failed" at runtime on macOS / Linux.
const prebuildsDir = path.join(root, 'node_modules', 'node-pty', 'prebuilds');

if (fs.existsSync(prebuildsDir)) {
  for (const platform of fs.readdirSync(prebuildsDir)) {
    const helper = path.join(prebuildsDir, platform, 'spawn-helper');
    if (fs.existsSync(helper)) {
      try {
        fs.chmodSync(helper, 0o755);
      } catch {
        // Best-effort — may fail in read-only environments
      }
    }
  }
}
