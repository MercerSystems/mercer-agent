// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — market/volume-tracker.js
// Tracks rolling volume baseline per token to detect unusual volume spikes.
// A 3× spike on a token is a far stronger signal than high absolute volume alone.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const FILE        = join(process.cwd(), 'data', 'volume-baseline.json');
const MAX_SAMPLES = 48;   // ~96 min at 2-min cache — enough for short-term baseline
const MIN_SAMPLES = 5;    // need at least 5 samples before ratio is meaningful

let _data = null;

function load() {
  try {
    mkdirSync(join(process.cwd(), 'data'), { recursive: true });
    return JSON.parse(readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

function getData() {
  if (!_data) _data = load();
  return _data;
}

function persist() {
  try {
    mkdirSync(join(process.cwd(), 'data'), { recursive: true });
    writeFileSync(FILE, JSON.stringify(_data));
  } catch { /* non-critical */ }
}

/**
 * Call after each ecosystem fetch to keep baselines fresh.
 * @param {Array<{symbol: string, volume24hUsd: number|null}>} tokens
 */
export function updateVolumeBaseline(tokens) {
  const data = getData();
  let dirty = false;
  for (const token of tokens) {
    if (token.volume24hUsd == null || token.volume24hUsd <= 0) continue;
    if (!data[token.symbol]) data[token.symbol] = [];
    data[token.symbol].push(token.volume24hUsd);
    if (data[token.symbol].length > MAX_SAMPLES) {
      data[token.symbol] = data[token.symbol].slice(-MAX_SAMPLES);
    }
    dirty = true;
  }
  if (dirty) persist();
}

/**
 * Returns current volume / rolling baseline average.
 * Null if insufficient samples. > 1 = above baseline, 3+ = significant spike.
 * @param {string} symbol
 * @param {number} currentVolume
 * @returns {number|null}
 */
export function getSpikeRatio(symbol, currentVolume) {
  const data    = getData();
  const samples = data[symbol];
  if (!samples || samples.length < MIN_SAMPLES) return null;
  // Exclude the most recent sample (that's the current value) to avoid self-comparison
  const baseline = samples.slice(0, -1);
  const avg = baseline.reduce((a, b) => a + b, 0) / baseline.length;
  if (avg <= 0) return null;
  return currentVolume / avg;
}
