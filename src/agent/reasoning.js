// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — reasoning.js
// Claude API reasoning loop
// Sends portfolio context → gets structured JSON decision → enforces mandate
// ─────────────────────────────────────────────────────────────────────────────

import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { SYSTEM_PROMPT, buildContext } from './prompts.js';
import { enforceMandate } from './mandate.js';

const MODEL         = process.env.MERCER_MODEL ?? 'claude-sonnet-4-6';
const HISTORY_FILE  = join(process.cwd(), 'data', 'decisions.json');
const HISTORY_LIMIT = 200;

// ─── Decision history — persisted to data/decisions.json ─────────────────────

function loadHistory() {
  try {
    mkdirSync(join(process.cwd(), 'data'), { recursive: true });
    return JSON.parse(readFileSync(HISTORY_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveHistory(history) {
  try {
    mkdirSync(join(process.cwd(), 'data'), { recursive: true });
    writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (err) {
    console.warn('[Mercer] Could not save decision history:', err.message);
  }
}

const decisionHistory = loadHistory();

export function getRecentDecisions(n = 5) {
  return decisionHistory.slice(-n);
}

/** Records a decision made outside the normal reasoning loop (e.g. stop-loss bypass). */
export function recordDecision(decision, blocked = false) {
  decisionHistory.push({ ...decision, timestamp: new Date().toISOString(), blocked });
  if (decisionHistory.length > HISTORY_LIMIT) decisionHistory.shift();
  saveHistory(decisionHistory);
}

// Lazy-initialized client (created once per process)
let _client = null;
function getClient() {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY is not set. Add it to your .env file.');
    }
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

/**
 * Parses Claude's raw text response into a decision object.
 * Handles cases where the model wraps JSON in markdown fences despite instructions.
 *
 * @param {string} raw
 * @returns {object}
 */
function parseDecision(raw) {
  // Strip markdown code fences if present
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new Error(`Failed to parse Claude response as JSON:\n${raw}`);
  }
}

/**
 * Core reasoning loop: one full cycle of observe → reason → decide → validate.
 *
 * @param {object} params
 * @param {object} params.portfolio  - Current portfolio state
 * @param {object} params.market     - Market data snapshot
 * @param {object} params.mandate    - Active risk mandate
 * @param {string} [params.trigger]  - What triggered this cycle
 * @param {object[]} [params.history] - Prior messages for multi-turn context (optional)
 * @returns {Promise<{
 *   raw: string,
 *   decision: object,
 *   violations: string[],
 *   blocked: boolean,
 *   usage: object
 * }>}
 */
export async function reason({ portfolio, market, mandate, trigger = 'scheduled_review', history = [], trailingData = null, stopCooldowns = [], blockedBuys = [], recentTrades = [] }) {
  const client = getClient();

  const contextMessage = buildContext({ portfolio, market, mandate, trigger, trailingData, stopCooldowns, blockedBuys, recentTrades });

  const messages = [
    ...history,
    { role: 'user', content: contextMessage },
  ];

  const now = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  console.log(`\n[Mercer] ${now} — Reasoning cycle initiated — trigger: ${trigger}`);
  console.log(`[Mercer] Model: ${MODEL}`);
  console.log(`[Mercer] Portfolio value: $${portfolio.totalValueUsd.toLocaleString()}\n`);

  const response = await client.messages.create({
    model:      MODEL,
    max_tokens: 1024,
    // Cache the system prompt — saves ~90% on input tokens after first call
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages,
  });

  const raw = response.content[0]?.text ?? '';
  const usage = response.usage;

  console.log(`[Mercer] Tokens used — input: ${usage.input_tokens}, output: ${usage.output_tokens}`);

  // Parse structured decision from Claude's response
  const rawDecision = parseDecision(raw);

  // Tiered confidence sizing — bet bigger when sure, smaller when uncertain, skip when very low.
  // Tiers: ≥0.75 → 100%, 0.62-0.74 → 65%, 0.50-0.61 → 35%, <0.50 → skip (no buys).
  const confidence = rawDecision.confidence ?? 1.0;
  const confidenceScale =
    confidence >= 0.75 ? 1.00 :
    confidence >= 0.62 ? 0.65 :
    confidence >= 0.50 ? 0.35 : 0.0;

  const scaledDecision = confidenceScale < 1.0 ? {
    ...rawDecision,
    trades: (rawDecision.trades ?? []).map(t => {
      if (t.type !== 'buy') return t;
      if (confidenceScale === 0.0) {
        // Mark for removal — returns null, filtered below
        return null;
      }
      const scaled = parseFloat((t.amountUsd * confidenceScale).toFixed(2));
      return { ...t, amountUsd: scaled, reason: `${t.reason} [sized to ${(confidenceScale * 100).toFixed(0)}% for ${(confidence * 100).toFixed(0)}% confidence]` };
    }).filter(Boolean),
  } : rawDecision;

  // Run mandate enforcement layer with full market data
  const { decision, violations, blocked } = enforceMandate(scaledDecision, mandate, portfolio, market ?? {});

  // Record in history (cap at 20)
  decisionHistory.push({ ...decision, timestamp: new Date().toISOString(), blocked });
  if (decisionHistory.length > HISTORY_LIMIT) decisionHistory.shift();
  saveHistory(decisionHistory);

  return { raw, decision, violations, blocked, usage };
}

/**
 * Pretty-prints a final decision to stdout.
 *
 * @param {object} result - Return value from reason()
 */
export function printDecision(result) {
  const { decision, violations, blocked } = result;

  const actionColor = {
    hold: '\x1b[33m',      // yellow
    rebalance: '\x1b[36m', // cyan
    buy: '\x1b[32m',       // green
    sell: '\x1b[31m',      // red
    alert: '\x1b[35m',     // magenta
  }[decision.action] ?? '\x1b[0m';

  const reset = '\x1b[0m';
  const bold = '\x1b[1m';
  const dim = '\x1b[2m';

  console.log('\n' + '─'.repeat(60));
  console.log(`${bold}MERCER DECISION${reset}`);
  console.log('─'.repeat(60));
  console.log(`${bold}Action:${reset}     ${actionColor}${decision.action.toUpperCase()}${reset}`);
  console.log(`${bold}Confidence:${reset} ${(decision.confidence * 100).toFixed(0)}%`);
  console.log(`${bold}Rationale:${reset}  ${decision.rationale}`);

  if (decision.trades?.length > 0) {
    console.log(`\n${bold}Trades:${reset}`);
    for (const trade of decision.trades) {
      const sign = trade.type === 'buy' ? '+' : '-';
      const color = trade.type === 'buy' ? '\x1b[32m' : '\x1b[31m';
      console.log(`  ${color}${sign} ${trade.type.toUpperCase()} ${trade.asset} $${trade.amountUsd.toLocaleString()}${reset}`);
      console.log(`    ${dim}↳ ${trade.reason}${reset}`);
    }
  }

  if (decision.riskFlags?.length > 0) {
    console.log(`\n${bold}Risk Flags:${reset}`);
    for (const flag of decision.riskFlags) {
      console.log(`  ${'\x1b[33m'}⚠ ${flag}${reset}`);
    }
  }

  if (violations.length > 0) {
    console.log(`\n${bold}Mandate Enforcements:${reset}`);
    for (const v of violations) {
      console.log(`  ${'\x1b[31m'}✗ ${v}${reset}`);
    }
  }

  if (blocked) {
    console.log(`\n${'\x1b[31m'}${bold}⛔ ALL TRADING BLOCKED BY MANDATE${reset}`);
  }

  console.log('─'.repeat(60) + '\n');
}
