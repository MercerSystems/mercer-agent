// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — history.js
// File-backed portfolio snapshot store
// Persists { timestamp, totalValueUsd } entries to data/portfolio-history.json
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = join(__dirname, '..', 'data');
const HIST_FILE = join(DATA_DIR, 'portfolio-history.json');
const MAX_SNAPS = 500;  // ~5 days at 15-min intervals

function load() {
  try { return JSON.parse(readFileSync(HIST_FILE, 'utf8')); } catch { return []; }
}

function save(snaps) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(HIST_FILE, JSON.stringify(snaps));
}

let snaps = load();

/**
 * Append a new portfolio value snapshot. Persists to disk immediately.
 * @param {number} totalValueUsd
 */
export function recordSnapshot(totalValueUsd) {
  snaps.push({ timestamp: new Date().toISOString(), totalValueUsd });
  if (snaps.length > MAX_SNAPS) snaps = snaps.slice(-MAX_SNAPS);
  save(snaps);
}

/**
 * Returns all stored snapshots, oldest first.
 * @returns {{ timestamp: string, totalValueUsd: number }[]}
 */
export function getHistory() {
  return snaps;
}
