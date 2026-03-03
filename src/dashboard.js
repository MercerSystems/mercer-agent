// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — dashboard.js
// Terminal dashboard powered by blessed-contrib
// Auto-refreshes every 120s — connects to Express API on port 3000
// ─────────────────────────────────────────────────────────────────────────────

import 'dotenv/config';
import blessed from 'blessed';
import contrib from 'blessed-contrib';
import { fetchWalletPortfolio } from './wallet/solana.js';
import { DEFAULT_BASE_PORTFOLIO } from './agent/portfolio.js';

const API_BASE = 'http://localhost:3000';
const REFRESH_MS = 120_000;
const MANDATE_PRESET = process.env.MERCER_MANDATE ?? 'moderate';
const { SOLANA_RPC_URL, WALLET_ADDRESS } = process.env;

// ─── Screen + grid ────────────────────────────────────────────────────────────

const screen = blessed.screen({ smartCSR: true, title: 'Mercer Systems' });
const grid = new contrib.grid({ rows: 12, cols: 12, screen });

// ─── Widgets ──────────────────────────────────────────────────────────────────

const titleBox = grid.set(0, 0, 1, 12, blessed.box, {
  content: ' MERCER SYSTEMS  ◈  Autonomous DeFi Portfolio Agent  ◈  Solana Mainnet',
  tags: true,
  align: 'center',
  style: { fg: 'cyan', bold: true },
});

const table = grid.set(1, 0, 7, 8, contrib.table, {
  label: ' Portfolio Holdings ',
  columnSpacing: 1,
  columnWidth: [7, 16, 12, 14, 8],
  headers: ['Token', 'Balance', 'Price', 'Value', '% Port'],
  border: { type: 'line', fg: 'cyan' },
  style: {
    header: { fg: 'cyan', bold: true },
    cell: { fg: 'white' },
  },
});

const solBox = grid.set(1, 8, 3, 4, blessed.box, {
  label: ' SOL / USD ',
  tags: true,
  border: { type: 'line', fg: 'cyan' },
  padding: { top: 1, left: 2 },
  content: 'Loading...',
  style: { fg: 'white' },
});

const mandateBox = grid.set(4, 8, 4, 4, blessed.box, {
  label: ' Active Mandate ',
  tags: true,
  border: { type: 'line', fg: 'cyan' },
  padding: { top: 0, left: 1 },
  scrollable: true,
  alwaysScroll: true,
  content: 'Loading...',
  style: { fg: 'white' },
});

const reasonBox = grid.set(8, 0, 3, 12, blessed.box, {
  label: ' Latest Claude Decision ',
  tags: true,
  border: { type: 'line', fg: 'cyan' },
  padding: { top: 0, left: 2 },
  scrollable: true,
  alwaysScroll: true,
  content: 'Waiting for first reasoning cycle...',
  style: { fg: 'white' },
});

const statusBox = grid.set(11, 0, 1, 12, blessed.box, {
  tags: true,
  content: ' {cyan-fg}[q]{/} Quit  {cyan-fg}[r]{/} Refresh  |  Initializing...',
  style: { fg: 'white', bg: 'black' },
});

// ─── Formatting helpers ───────────────────────────────────────────────────────

function fmtPrice(n) {
  if (n == null) return 'N/A';
  if (n >= 1)      return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (n >= 0.0001) return '$' + n.toFixed(6);
  return '$' + n.toExponential(3);
}

function fmtQty(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000)     return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return n.toFixed(4);
}

