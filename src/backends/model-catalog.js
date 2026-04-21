import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = path.join(__dirname, 'models.json');

let _cache = null;

function load() {
  if (_cache) return _cache;
  try {
    _cache = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  } catch (e) {
    console.warn(`[model-catalog] Could not load ${CATALOG_PATH}: ${e.message}`);
    _cache = {};
  }
  return _cache;
}

export function listModelsFor(cliId) {
  const cfg = load();
  const entries = Array.isArray(cfg[cliId]) ? cfg[cliId] : [];
  return entries.map(m => ({ ...m, backend: cliId }));
}

export function _resetCatalogCacheForTest() {
  _cache = null;
}