function fmtUSD(n) {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ─── Display updaters ─────────────────────────────────────────────────────────

function updatePortfolioTable(market, holdings, cashUsd) {
  const enriched = holdings.map(h => {
    const price = market[h.symbol]?.price ?? h.entryPrice ?? 0;
    return { ...h, price, value: price * h.quantity };
  });
  enriched.push({ symbol: 'USDC', quantity: cashUsd, price: 1, value: cashUsd });

  const totalValue = enriched.reduce((s, h) => s + h.value, 0);

  const rows = enriched.map(h => [
    h.symbol,
    fmtQty(h.quantity),
    fmtPrice(h.price),
    fmtUSD(h.value),
    ((h.value / totalValue) * 100).toFixed(1) + '%',
  ]);

  rows.push(['─────', '──────────────', '──────────', '────────────', '────────']);
  rows.push(['TOTAL', '', '', fmtUSD(totalValue), '100%']);

  table.setData({ headers: ['Token', 'Balance', 'Price', 'Value', '% Port'], data: rows });
}

function updateSOLPrice(market) {
  const sol = market.SOL;
  if (!sol) {
    solBox.setContent('{red-fg}SOL data unavailable{/}');
    return;
  }
  const ch = sol.change24h ?? 0;
  const chColor = ch >= 0 ? 'green-fg' : 'red-fg';
  const chSign  = ch >= 0 ? '+' : '';
  const vol = sol.volume24hUsd ? '$' + (sol.volume24hUsd / 1e9).toFixed(2) + 'B' : 'N/A';

  solBox.setContent(
    `\n {bold}{white-fg}${fmtPrice(sol.price)}{/}\n\n` +
    ` {${chColor}}24h  ${chSign}${ch.toFixed(2)}%{/}\n\n` +
    ` {dim-fg}Vol  ${vol}{/}`
  );
}

function updateMandateDisplay(mandate, violations = [], blocked = false) {
  const lines = [
    `{cyan-fg}Preset:{/}    {bold}${MANDATE_PRESET.toUpperCase()}{/}`,
    `{cyan-fg}Max Pos:{/}   ${mandate?.maxPositionPct ?? '?'}%`,
    `{cyan-fg}Stop Loss:{/} ${mandate?.stopLossPct ?? '?'}%`,
    `{cyan-fg}Max DD:{/}    ${mandate?.maxDrawdownPct ?? '?'}%`,
    '',
  ];

  if (blocked) {
    lines.push('{red-fg}{bold}⛔ TRADING BLOCKED{/}');
    lines.push('');
  }

  if (violations.length === 0) {
    lines.push('{green-fg}✓ No violations{/}');
  } else {
    lines.push(`{red-fg}⚠ ${violations.length} violation(s):{/}`);
    for (const v of violations) {
      lines.push(`{red-fg}• ${v}{/}`);
    }
  }

  mandateBox.setContent(lines.join('\n'));
}

function updateReasonDisplay(result) {
  const { decision, violations, blocked } = result;

  const actionColor = {
    hold:      'yellow-fg',
    rebalance: 'cyan-fg',
    buy:       'green-fg',
    sell:      'red-fg',
    alert:     'magenta-fg',
  }[decision.action] ?? 'white-fg';

  const conf       = ((decision.confidence ?? 0) * 100).toFixed(0);
  const blockedTag = blocked ? '{red-fg}YES ⛔{/}' : '{green-fg}NO{/}';

  const lines = [
    `{cyan-fg}Action:{/} {bold}{${actionColor}}${(decision.action ?? '?').toUpperCase()}{/}` +
      `   {cyan-fg}Confidence:{/} ${conf}%   {cyan-fg}Blocked:{/} ${blockedTag}`,
    '',
    `{cyan-fg}Rationale:{/} ${decision.rationale ?? 'N/A'}`,
  ];

  if (decision.trades?.length > 0) {
    lines.push('', '{cyan-fg}Proposed Trades:{/}');
    for (const t of decision.trades) {
      const tc   = t.type === 'buy' ? 'green-fg' : 'red-fg';
      const sign = t.type === 'buy' ? '+' : '−';
      lines.push(
        `  {${tc}}${sign} ${t.type.toUpperCase()} ${t.asset} ${fmtUSD(t.amountUsd)}{/}` +
        (t.reason ? `  — ${t.reason}` : '')
      );
    }
  } else {
    lines.push('', '{dim-fg}No trades proposed.{/}');
  }

  if (decision.riskFlags?.length > 0) {
    lines.push('', '{yellow-fg}Risk Flags:{/}');
    for (const f of decision.riskFlags) {
      lines.push(`  {yellow-fg}⚠ ${f}{/}`);
    }
  }

  if (violations.length > 0) {
    lines.push('', '{red-fg}Mandate Enforcements:{/}');
    for (const v of violations) {
      lines.push(`  {red-fg}✗ ${v}{/}`);
    }
  }

  reasonBox.setContent(lines.join('\n'));
}

// ─── API fetch ────────────────────────────────────────────────────────────────

async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ─── Status helper ────────────────────────────────────────────────────────────

function setStatus(msg) {
  statusBox.setContent(` {cyan-fg}[q]{/} Quit  {cyan-fg}[r]{/} Refresh  |  ${msg}`);
}

// ─── Refresh cycle ────────────────────────────────────────────────────────────

let isRefreshing  = false;
let lastUpdatedAt = null;
let nextRefreshAt = null;

async function doRefresh() {
  if (isRefreshing) return;
  isRefreshing  = true;
  nextRefreshAt = Date.now() + REFRESH_MS;

  setStatus('{yellow-fg}Fetching wallet balances and market data...{/}');
  screen.render();

  try {
    // 1. Live wallet balances (or mock fallback)
    let basePortfolio;
    if (SOLANA_RPC_URL && WALLET_ADDRESS) {
      try {
        basePortfolio = await fetchWalletPortfolio(WALLET_ADDRESS, SOLANA_RPC_URL);
      } catch {
        basePortfolio = DEFAULT_BASE_PORTFOLIO;
      }
    } else {
      basePortfolio = DEFAULT_BASE_PORTFOLIO;
    }

    // 2. Live market prices
    const market = await fetchJSON(`${API_BASE}/market`);
    updatePortfolioTable(market, basePortfolio.holdings, basePortfolio.cashUsd);
    updateSOLPrice(market);
    screen.render();

    // 3. Mandate metadata
    const mandates      = await fetchJSON(`${API_BASE}/mandates`);
    const activeMandate = mandates[MANDATE_PRESET];

    // 4. Claude reasoning — triggers Anthropic API call
    setStatus('{yellow-fg}Awaiting Claude reasoning...{/}');
    screen.render();

    const result = await fetchJSON(`${API_BASE}/reason`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mandate: MANDATE_PRESET }),
    });

    updateMandateDisplay(activeMandate, result.violations, result.blocked);
    updateReasonDisplay(result);

    lastUpdatedAt = new Date();
    setStatus(`{green-fg}Updated: ${lastUpdatedAt.toLocaleTimeString()}{/}  |  Next refresh in {cyan-fg}30s{/}`);
  } catch (err) {
    // Strip blessed tag chars from error message to avoid rendering glitches
    const msg = err.message.replace(/[{}]/g, '');
    setStatus(`{red-fg}Error: ${msg} — is the API server running on port 3000?{/}`);
  } finally {
    isRefreshing = false;
    screen.render();
  }
}

// Countdown tick — updates status every second between refreshes
setInterval(() => {
  if (isRefreshing || !nextRefreshAt || !lastUpdatedAt) return;
  const secsLeft = Math.max(0, Math.round((nextRefreshAt - Date.now()) / 1000));
  setStatus(
    `{green-fg}Updated: ${lastUpdatedAt.toLocaleTimeString()}{/}  |  ` +
    `Next refresh in {cyan-fg}${secsLeft}s{/}`
  );
  screen.render();
}, 1_000);

// ─── Key bindings ─────────────────────────────────────────────────────────────

screen.key(['q', 'C-c'], () => { screen.destroy(); process.exit(0); });
screen.key(['r'], doRefresh);

// ─── Boot ─────────────────────────────────────────────────────────────────────

screen.render();
doRefresh();
setInterval(doRefresh, REFRESH_MS);
