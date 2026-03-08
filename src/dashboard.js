// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — dashboard.js
// Terminal dashboard powered by blessed-contrib
// Auto-refreshes every 900s — connects to Express API on port 3000
// ─────────────────────────────────────────────────────────────────────────────

import 'dotenv/config';
import blessed from 'blessed';
import contrib from 'blessed-contrib';
import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

const API_BASE          = 'http://localhost:3000';
const REFRESH_MS        = 600_000;
const DATA_REFRESH_MS   = parseInt(process.env.DATA_REFRESH_MS ?? '60000');
const MANDATE_PRESET    = process.env.MERCER_MANDATE    ?? 'moderate';
const REASON_THRESHOLD  = parseFloat(process.env.REASON_THRESHOLD ?? '2');
const COST_PER_CYCLE    = 0.008;

// ─── Logo ─────────────────────────────────────────────────────────────────────
// Smoothed version — pure box-drawing, no mixed block/line chars on left edge

const LOGO_LINES = [
  '███╗   ███╗███████╗██████╗  ██████╗███████╗██████╗ ',
  '████╗ ████║██╔════╝██╔══██╗██╔════╝██╔════╝██╔══██╗',
  '██╔████╔██║█████╗  ██████╔╝██║     █████╗  ██████╔╝',
  '██║╚██╔╝██║██╔══╝  ██╔══██╗██║     ██╔══╝  ██╔══██╗',
  '██║ ╚═╝ ██║███████╗██║  ██║╚██████╗███████╗██║  ██║',
  '╚═╝     ╚═╝╚══════╝╚═╝  ╚═╝ ╚═════╝╚══════╝╚═╝  ╚═╝',
];

const SPLASH_CONTENT = [
  ...LOGO_LINES.map(l => `{cyan-fg}${l}{/}`),
  '',
  '{white-fg}{bold}S Y S T E M S{/}',
  '{grey-fg}─────────────────────────────────────────────{/}',
  '{grey-fg}Autonomous DeFi Portfolio Agent · Solana{/}',
].join('\n');

// ─── Screen + grid ────────────────────────────────────────────────────────────

const screen = blessed.screen({ smartCSR: true, title: 'Mercer Systems' });
const grid   = new contrib.grid({ rows: 12, cols: 12, screen });

// ─── Widgets ──────────────────────────────────────────────────────────────────

grid.set(0, 0, 1, 12, blessed.box, {
  content: ' ▓▓  MERCER SYSTEMS  ◈  Autonomous DeFi Portfolio Agent  ◈  Solana Mainnet  ▓▓',
  tags:    true,
  align:   'center',
  style:   { fg: 'black', bg: 'cyan', bold: true },
});

// Transparent blessed.box so the dim logo below the data rows shows naturally
const tableBox = grid.set(1, 0, 5, 7, blessed.box, {
  label:       ' Portfolio Holdings ',
  tags:        true,
  transparent: true,
  border:      { type: 'line', fg: 'cyan' },
  padding:     { top: 0, left: 1 },
  style:       { fg: 'white' },
});

const solBox = grid.set(1, 7, 3, 5, blessed.box, {
  label:   ' Market ',
  tags:    true,
  border:  { type: 'line', fg: 'cyan' },
  padding: { top: 1, left: 2 },
  content: 'Loading...',
  style:   { fg: 'white' },
});

const pnlChart = grid.set(4, 7, 2, 5, contrib.line, {
  label:            ' Portfolio P&L ',
  showLegend:       false,
  border:           { type: 'line', fg: 'cyan' },
  style:            { line: 'cyan', text: 'white', baseline: 'black' },
  xLabelPadding:    1,
  xPadding:         1,
  wholeNumbersOnly: false,
});

const tickerBox = grid.set(6, 0, 1, 12, blessed.box, {
  label:   ' Live Launches ',
  tags:    true,
  border:  { type: 'line', fg: 'cyan' },
  padding: { top: 0, left: 1 },
  content: '{grey-fg}Scanning for new launches…{/}',
  style:   { fg: 'white' },
});

const tradeLogBox = grid.set(7, 0, 4, 4, blessed.box, {
  label:   ' Trade Log ',
  tags:    true,
  border:  { type: 'line', fg: 'cyan' },
  padding: { top: 0, left: 1 },
  content: '{grey-fg}No trades yet.{/}',
  style:   { fg: 'white' },
});

const reasonBox = grid.set(7, 4, 4, 8, blessed.box, {
  label:        ' Claude Decisions ',
  tags:         true,
  keys:         true,
  vi:           true,
  border:       { type: 'line', fg: 'cyan' },
  padding:      { top: 0, left: 2 },
  scrollable:   true,
  alwaysScroll: false,
  scrollbar:    { ch: '▐', style: { fg: 'cyan', bg: 'black' } },
  content:      'Waiting for first reasoning cycle...',
  style:        { fg: 'white', selected: { bg: 'default' } },
});


const statusBox = grid.set(11, 0, 1, 12, blessed.box, {
  tags:    true,
  content: ' {cyan-fg}[q]{/} Quit  {cyan-fg}[r]{/} Refresh  |  Initializing...',
  style:   { fg: 'white', bg: 'black' },
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

function hhmm(isoStr) {
  const d = new Date(isoStr);
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function lerp(a, b, t) {
  return Math.round(a + (b - a) * t);
}

function fmtCountdown(secs) {
  if (secs >= 60) return `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s`;
  return `${secs}s`;
}

// Load entry prices from disk for P&L column
function loadEntryPrices() {
  try { return JSON.parse(readFileSync(join(process.cwd(), 'data', 'entry-prices.json'), 'utf8')); } catch { return {}; }
}

// Confidence bar — 8 blocks filled proportionally to confidence %
function confBar(pct) {
  const n = Math.round(Math.min(100, Math.max(0, pct)) / 100 * 8);
  return '{green-fg}' + '█'.repeat(n) + '{grey-fg}' + '░'.repeat(8 - n) + '{/}';
}

// Visible length of a string (strips blessed tags)
function visLen(s) {
  return s.replace(/\{[^}]+\}/g, '').length;
}

// Right-pad a (possibly tag-containing) string to a fixed visible width
function padCol(s, width) {
  return s + ' '.repeat(Math.max(0, width - visLen(s)));
}

// Word-wrap a plain string into lines of at most `width` visible chars
function wordWrap(text, width) {
  if (!text) return [''];
  const words = text.split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    if (!current) {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current += ' ' + word;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

// ─── Sparkline + position-timer helpers ───────────────────────────────────────

const SPARK_BARS = '▁▂▃▄▅▆▇█';
function sparkline(prices) {
  if (!prices || prices.length < 2) return '········';
  const vals  = prices.slice(-8);
  const min   = Math.min(...vals);
  const max   = Math.max(...vals);
  const range = max - min;
  if (range === 0) return '▄▄▄▄▄▄▄▄';
  return vals.map(v => SPARK_BARS[Math.round(((v - min) / range) * 7)]).join('');
}

function fmtHeld(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60)   return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

// ─── Table renderer ───────────────────────────────────────────────────────────
// Columns: Token | Balance | Price | Value | Port% | P&L% | Trend(8)

const COL_W   = [6, 9, 9, 9, 5, 8, 8];
const COL_SEP = '  ';
const TABLE_W = COL_W.reduce((a, b) => a + b, 0) + COL_SEP.length * (COL_W.length - 1);

function loadTrailingData() {
  try { return JSON.parse(readFileSync(join(process.cwd(), 'data', 'trailing-stops.json'), 'utf8')); } catch { return {}; }
}

function renderTable(portfolio, market = {}) {
  const { holdings, totalValue } = portfolio;
  const entryPrices  = loadEntryPrices();
  const trailingData = loadTrailingData();
  const ladder       = lastMandate?.takeProfitLadder ?? [];

  const divider = COL_W.map(w => '─'.repeat(w)).join(COL_SEP);

  const positionHeaders = [
    '{cyan-fg}{bold}Token{/}',
    '{cyan-fg}{bold}Balance{/}',
    '{cyan-fg}{bold}Price{/}',
    '{cyan-fg}{bold}Value{/}',
    '{cyan-fg}{bold}Port%{/}',
    '{cyan-fg}{bold}P&L%{/}',
    '{cyan-fg}{bold}Trend{/}',
  ];

  const lines = [
    positionHeaders.map((h, i) => padCol(h, COL_W[i])).join(COL_SEP),
    divider,
  ];

  let totalPnlUsd = 0;
  let totalPnlKnown = false;

  const RESERVE_TOKENS = new Set(['USDC', 'SOL']);
  const tradeHoldings   = holdings.filter(h => !RESERVE_TOKENS.has(h.token));
  const reserveHoldings = holdings.filter(h => RESERVE_TOKENS.has(h.token));

  function renderHoldingRow(h) {
    const ep       = entryPrices[h.token];
    const pnlPct   = ep && ep > 0 ? ((h.price - ep) / ep) * 100 : null;
    const pnlUsd   = pnlPct != null ? (h.value * pnlPct) / (100 + pnlPct) : null;
    const pnlColor = pnlPct == null ? 'grey-fg' : pnlPct >= 0 ? 'green-fg' : 'red-fg';
    if (pnlUsd != null) { totalPnlUsd += pnlUsd; totalPnlKnown = true; }
    const pnlPctStr  = pnlPct == null ? '—' : `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`;

    // Price flash color when price recently changed
    const flash      = rowFlash.get(h.token);
    const flashOn    = flash && Date.now() < flash.expiresAt;
    const priceColor = flashOn ? (flash.dir === 'up' ? 'green-fg' : 'red-fg') : 'white-fg';

    // Trend sparkline from recent price history
    const ph      = tokenPriceHistory[h.token];
    const spark   = sparkline(ph ? ph.slice(-12).map(p => p.price) : null);
    const sparkC  = pnlPct == null ? 'grey-fg' : pnlPct >= 0 ? 'green-fg' : 'red-fg';

    return [
      `{white-fg}${h.token}{/}`,
      '{white-fg}' + fmtQty(h.balance) + '{/}',
      `{${priceColor}}` + fmtPrice(h.price) + '{/}',
      '{white-fg}' + fmtUSD(h.value) + '{/}',
      '{white-fg}' + ((h.value / totalValue) * 100).toFixed(1) + '%{/}',
      `{${pnlColor}}${pnlPctStr}{/}`,
      `{${sparkC}}${spark}{/}`,
    ].map((cell, i) => padCol(cell, COL_W[i])).join(COL_SEP);
  }

  // ── Reserve section (SOL + USDC) above positions ─────────────────────────
  if (reserveHoldings.length > 0) {
    for (const h of reserveHoldings) {
      const flash   = rowFlash.get(h.token);
      const flashOn = flash && Date.now() < flash.expiresAt;
      const pc      = flashOn ? (flash.dir === 'up' ? 'green-fg' : 'red-fg') : 'white-fg';
      lines.push([
        padCol(`{white-fg}${h.token}{/}`,                                          COL_W[0]),
        padCol('{white-fg}' + fmtQty(h.balance) + '{/}',                          COL_W[1]),
        padCol(`{${pc}}` + fmtPrice(h.price) + '{/}',                             COL_W[2]),
        padCol('{white-fg}' + fmtUSD(h.value) + '{/}',                            COL_W[3]),
        padCol('{white-fg}' + ((h.value / totalValue) * 100).toFixed(1) + '%{/}', COL_W[4]),
        padCol('',                                                                 COL_W[5]),
        padCol('',                                                                 COL_W[6]),
      ].join(COL_SEP));
    }
  }

  if (tradeHoldings.length > 0) lines.push(divider);
  for (const h of tradeHoldings) lines.push(renderHoldingRow(h));

  // Session P&L row
  const sessionPnlUsd = sessionBaseline ? totalValue - sessionBaseline : null;
  const sessionPnlPct = sessionBaseline ? (sessionPnlUsd / sessionBaseline) * 100 : null;
  const sPnlColor     = sessionPnlUsd == null ? 'grey-fg' : sessionPnlUsd >= 0 ? 'green-fg' : 'red-fg';
  const sPnlStr       = sessionPnlUsd == null ? ''
    : `${sessionPnlUsd >= 0 ? '+' : ''}${fmtUSD(sessionPnlUsd)} (${sessionPnlPct >= 0 ? '+' : ''}${sessionPnlPct.toFixed(2)}%)`;

  const totalPnlColor  = !totalPnlKnown ? 'grey-fg' : totalPnlUsd >= 0 ? 'green-fg' : 'red-fg';
  const totalPnlStr    = totalPnlKnown ? `${totalPnlUsd >= 0 ? '+' : ''}$${Math.abs(totalPnlUsd).toFixed(2)}` : '';
  // Total cost basis = sum of (value - pnlUsd) across known holdings
  const totalCost      = totalPnlKnown ? (tradeHoldings.reduce((s, h) => {
    const ep = entryPrices[h.token];
    const pct = ep && ep > 0 ? ((h.price - ep) / ep) * 100 : null;
    const pu  = pct != null ? (h.value * pct) / (100 + pct) : null;
    return s + (pu != null ? h.value - pu : 0);
  }, 0)) : 0;
  const totalPnlPct    = totalCost > 0 ? (totalPnlUsd / totalCost) * 100 : null;
  const totalPnlPctStr = totalPnlPct != null ? `${totalPnlPct >= 0 ? '+' : ''}${totalPnlPct.toFixed(2)}%` : '';

  lines.push(divider);
  lines.push([
    padCol('{bold}TOTAL{/}',                 COL_W[0]),
    padCol('',                               COL_W[1]),
    padCol('',                               COL_W[2]),
    padCol(`{bold}${fmtUSD(totalValue)}{/}`, COL_W[3]),
    padCol('{bold}100%{/}',                  COL_W[4]),
    padCol(`{${totalPnlColor}}{bold}${totalPnlPctStr}{/}`, COL_W[5]),
    padCol('',                               COL_W[6]),
  ].join(COL_SEP));

  if (sPnlStr) {
    lines.push(
      padCol('', COL_W[0]) + COL_SEP +
      padCol('', COL_W[1]) + COL_SEP +
      padCol('', COL_W[2]) + COL_SEP +
      padCol(`{${sPnlColor}}${sPnlStr}{/}`, COL_W[3] + COL_SEP.length + COL_W[4])
    );
  }

  // ── Active positions section — hold time + next target ─────────────────────
  const activePositions = tradeHoldings.filter(h => h.value > 0);
  if (activePositions.length > 0) {
    lines.push('');
    lines.push('{cyan-fg}─── POSITIONS ' + '─'.repeat(Math.max(0, TABLE_W - 15)) + '{/}');
    for (const h of activePositions) {
      const since  = positionSince.get(h.token);
      const heldStr = since ? fmtHeld(Date.now() - since) : '—';
      const hitRungs = new Set(trailingData?.ladderTriggered?.[h.token] ?? []);
      const nextRung = ladder.find((_r, i) => !hitRungs.has(i));
      const targetStr = nextRung
        ? `{grey-fg}next: +${nextRung.pct}%{/}`
        : trailingData?.[h.token]?.peakPrice
          ? `{grey-fg}trailing -20%{/}`
          : '{grey-fg}holding{/}';
      const ep     = entryPrices[h.token];
      const epStr  = ep && ep > 0 ? `entry ${fmtPrice(ep)}` : '';
      lines.push(
        ` {white-fg}${h.token.padEnd(8)}{/}` +
        `{grey-fg} held {/}{cyan-fg}${heldStr.padEnd(8)}{/}` +
        `{grey-fg}${epStr.padEnd(18)}{/}` +
        targetStr
      );
    }
  }

  return lines.join('\n');
}

// ─── Dropdown helper ──────────────────────────────────────────────────────────

// Derived dynamically from live portfolio — updated on each data refresh
function heldTokens() {
  if (!lastPortfolio?.holdings) return ['SOL', 'USDC'];
  return lastPortfolio.holdings.map(h => h.token).filter(Boolean);
}

// Per-token brand colors (terminal palette)
const TOKEN_COLORS = {
  SOL:  'magenta',  // Solana purple
  JUP:  'green',    // Jupiter green
  BONK: 'yellow',   // meme/dog energy
  WIF:  'white',    // neutral
  USDC: 'blue',     // dollar/stable
};

let activeDropdown = null;

function showDropdown(items, anchorBox, onSelect) {
  if (activeDropdown) return;

  const top  = (anchorBox.atop  ?? 1) + 1;
  const left = (anchorBox.aleft ?? 8) + 1;
  const w    = Math.max(...items.map(s => s.length)) + 4;

  const list = blessed.list({
    parent: screen,
    top,
    left,
    width:  w,
    height: items.length + 2,
    items:  [...items],
    keys:   true,
    vi:     true,
    border: { type: 'line', fg: 'cyan' },
    style: {
      fg:       'white',
      bg:       'black',
      border:   { fg: 'cyan' },
      selected: { fg: 'black', bg: 'cyan', bold: true },
    },
  });

  activeDropdown = list;
  list.focus();
  screen.render();

  const close = () => {
    activeDropdown = null;
    list.destroy();
    screen.render();
  };

  list.on('select', (_item, index) => {
    close();
    onSelect(items[index], index);
  });

  list.key(['escape'], close);
}

// ─── Display updaters ─────────────────────────────────────────────────────────

function updatePortfolioTable(portfolio, market = {}) {
  tableBox.setContent(renderTable(portfolio, market));
}

function updateMarketBox(token, market) {
  // ── All-token ticker (default when token is null) ────────────────────────────
  if (!token) {
    solBox.setLabel(' Market ');
    const lines = [];
    for (const sym of heldTokens()) {
      const d = market[sym];
      if (!d) { lines.push(` {white-fg}${sym.padEnd(5)}{/}  {grey-fg}—{/}`); continue; }
      const ch     = d.change24h ?? null;
      const color  = ch == null ? 'grey' : ch >= 0 ? 'green' : 'red';
      const arrow  = ch == null ? '·' : ch >= 0 ? '▲' : '▼';
      const chStr  = ch == null ? '' : `${ch >= 0 ? '+' : ''}${ch.toFixed(2)}%`;
      lines.push(
        ` {white-fg}{bold}${sym.padEnd(5)}{/}` +
        ` {white-fg}${fmtPrice(d.price).padEnd(12)}{/}` +
        ` {${color}-fg}${arrow}${chStr ? ' ' + chStr : ''}{/}`
      );
    }
    solBox.setContent(lines.join('\n'));
    return;
  }

  // ── Single-token detail view ─────────────────────────────────────────────────
  const data = market[token];
  if (!data) {
    solBox.setLabel(` ${token} Market `);
    solBox.setContent(`{red-fg}${token} data unavailable{/}`);
    return;
  }

  const ch1h  = data.change1h  ?? null;
  const ch24h = data.change24h ?? 0;
  const ch1hColor  = ch1h  == null ? 'grey-fg' : ch1h  >= 0 ? 'green-fg' : 'red-fg';
  const ch24hColor = ch24h >= 0 ? 'green-fg' : 'red-fg';
  const ch1hStr  = ch1h  == null ? 'N/A' : `${ch1h  >= 0 ? '+' : ''}${ch1h.toFixed(2)}%`;
  const ch24hStr = `${ch24h >= 0 ? '+' : ''}${ch24h.toFixed(2)}%`;
  const vol  = data.volume24hUsd ? '$' + (data.volume24hUsd / 1e9).toFixed(2) + 'B' : 'N/A';
  const mcap = data.marketCapUsd ? '$' + (data.marketCapUsd  / 1e9).toFixed(1) + 'B' : 'N/A';

  const movers = Object.entries(market)
    .filter(([s, d]) => d.change24h != null && s !== token)
    .sort((a, b) => b[1].change24h - a[1].change24h);
  const best  = movers[0];
  const worst = movers[movers.length - 1];
  const bestLine  = best  ? ` {green-fg}▲ ${best[0]}  ${best[1].change24h >= 0 ? '+' : ''}${best[1].change24h.toFixed(2)}%{/}` : '';
  const worstLine = worst ? ` {red-fg}▼ ${worst[0]}  ${worst[1].change24h >= 0 ? '+' : ''}${worst[1].change24h.toFixed(2)}%{/}` : '';

  solBox.setLabel(` ${token} Market `);
  solBox.setContent(
    ` {white-fg}{bold}${token}  ${fmtPrice(data.price)}{/}\n` +
    ` {${ch1hColor}}1h  ${ch1hStr}{/}   {${ch24hColor}}24h ${ch24hStr}{/}\n` +
    ` {grey-fg}Vol ${vol}  MCap ${mcap}{/}\n` +
    `\n` +
    `${bestLine}\n` +
    `${worstLine}\n`
  );
}

function updateLaunchTicker() {
  const launches = Object.values(latestLaunches);
  if (launches.length === 0) {
    tickerBox.setContent('{grey-fg} ◉  No new launches discovered — scanning…{/}');
    return;
  }
  // Cycle through launches 4 at a time every 10s
  const visible = 4;
  const start   = tickerOffset % launches.length;
  const slice   = [];
  for (let i = 0; i < visible; i++) slice.push(launches[(start + i) % launches.length]);

  const items = slice.map(t => {
    const mcap   = t.marketCapUsd < 1_000_000
      ? `$${(t.marketCapUsd / 1000).toFixed(0)}K`
      : `$${(t.marketCapUsd / 1_000_000).toFixed(1)}M`;
    const age    = `${t.ageHours}h`;
    const ch1h   = t.change1h ?? 0;
    const chStr  = `${ch1h >= 0 ? '▲+' : '▼'}${Math.abs(ch1h).toFixed(1)}%`;
    const chCol  = ch1h >= 0 ? 'green-fg' : 'red-fg';
    const bs     = t.buySellRatio != null ? ` bs:${t.buySellRatio.toFixed(2)}` : '';
    return `{white-fg}{bold}${t.symbol}{/} {grey-fg}${mcap} ${age}${bs}{/} {${chCol}}${chStr}{/}`;
  });

  tickerBox.setContent(
    `{cyan-fg}◉ LAUNCHES (${launches.length}){/}   ` +
    items.join('   {grey-fg}│{/}   ')
  );
}

function updateTradeLog() {
  if (tradeHistory.length === 0) {
    tradeLogBox.setContent('{grey-fg}No trades this session.{/}');
    return;
  }
  const lines = [
    '{cyan-fg}{bold}TIME   SIDE  TOKEN        AMT{/}',
    '{cyan-fg}' + '─'.repeat(35) + '{/}',
  ];
  for (const t of tradeHistory.slice(0, 16)) {
    const time  = t.time.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    const side  = (t.side ?? t.type ?? '?').toLowerCase();
    const sc    = side === 'buy' ? 'green-fg' : 'red-fg';
    const sign  = side === 'buy' ? '+' : '−';
    const asset = (t.asset ?? '?').slice(0, 9).padEnd(9);
    const amt   = fmtUSD(t.amountUsd ?? 0);
    const icon  = t.status === 'executed' ? '{green-fg}✓{/}' : '{grey-fg}~{/}';
    lines.push(
      `{grey-fg}${time}{/} ` +
      `{${sc}}{bold}${sign}${side.toUpperCase().padEnd(4)}{/} ` +
      `{white-fg}${asset}{/} ` +
      `{grey-fg}${amt}{/} ${icon}`
    );
  }
  tradeLogBox.setContent(lines.join('\n'));
}

function buildChartBounds(pctSeries) {
  const yMin   = Math.min(...pctSeries);
  const yMax   = Math.max(...pctSeries);
  const yRange = yMax - yMin;
  const pad    = Math.max(0.05, yRange * 0.2);
  pnlChart.options.minY = parseFloat((yMin - pad).toFixed(4));
  pnlChart.options.maxY = parseFloat((yMax + pad).toFixed(4));
}

function updatePnlChart(history, market = {}) {
  // ── Token price series ───────────────────────────────────────────────────────
  if (selectedChartSeries !== 'portfolio') {
    const token    = selectedChartSeries;
    const priceHist = tokenPriceHistory[token] ?? [];
    if (priceHist.length < 2) {
      pnlChart.setLabel(` ${token} Price [c] — awaiting data `);
      pnlChart.options.minY = -0.1;
      pnlChart.options.maxY =  0.1;
      pnlChart.setData([{ title: '', x: [' '], y: [0] }]);
      return;
    }
    const win    = priceHist.slice(-90);
    const first  = win[0].price;
    const last   = win[win.length - 1].price;
    const pct    = ((last - first) / first) * 100;
    const sign   = pct >= 0 ? '+' : '';
    const arrow  = pct >= 0 ? '▲' : '▼';
    const color  = pct >= 0 ? 'green' : 'red';
    const series = win.map(s => parseFloat(((s.price - first) / first * 100).toFixed(4)));
    const step   = Math.max(1, Math.floor(win.length / 6));
    const xs     = win.map((s, i) => (i % step === 0 ? hhmm(s.timestamp) : ' '));
    buildChartBounds(series);
    pnlChart.setLabel(` ${arrow} ${fmtPrice(last)}  ${sign}${pct.toFixed(2)}%  ${token} `);
    pnlChart.setData([{ title: '', x: xs, y: series, style: { line: color } }]);
    return;
  }

  // ── Portfolio value series ───────────────────────────────────────────────────
  if (history.length < 2) {
    pnlChart.setLabel(' Portfolio P&L — awaiting data ');
    pnlChart.options.minY = -0.1;
    pnlChart.options.maxY =  0.1;
    pnlChart.setData([{ title: '', x: [' '], y: [0] }]);
    return;
  }

  const win      = history.slice(-chartWindow);
  const baseline = sessionBaseline ?? win[0].totalValueUsd;
  const last     = win[win.length - 1].totalValueUsd;
  const pnlUsd   = last - baseline;
  const pnlPct   = (pnlUsd / baseline) * 100;
  const sign     = pnlUsd >= 0 ? '+' : '';
  const arrow    = pnlUsd >= 0 ? '▲' : '▼';
  const color    = pnlUsd >= 0 ? 'green' : 'red';

  // % change series relative to session baseline
  const pctSeries = win.map(s => parseFloat(((s.totalValueUsd - baseline) / baseline * 100).toFixed(4)));
  buildChartBounds(pctSeries);

  // X labels: only show every Nth tick to avoid crowding
  const step = Math.max(1, Math.floor(win.length / 6));
  const xs   = win.map((s, i) => (i % step === 0 ? hhmm(s.timestamp) : ' '));

  // Biggest mover
  let leadSymbol = null, leadCh = 0;
  for (const [sym, data] of Object.entries(market)) {
    if (data.change24h != null && Math.abs(data.change24h) > Math.abs(leadCh)) {
      leadSymbol = sym; leadCh = data.change24h;
    }
  }
  const leadStr = leadSymbol ? `  ${leadCh >= 0 ? '▲' : '▼'} ${leadSymbol} ${leadCh >= 0 ? '+' : ''}${leadCh.toFixed(1)}%` : '';

  const winLabel = chartWindow === 60 ? '1m' : chartWindow === 240 ? '4m' : chartWindow === 300 ? 'all' : `${chartWindow}s`;
  pnlChart.setLabel(` ${arrow} ${fmtUSD(last)}  ${sign}${fmtUSD(pnlUsd)} (${sign}${pnlPct.toFixed(2)}%) vs start${leadStr}  [${winLabel}] `);
  pnlChart.setData([{
    title: '',
    x: xs,
    y: pctSeries,
    style: { line: color },
  }]);
}

function updateReasonDisplay(result, triggeredBy = null) {
  lastReasonResult  = result;
  lastReasonTrigger = triggeredBy;
  const { decision, violations, blocked, execution, stopLossBypass, takeProfitBypass } = result;

  const ACTION_COLOR = {
    hold: 'yellow-fg', rebalance: 'cyan-fg', buy: 'green-fg', sell: 'red-fg', alert: 'magenta-fg',
  };
  const actionColor = ACTION_COLOR[decision.action] ?? 'white-fg';
  const conf        = ((decision.confidence ?? 0) * 100).toFixed(0);
  const bar         = confBar(parseFloat(conf));

  const execTrades = execution?.trades ?? [];
  const nDone      = execTrades.filter(t => t.status === 'executed').length;
  const nDry       = execTrades.filter(t => t.status === 'dry_run').length;
  const nFail      = execTrades.filter(t => t.status === 'failed' || t.status === 'blocked').length;

  // ── Column widths — dynamic, fills terminal, C2 center = screen center ──────
  const usable = Math.max(90, screen.width - 4); // inner box width
  const SEP    = ' {cyan-fg}│{/} ';              // 3 visible chars
  const cW     = Math.floor((usable - 6) / 3);   // equal thirds

  const DIV = '{cyan-fg}' + '─'.repeat(cW) + '{/}';

  // Exec outcome pills (compact, for C1 header line)
  const execPills = execTrades.length > 0
    ? [
        nDone > 0 ? `{green-fg}✓ ${nDone} exec{/}` : '',
        nDry  > 0 ? `{cyan-fg}~ ${nDry} dry{/}`    : '',
        nFail > 0 ? `{red-fg}✗ ${nFail} fail{/}`   : '',
      ].filter(Boolean).join('  ')
    : execution?.status === 'throttled'              ? '{white-fg}⏸ throttled{/}'
    : execution?.status === 'skipped_low_confidence' ? '{white-fg}⏸ low conf{/}'
    : '';

  const bypassTag = stopLossBypass  ? '  {red-fg}⚡ STOP-LOSS{/}'
                  : takeProfitBypass ? '  {green-fg}✓ TAKE-PROFIT{/}'
                  : '';

  // ── C1 — DECISION ─────────────────────────────────────────────────────────
  const C1 = [];

  // Big action line
  C1.push(`{bold}{${actionColor}}${(decision.action ?? '?').toUpperCase()}{/}` +
          `  ${bar}  {bold}${conf}%{/}` +
          (blocked ? '  {red-fg}⛔ BLOCKED{/}' : '') + bypassTag);

  // Trigger / exec outcome
  const metaParts = [
    triggeredBy ? `{white-fg}↳ ${triggeredBy}{/}` : '',
    execPills,
  ].filter(Boolean);
  if (metaParts.length) C1.push(metaParts.join('  '));

  C1.push(DIV);
  C1.push('{bold}TRADES{/}');

  // Recent decisions — add now so this cycle is included
  const _ex = execution;
  const execStatus =
    decision.action === 'hold'                              ? 'hold'
    : _ex?.status === 'throttled'                          ? 'throttled'
    : _ex?.status === 'skipped_low_confidence'             ? 'low conf'
    : _ex?.trades?.some(t => t.status === 'executed')      ? 'executed'
    : _ex?.trades?.some(t => t.status === 'failed')        ? 'failed'
    : _ex?.status === 'dry_run' || _ex?.trades?.some(t => t.status === 'dry_run') ? 'dry run'
    : _ex?.status === 'skipped'                            ? 'skipped'
    : '';
  localDecisionHistory.push({
    action: decision.action ?? '?', confidence: conf,
    timestamp: new Date(), triggeredBy: triggeredBy ?? 'manual', execStatus,
  });
  if (localDecisionHistory.length > 6) localDecisionHistory.shift();

  const tradesToShow = execTrades.length > 0 ? execTrades : (decision.trades ?? []);
  if (tradesToShow.length > 0) {
    for (const t of tradesToShow) {
      const isSwap = t.type === 'swap';
      const side   = (t.type ?? '?').toUpperCase();
      const sign   = t.type === 'buy' ? '+' : isSwap ? '⇄' : '−';
      const asset  = isSwap
        ? `${(t.fromAsset ?? '?')}→${(t.toAsset ?? '?')}`.padEnd(7)
        : (t.asset ?? '').padEnd(7);
      const amt   = (t.amountUsd != null ? fmtUSD(t.amountUsd) : '').padEnd(8);
      // Derive fallback label from overall execution status when no per-trade status exists
      const overallStatus = _ex?.status ?? '';
      const fallbackLabel =
        overallStatus === 'throttled'             ? 'throttled'
        : overallStatus === 'skipped_low_confidence' ? 'low conf'
        : overallStatus === 'skipped'             ? 'skipped'
        : 'queued';
      let icon, color, label;
      if      (t.status === 'executed') { icon = '✓'; color = 'green-fg'; label = 'on-chain';    }
      else if (t.status === 'dry_run')  { icon = '~'; color = 'cyan-fg';  label = 'dry run';     }
      else if (t.status === 'blocked')  { icon = '✗'; color = 'red-fg';   label = (t.reason ?? 'blocked').slice(0, 16); }
      else if (t.status === 'failed')   { icon = '⚠'; color = 'red-fg';   label = 'failed';      }
      else if (t.status === 'skipped')  { icon = '—'; color = 'white-fg'; label = 'skipped';     }
      else                              { icon = '·'; color = 'grey-fg';   label = fallbackLabel; }
      C1.push(` {${color}}{bold}${icon}{/} {${color}}${sign} ${side.padEnd(4)} ${asset} ${amt}{/}{white-fg}${label}{/}`);
    }
  } else {
    C1.push(' · no trades');
  }

  C1.push(DIV);
  if (lastTradeStats && lastTradeStats.total > 0) {
    const { total, wins, winRate, avgGain, avgLoss } = lastTradeStats;
    const wrColor = winRate >= 60 ? 'green-fg' : winRate >= 40 ? 'yellow-fg' : 'red-fg';
    const gainStr = avgGain != null ? `{green-fg}+${avgGain.toFixed(1)}%{/}` : '';
    const lossStr = avgLoss != null ? `{red-fg}${avgLoss.toFixed(1)}%{/}` : '';
    C1.push(`{bold}PERFORMANCE{/}  {${wrColor}}${winRate}% win rate{/}  ${wins}/${total} trades  avg ${gainStr} / ${lossStr}`);
    C1.push(DIV);
  }
  C1.push('{bold}HISTORY{/}');
  for (const entry of [...localDecisionHistory].reverse()) {
    const ac  = ACTION_COLOR[entry.action] ?? 'white-fg';
    const time = entry.timestamp.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    const stag =
      entry.execStatus === 'executed'  ? '  {green-fg}✓ executed{/}'
      : entry.execStatus === 'dry run' ? '  {cyan-fg}~ dry run{/}'
      : entry.execStatus === 'throttled' ? '  {grey-fg}⏸ throttled{/}'
      : entry.execStatus === 'low conf'  ? '  {grey-fg}⏸ low conf{/}'
      : entry.execStatus === 'failed'    ? '  {red-fg}✗ failed{/}'
      : entry.execStatus === 'skipped'   ? '  {grey-fg}– skipped{/}'
      : '';
    C1.push(` ${time}  {${ac}}{bold}${entry.action.toUpperCase().padEnd(9)}{/}  ${entry.confidence}%${stag}`);
  }

  // ── C2 — RATIONALE (center column = dashboard center) ─────────────────────
  const C2 = [];

  C2.push('{bold}RATIONALE{/}');
  C2.push(DIV);
  for (const line of wordWrap(decision.rationale ?? 'N/A', cW)) C2.push(line);

  const rawFlags = [
    ...(decision.riskFlags ?? []).filter(f =>
      !f.startsWith('BLOCKED') && !f.startsWith('TRIMMED') &&
      !f.startsWith('AUTO STOP') && !f.startsWith('AUTO-CONVERTED')
    ),
    ...violations.filter(v => !v.startsWith('TRIMMED')),
  ];
  const uniqueFlags = [...new Set(rawFlags)];
  if (uniqueFlags.length > 0) {
    C2.push('');
    C2.push('{bold}FLAGS{/}');
    C2.push(DIV);
    for (const f of uniqueFlags) {
      const isCrit = f.startsWith('BLOCKED') || f.startsWith('HALT') || f.startsWith('STOP');
      const color  = isCrit ? 'red-fg' : 'yellow-fg';
      const icon   = isCrit ? '✗' : '⚠';
      const wrapped = wordWrap(`${icon} ${f}`, cW - 1);
      C2.push(`{${color}}${wrapped[0]}{/}`);
      for (let i = 1; i < wrapped.length; i++) C2.push(`{${color}}  ${wrapped[i]}{/}`);
    }
  }

  // ── C3 — MARKET ───────────────────────────────────────────────────────────
  const C3 = [];
  const market    = lastMarketSnapshot ?? {};
  const portfolio = lastPortfolio;

  C3.push('{bold}MARKET{/}');
  C3.push(DIV);

  if (portfolio?.holdings?.length) {
    C3.push(`{bold}${'HOLDINGS'.padEnd(9)}  ${'1H'.padStart(6)}   ${'24H'.padStart(6)}{/}`);
    for (const h of portfolio.holdings.filter(h => h.token && h.token !== 'USDC' && (h.value ?? 0) > 0)) {
      const sym = h.token;
      const m   = market[sym] ?? {};
      const h1  = m.change1h  != null ? `${m.change1h  >= 0 ? '+' : ''}${m.change1h.toFixed(2)}%`  : '   —  ';
      const h24 = m.change24h != null ? `${m.change24h >= 0 ? '+' : ''}${m.change24h.toFixed(2)}%` : '   —  ';
      const c1  = (m.change1h  ?? 0) >= 0 ? 'green-fg' : 'red-fg';
      const c24 = (m.change24h ?? 0) >= 0 ? 'green-fg' : 'red-fg';
      C3.push(` ${sym.padEnd(8)}  {${c1}}${h1.padStart(6)}{/}   {${c24}}${h24.padStart(6)}{/}`);
    }
    C3.push('');
  }

  const heldSet = new Set((portfolio?.holdings ?? []).map(h => h.token).filter(Boolean));
  const movers  = Object.entries(market)
    .filter(([sym, d]) => !heldSet.has(sym) && sym !== 'USDC' && d.change1h != null)
    .sort((a, b) => b[1].change1h - a[1].change1h)
    .slice(0, 4);

  if (movers.length > 0) {
    C3.push('{bold}TOP MOVERS (1H){/}');
    for (const [sym, d] of movers) {
      const c   = d.change1h >= 0 ? 'green-fg' : 'red-fg';
      const vol = d.volume24hUsd != null ? `  {white-fg}$${(d.volume24hUsd / 1e6).toFixed(0)}M{/}` : '';
      C3.push(` {${c}}{bold}${sym.padEnd(9)}{/}{${c}}${d.change1h >= 0 ? '+' : ''}${d.change1h.toFixed(2)}%{/}${vol}`);
    }
    C3.push('');
  }

  if (portfolio?.holdings?.length) {
    const moves = portfolio.holdings
      .filter(h => h.token && h.token !== 'USDC' && (h.value ?? 0) > 0 && market[h.token]?.change24h != null)
      .map(h => market[h.token].change24h);
    const up  = moves.filter(c => c > 0).length;
    const dn  = moves.filter(c => c < 0).length;
    const hc  = up > dn ? 'green-fg' : dn > up ? 'red-fg' : 'yellow-fg';
    C3.push(`{bold}HEALTH{/}  {${hc}}${up}↑  ${dn}↓{/}  (24h)`);

    const totalValue  = portfolio.totalValue ?? portfolio.totalValueUsd ?? 0;
    const cashHolding = portfolio.holdings.find(h => h.token === 'USDC');
    const cashUsd     = cashHolding?.value ?? 0;
    const cashPct     = totalValue > 0 ? ((cashUsd / totalValue) * 100).toFixed(1) : '0.0';
    C3.push(`{bold}CASH{/}   $${cashUsd.toFixed(2)}  {white-fg}(${cashPct}%){/}`);
  }

  // ── Zip all 3 columns ─────────────────────────────────────────────────────
  const rows  = Math.max(C1.length, C2.length, C3.length);
  const lines = [];
  for (let i = 0; i < rows; i++) {
    lines.push(padCol(C1[i] ?? '', cW) + SEP + padCol(C2[i] ?? '', cW) + SEP + (C3[i] ?? ''));
  }

  reasonBox.setContent(lines.join('\n'));
  reasonBox.setScrollPerc(0);

  // Record executed trades in session trade history
  if (execution?.trades) {
    for (const t of execution.trades) {
      if (t.status === 'executed') sessionTradeCount++;
      if (t.status === 'executed' || t.status === 'dry_run') {
        tradeHistory.unshift({
          time:    new Date(),
          side:    t.side ?? t.type ?? '?',
          asset:   t.type === 'swap' ? `${t.fromAsset ?? '?'}→${t.toAsset ?? '?'}` : (t.asset ?? '?'),
          amountUsd: t.amountUsd ?? 0,
          status:  t.status,
          txid:    t.txid,
        });
      }
    }
    if (tradeHistory.length > 20) tradeHistory = tradeHistory.slice(0, 20);
    updateTradeLog();
  }

  // macOS notifications for significant events
  if (stopLossBypass) {
    notify('Mercer — Stop-Loss', `Mandatory exit triggered. Check dashboard.`);
  } else if (takeProfitBypass) {
    notify('Mercer — Take Profit', `Take-profit target reached. Partial exit executed.`);
  } else if (execution?.trades?.some(t => t.status === 'executed')) {
    const summary = execution.trades
      .filter(t => t.status === 'executed')
      .map(t => t.type === 'swap'
        ? `SWAP ${t.fromAsset ?? '?'}→${t.toAsset ?? '?'} ${fmtUSD(t.amountUsd ?? 0)}`
        : `${t.side?.toUpperCase() ?? '?'} ${t.asset ?? ''} ${fmtUSD(t.amountUsd ?? 0)}`
      )
      .join(', ');
    notify('Mercer — Trade Executed', summary);
  }

  // Flash decision box border green on executed trades, red on stop-loss
  const hasExecuted = execution?.trades?.some(t => t.status === 'executed');
  if (hasExecuted || stopLossBypass || takeProfitBypass) {
    const flashColor = stopLossBypass ? 'red' : takeProfitBypass ? 'green' : 'green';
    let flashes = 0;
    const flashInterval = setInterval(() => {
      reasonBox.style.border.fg = (flashes % 2 === 0) ? flashColor : 'cyan';
      screen.render();
      if (++flashes >= 6) {
        clearInterval(flashInterval);
        reasonBox.style.border.fg = 'cyan';
        screen.render();
      }
    }, 200);
  }
}

// ─── Market merge helper ──────────────────────────────────────────────────────
// Ensures tokens priced via mint-lookup (micro-caps not in ecosystem map)
// are present in the market snapshot so all dashboard sections show their data.

function mergePortfolioIntoMarket(market, portfolio) {
  for (const h of (portfolio?.holdings ?? [])) {
    if (!h.token || h.price <= 0) continue;
    if (!market[h.token]) {
      // Token not in ecosystem map — seed from portfolio mint-price data
      market[h.token] = { price: h.price, change24h: h.change24h ?? null, change1h: null };
    } else if (market[h.token].change24h == null && h.change24h != null) {
      // Token is in map but missing change data — fill in from portfolio
      market[h.token].change24h = h.change24h;
    }
  }
  return market;
}

// ─── API fetch ────────────────────────────────────────────────────────────────

async function fetchJSON(url, opts = {}, timeoutMs = 15_000) {
  const fetchPromise = fetch(url, opts).then(async res => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  });
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Request timed out: ${url}`)), timeoutMs)
  );
  return Promise.race([fetchPromise, timeoutPromise]);
}

// ─── Status helper ────────────────────────────────────────────────────────────

function setStatus(mandate, violations, blocked, msg) {
  const violStr = blocked
    ? '{red-fg}⛔ BLOCKED{/}'
    : violations?.length
      ? `{red-fg}⚠ ${violations.length} violation(s){/}`
      : '{green-fg}✓ passed{/}';

  const cashUsd        = lastPortfolio?.holdings?.find(h => h.token === 'USDC')?.value ?? 0;
  const totalVal       = lastPortfolio?.totalValue ?? 0;
  const cashFloor      = mandate ? ((mandate.minCashPct ?? 0) / 100) * totalVal : 0;
  const deployable     = Math.max(0, cashUsd - cashFloor);
  const deployableStr  = totalVal > 0 ? `  {white-fg}$${deployable.toFixed(0)} deployable{/}` : '';

  const mandateStr = mandate
    ? `{cyan-fg}${MANDATE_PRESET.toUpperCase()}{/} · max ${mandate.maxPositionPct}% · SL ${mandate.stopLossPct}%${deployableStr}`
    : MANDATE_PRESET.toUpperCase();

  const walletTag = walletSource === 'live'
    ? '{green-fg}◈ LIVE{/}'
    : '{yellow-fg}◈ MOCK{/}';

  const launchCount = Object.keys(latestLaunches).length;
  const launchStr   = launchCount > 0 ? `{cyan-fg}${launchCount} launches{/}  ` : '';
  const tradeStr    = sessionTradeCount > 0 ? `{green-fg}${sessionTradeCount} trade${sessionTradeCount !== 1 ? 's' : ''}{/}  ` : '';
  statusBox.setContent(
    `{grey-fg} [q]{/} Quit {grey-fg}[r]{/} Reason {grey-fg}[p]{/} Portfolio {grey-fg}[a]{/} Ask {grey-fg}[s]{/} Sell {grey-fg}[m]{/} Market {grey-fg}[c]{/} Chart {grey-fg}[h]{/} History {grey-fg}[1][4][0]{/} Window  {grey-fg}|{/}  ${walletTag}  ${mandateStr}  {grey-fg}|{/}  ${violStr}  {grey-fg}|{/}  ${launchStr}${tradeStr}${msg}`
  );
}

// ─── Splash + transition ──────────────────────────────────────────────────────

function showSplash(onDone) {
  const sw = screen.width;
  const sh = screen.height;

  const splashW = 60;
  const splashH = 12;
  const startTop  = Math.max(0, Math.floor(sh / 2) - Math.floor(splashH / 2));
  const startLeft = Math.max(0, Math.floor(sw / 2) - Math.floor(splashW / 2));

  // Destination: match exactly where the watermark logo sits inside the portfolio box.
  // tableBox: grid row 1, height 6 → top ≈ round(sh/12), height ≈ round(sh*6/12).
  // Data rows (header + divider + 5 holdings + divider + total + 2 blank) ≈ 11 lines.
  // Logo centering offset inside tableBox: TABLE_W padding - 1 left pad ≈ 6 chars from left edge.
  const tableTop  = Math.round(sh / 12);
  const tableH    = Math.round(sh * 6 / 12);
  const logoOffset = 11; // lines of table content before logo starts
  const endTop    = Math.min(tableTop + 1 + logoOffset, sh - splashH - 1);
  const endLeft   = Math.max(0, Math.round(sw * 8 / 12 / 2) - Math.floor(splashW / 2));

  const splash = blessed.box({
    parent:  screen,
    top:     startTop,
    left:    startLeft,
    width:   splashW,   // never changes — prevents logo from clipping/wrapping
    height:  splashH,
    tags:    true,
    align:   'center',
    valign:  'middle',
    content: '\n' + SPLASH_CONTENT,
    border:  { type: 'line', fg: 'cyan' },
    style:   { fg: 'cyan', bg: 'black', border: { fg: 'cyan' } },
  });

  screen.render();

  let dismissed = false;
  const startTransition = () => {
    if (dismissed) return;
    dismissed = true;

    const FRAMES     = 28;
    const DELAY      = 55;
    const fadeAt     = 14;
    const fadeColors = ['cyan','cyan','blue','blue','grey','grey','grey','black','black','black','black','black','black','black'];
    let frame = 0;
    let fi    = 0;

    const tick = setInterval(() => {
      const t    = Math.min(frame / (FRAMES - 1), 1);
      const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
      splash.top  = lerp(startTop,  endTop,  ease);
      splash.left = lerp(startLeft, endLeft, ease);
      if (frame >= fadeAt) {
        const col = fadeColors[Math.min(fi, fadeColors.length - 1)];
        splash.style.fg     = col;
        splash.style.border = { fg: col };
        fi++;
      }
      screen.render();
      frame++;
      if (frame >= FRAMES) {
        clearInterval(tick);
        splash.destroy();
        screen.render();
        onDone();
      }
    }, DELAY);
  };

  setTimeout(startTransition, 3500);
}

// ─── Refresh cycle ────────────────────────────────────────────────────────────

let isRefreshing         = false;
let isDataRefreshing     = false;

// ─── Portfolio spinner ────────────────────────────────────────────────────────
const SPINNER_FRAMES = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
let spinnerFrame  = 0;
let spinnerActive = false;
setInterval(() => {
  const active = isRefreshing || isDataRefreshing;
  if (!active) {
    if (spinnerActive) {
      spinnerActive = false;
      tableBox.setLabel(' Portfolio Holdings ');
      tradeLogBox.setLabel(' Trade Log ');
      reasonBox.setLabel(' Claude Decisions ');
      screen.render();
    }
    return;
  }
  spinnerActive = true;
  spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
  const spin = SPINNER_FRAMES[spinnerFrame];
  tableBox.setLabel(` Portfolio Holdings  {cyan-fg}${spin}{/} `);
  tradeLogBox.setLabel(` Trade Log {cyan-fg}${spin}{/} `);
  reasonBox.setLabel(isRefreshing
    ? ` Claude Decisions {cyan-fg}${spin} reasoning{/} `
    : ` Claude Decisions {cyan-fg}${spin}{/} `);
  screen.render();
}, 100);
let lastUpdatedAt        = null;
let nextRefreshAt        = null;
let lastMandate          = null;
let lastViolations       = [];
let lastBlocked          = false;
let lastMarketSnapshot   = null;
let lastTradeStats       = null;
let sessionCycles        = 0;
let localDecisionHistory = [];
let liveHistory          = [];   // in-memory chart data, appended every data refresh
let lastPortfolio        = null; // last fetched portfolio, reused for chart ticks
let lastReasonResult     = null; // last reasoning result — replayed on terminal resize
let lastReasonTrigger    = null;
let lastMaxMovement      = { symbol: null, pct: 0 };
let walletSource         = 'mock';   // 'live' | 'mock'
let adaptiveThreshold    = REASON_THRESHOLD;
let tradeHistory         = [];       // recent executed trades
let selectedMarketToken  = null;     // null = all-token ticker, string = detail view
let selectedChartSeries  = 'portfolio'; // 'portfolio' | token symbol
const tokenPriceHistory  = {};       // token → [{timestamp, price}]
let sessionBaseline      = null;     // first portfolio value this session — P&L anchor
let chartWindow          = 90;       // number of history points to show in chart
let latestLaunches       = {};       // last DexScreener launch snapshot
let tickerOffset         = 0;        // cycling position in launches ticker
let sessionTradeCount    = 0;        // total executed trades this session
const rowFlash           = new Map(); // symbol → { dir: 'up'|'down', expiresAt }
const positionSince      = new Map(); // symbol → timestamp (when first observed)

// ── Load last decision from disk so the box isn't blank on first open ─────────
function loadLastDecision() {
  try {
    const raw  = readFileSync(join(process.cwd(), 'data', 'decisions.json'), 'utf8');
    const hist = JSON.parse(raw);
    if (!hist.length) return;
    // Seed localDecisionHistory from last 5 persisted entries
    const last5 = hist.slice(-5);
    for (const d of last5) {
      localDecisionHistory.push({
        action:      d.action ?? 'hold',
        confidence:  ((d.confidence ?? 0) * 100).toFixed(0),
        timestamp:   new Date(d.timestamp ?? Date.now()),
        triggeredBy: 'persisted',
      });
    }
    // Show the most recent decision in the box immediately (3-col layout)
    const last = hist[hist.length - 1];
    if (last) {
      const AC_MAP = { hold:'yellow-fg', rebalance:'cyan-fg', buy:'green-fg', sell:'red-fg', alert:'magenta-fg' };
      const ac   = AC_MAP[last.action] ?? 'white-fg';
      const conf = ((last.confidence ?? 0) * 100).toFixed(0);
      const ts   = new Date(last.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
      const usable = Math.max(90, screen.width - 4);
      const cW     = Math.floor((usable - 6) / 3);
      const DIV    = '{cyan-fg}' + '─'.repeat(cW) + '{/}';
      const SEP    = ' {cyan-fg}│{/} ';

      const C1 = [
        `{bold}{${ac}}${(last.action ?? '?').toUpperCase()}{/}  ${confBar(parseFloat(conf))}  {bold}${conf}%{/}`,
        `{white-fg}↳ ${ts} · persisted{/}`,
        DIV,
        '{bold}TRADES{/}',
        ' · no live data yet',
        DIV,
        '{bold}HISTORY{/}',
        ...localDecisionHistory.slice().reverse().map(e => {
          const eac  = AC_MAP[e.action] ?? 'white-fg';
          const ets  = e.timestamp.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
          const stag =
            e.execStatus === 'executed'   ? '  {green-fg}✓ executed{/}'
            : e.execStatus === 'dry run'  ? '  {cyan-fg}~ dry run{/}'
            : e.execStatus === 'throttled'? '  {grey-fg}⏸ throttled{/}'
            : e.execStatus === 'low conf' ? '  {grey-fg}⏸ low conf{/}'
            : e.execStatus === 'failed'   ? '  {red-fg}✗ failed{/}'
            : e.execStatus === 'skipped'  ? '  {grey-fg}– skipped{/}'
            : '';
          return ` ${ets}  {${eac}}{bold}${e.action.toUpperCase().padEnd(9)}{/}  ${e.confidence}%${stag}`;
        }),
      ];

      const C2 = [
        '{bold}RATIONALE{/}',
        DIV,
        ...wordWrap(last.rationale ?? 'N/A', cW),
      ];

      const C3 = [
        '{bold}MARKET{/}',
        DIV,
        '{white-fg}Waiting for live data…{/}',
      ];

      const rows  = Math.max(C1.length, C2.length, C3.length);
      const lines = [];
      for (let i = 0; i < rows; i++) {
        lines.push(padCol(C1[i] ?? '', cW) + SEP + padCol(C2[i] ?? '', cW) + SEP + (C3[i] ?? ''));
      }
      reasonBox.setContent(lines.join('\n'));
      reasonBox.setScrollPerc(0);
    }
  } catch {
    // No history file yet — that's fine
  }
}

// Compute a volatility-adjusted threshold from current 24h market changes.
// Set to ~1/3 of the average absolute 24h move, clamped between 0.5% and 4%.
function computeAdaptiveThreshold(market) {
  const changes = Object.values(market)
    .map(d => Math.abs(d.change24h ?? 0))
    .filter(v => v > 0);
  if (changes.length === 0) return REASON_THRESHOLD;
  const avg = changes.reduce((s, v) => s + v, 0) / changes.length;
  return Math.max(0.5, Math.min(4, avg * 0.35));
}

function getMovementInfo(current) {
  if (!lastMarketSnapshot) return { moved: true, triggerDesc: 'startup', maxSymbol: null, maxPct: 0 };

  // ── Inter-cycle price movement check ────────────────────────────────────────
  let maxPct = 0;
  let maxSymbol = null;
  for (const [symbol, data] of Object.entries(current)) {
    const prev = lastMarketSnapshot[symbol];
    if (!prev) { maxPct = adaptiveThreshold; maxSymbol = symbol; continue; }
    const pct = Math.abs((data.price - prev.price) / prev.price) * 100;
    if (pct > maxPct) { maxPct = pct; maxSymbol = symbol; }
  }

  // ── Force-trigger on alarming 24h moves (>40% of stop-loss threshold) ───────
  // e.g. moderate mandate: stopLossPct=20 → trigger if any token down >8% in 24h
  const stopLossPct = lastMandate?.stopLossPct ?? 20;
  const dangerPct   = stopLossPct * 0.4;
  let forceTrigger  = false;
  let forceSymbol   = null;
  let forcePct      = 0;
  for (const [symbol, data] of Object.entries(current)) {
    const abs24h = Math.abs(data.change24h ?? 0);
    if (abs24h >= dangerPct && abs24h > forcePct) {
      forceTrigger = true;
      forceSymbol  = symbol;
      forcePct     = abs24h;
    }
  }

  const moved = maxPct >= adaptiveThreshold || forceTrigger;
  let triggerDesc = null;
  if (forceTrigger && (!maxSymbol || forcePct > maxPct)) {
    const dir = (current[forceSymbol]?.change24h ?? 0) >= 0 ? '+' : '-';
    triggerDesc = `${forceSymbol} 24h ${dir}${forcePct.toFixed(1)}% (danger)`;
  } else if (moved && maxSymbol && lastMarketSnapshot[maxSymbol]) {
    const dir = current[maxSymbol].price >= lastMarketSnapshot[maxSymbol].price ? '+' : '-';
    triggerDesc = `${maxSymbol} ${dir}${maxPct.toFixed(1)}%`;
  }
  return { moved, triggerDesc, maxSymbol: forceSymbol ?? maxSymbol, maxPct: Math.max(maxPct, forcePct) };
}

// Lightweight data refresh — updates prices + portfolio without calling Claude
async function doDataRefresh() {
  if (isRefreshing || isDataRefreshing) return;
  isDataRefreshing = true;

  try {
    const portfolio = await fetchJSON(`${API_BASE}/portfolio`);
    const market    = await fetchJSON(`${API_BASE}/market`);

    walletSource       = portfolio.source ?? 'mock';
    lastPortfolio      = portfolio;
    lastMarketSnapshot = mergePortfolioIntoMarket(market, portfolio);

    // Track position entry times
    const heldSyms = new Set((portfolio.holdings ?? []).map(h => h.token).filter(Boolean));
    for (const sym of heldSyms) {
      if (sym !== 'USDC' && sym !== 'SOL' && !positionSince.has(sym)) positionSince.set(sym, Date.now());
    }
    for (const [sym] of positionSince) { if (!heldSyms.has(sym)) positionSince.delete(sym); }

    updatePortfolioTable(portfolio, lastMarketSnapshot);
    updateMarketBox(selectedMarketToken, lastMarketSnapshot);
    updateTradeLog();

    const mandates = await fetchJSON(`${API_BASE}/mandates`);
    lastMandate    = mandates[MANDATE_PRESET];

    const statsData = await fetchJSON(`${API_BASE}/stats`).catch(() => null);
    if (statsData?.tradeStats) lastTradeStats = statsData.tradeStats;

    // Fetch new launches for ticker
    fetchJSON(`${API_BASE}/launches`).then(launches => {
      latestLaunches = launches ?? {};
      updateLaunchTicker();
    }).catch(() => {});

    if (liveHistory.length === 0) {
      const h = await fetchJSON(`${API_BASE}/portfolio/history`);
      liveHistory = h.slice(-50);
    }
    liveHistory.push({ timestamp: new Date().toISOString(), totalValueUsd: portfolio.totalValue });
    if (liveHistory.length > 120) liveHistory = liveHistory.slice(-120);
    updatePnlChart(liveHistory, market);

    lastUpdatedAt = new Date();
    const secsLeft = nextRefreshAt ? Math.max(0, Math.round((nextRefreshAt - Date.now()) / 1000)) : Math.round(REFRESH_MS / 1000);
    const costStr  = `{grey-fg}~$${(sessionCycles * COST_PER_CYCLE).toFixed(3)} (${sessionCycles} cycle${sessionCycles !== 1 ? 's' : ''}){/}`;
    const movStr   = lastMaxMovement.symbol ? `  {grey-fg}${lastMaxMovement.symbol} ${lastMaxMovement.pct.toFixed(1)}%/${adaptiveThreshold.toFixed(1)}%{/}` : '';
    setStatus(
      lastMandate, lastViolations, lastBlocked,
      `{green-fg}Updated: ${lastUpdatedAt.toLocaleTimeString()}{/}  ${costStr}${movStr}  Next reason in {cyan-fg}${fmtCountdown(secsLeft)}{/}`
    );
  } catch (err) {
    const msg = err.message.replace(/[{}]/g, '');
    setStatus(lastMandate, lastViolations, lastBlocked, `{red-fg}Error: ${msg}{/}`);
  } finally {
    isDataRefreshing = false;
    screen.render();
  }
}

// Full refresh — data + reasoning cycle (runs every REFRESH_MS)
// force=true bypasses the movement threshold (used for manual [r] key presses)
async function doRefresh(force = false) {
  if (isRefreshing) return;
  isRefreshing     = true;
  isDataRefreshing = true; // block fast refresh while full cycle runs
  nextRefreshAt    = Date.now() + REFRESH_MS;

  try {
    setStatus(lastMandate, lastViolations, lastBlocked, '{yellow-fg}Fetching...{/}');
    screen.render();
    const portfolio = await fetchJSON(`${API_BASE}/portfolio`);
    const market    = await fetchJSON(`${API_BASE}/market`);

    walletSource      = portfolio.source ?? 'mock';
    lastPortfolio     = portfolio;
    mergePortfolioIntoMarket(market, portfolio);
    adaptiveThreshold = computeAdaptiveThreshold(market);
    updatePortfolioTable(portfolio, market);
    updateMarketBox(selectedMarketToken, market);
    screen.render();

    const mandates = await fetchJSON(`${API_BASE}/mandates`);
    lastMandate    = mandates[MANDATE_PRESET];

    if (liveHistory.length === 0) {
      const h = await fetchJSON(`${API_BASE}/portfolio/history`);
      liveHistory = h.slice(-50);
    }
    liveHistory.push({ timestamp: new Date().toISOString(), totalValueUsd: portfolio.totalValue });
    if (liveHistory.length > 120) liveHistory = liveHistory.slice(-120);
    updatePnlChart(liveHistory, market);
    screen.render();

    const { moved, triggerDesc, maxSymbol, maxPct } = getMovementInfo(market);
    lastMarketSnapshot = market;
    lastMaxMovement    = { symbol: maxSymbol, pct: maxPct };

    if (moved || force) {
      setStatus(lastMandate, lastViolations, lastBlocked, '{yellow-fg}Running reasoning cycle...{/}');
      screen.render();

      try {
        const reasonResult = await fetchJSON(`${API_BASE}/reason`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ mandate: MANDATE_PRESET }),
        }, 120_000);
        lastViolations = reasonResult.violations ?? [];
        lastBlocked    = reasonResult.blocked    ?? false;
        sessionCycles++;
        updateReasonDisplay(reasonResult, triggerDesc);
      } catch (reasonErr) {
        const msg = reasonErr.message.replace(/[{}]/g, '');
        reasonBox.setContent(`{red-fg}Reasoning failed: ${msg}\nWill retry next cycle.{/}`);
        reasonBox.setScrollPerc(0);
        setStatus(lastMandate, lastViolations, lastBlocked, `{red-fg}Reason error: ${msg}{/}`);
      }
      screen.render();
    }

    lastUpdatedAt = new Date();
    const costStr  = `{grey-fg}~$${(sessionCycles * COST_PER_CYCLE).toFixed(3)} (${sessionCycles} cycle${sessionCycles !== 1 ? 's' : ''}){/}`;
    const movStr   = maxSymbol ? `  {grey-fg}${maxSymbol} ${maxPct.toFixed(1)}%/${adaptiveThreshold.toFixed(1)}%{/}` : '';
    const skipNote = (moved || force) ? '' : `  {grey-fg}· skipped (no movement >${adaptiveThreshold.toFixed(1)}%){/}`;
    setStatus(
      lastMandate, lastViolations, lastBlocked,
      `{green-fg}Updated: ${lastUpdatedAt.toLocaleTimeString()}{/}  ${costStr}${movStr}${skipNote}  Next reason in {cyan-fg}${fmtCountdown(Math.round(REFRESH_MS / 1000))}{/}`
    );
  } catch (err) {
    const msg = err.message.replace(/[{}]/g, '');
    setStatus(lastMandate, lastViolations, lastBlocked, `{red-fg}Error: ${msg}{/}`);
    reasonBox.setContent(`{red-fg}Data fetch failed: ${msg}\nCheck that the server is running on port 3000.{/}`);
    reasonBox.setScrollPerc(0);
  } finally {
    isRefreshing     = false;
    isDataRefreshing = false;
    screen.render();
  }
}

// Countdown tick — updates "Next reason in" every second
setInterval(() => {
  if (confirmingQuit || isRefreshing || isDataRefreshing || !nextRefreshAt || !lastUpdatedAt) return;
  const secsLeft = Math.max(0, Math.round((nextRefreshAt - Date.now()) / 1000));
  const costStr  = `{grey-fg}~$${(sessionCycles * COST_PER_CYCLE).toFixed(3)} (${sessionCycles} cycle${sessionCycles !== 1 ? 's' : ''}){/}`;
  const movStr   = lastMaxMovement.symbol ? `  {grey-fg}${lastMaxMovement.symbol} ${lastMaxMovement.pct.toFixed(1)}%/${adaptiveThreshold.toFixed(1)}%{/}` : '';
  setStatus(
    lastMandate, lastViolations, lastBlocked,
    `{green-fg}Updated: ${lastUpdatedAt.toLocaleTimeString()}{/}  ${costStr}${movStr}  Next reason in {cyan-fg}${fmtCountdown(secsLeft)}{/}`
  );
  screen.render();
}, 1_000);

// ─── Ask Mercer — opens in a new terminal window ─────────────────────────────

function openAskTerminal() {
  const script = `tell application "Terminal"
    do script "cd '${process.cwd()}' && npm run ask"
    activate
  end tell`;
  spawn('osascript', ['-e', script], { detached: true }).unref();
}

// ─── macOS notifications ──────────────────────────────────────────────────────

function notify(title, msg) {
  const safe = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = `display notification "${safe(msg)}" with title "${safe(title)}"`;
  spawn('osascript', ['-e', script], { detached: true }).unref();
}

// ─── Trade history overlay ────────────────────────────────────────────────────

const tradeHistBox = blessed.box({
  parent:  screen,
  top:     'center',
  left:    'center',
  width:   62,
  height:  22,
  hidden:  true,
  tags:    true,
  border:  { type: 'line', fg: 'cyan' },
  label:   ' Trade History [h] ',
  padding: { top: 0, left: 2 },
  style:   { fg: 'white', bg: 'black', border: { fg: 'cyan' } },
});

let tradeHistVisible = false;

function toggleTradeHistory() {
  tradeHistVisible = !tradeHistVisible;
  if (tradeHistVisible) {
    if (tradeHistory.length === 0) {
      tradeHistBox.setContent('{grey-fg}No trades this session.{/}');
    } else {
      const lines = ['{cyan-fg}{bold}Time   Side  Asset       Amount        Status{/}',
                     '{cyan-fg}──────────────────────────────────────────────────{/}'];
      for (const t of tradeHistory) {
        const time = t.time.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
        const isSwapEntry = t.side === 'swap';
        const sc   = isSwapEntry ? 'cyan-fg' : t.side === 'buy' ? 'green-fg' : 'red-fg';
        const sign = isSwapEntry ? '⇄' : t.side === 'buy' ? '+' : '−';
        lines.push(
          `{grey-fg}${time}{/}  {${sc}}${sign} ${t.side.toUpperCase().padEnd(4)}  ${(t.asset ?? '?').padEnd(10)}  ${fmtUSD(t.amountUsd ?? 0).padEnd(12)}  ${t.status}{/}`
        );
      }
      tradeHistBox.setContent(lines.join('\n'));
    }
    tradeHistBox.show();
    tradeHistBox.setFront();
  } else {
    tradeHistBox.hide();
  }
  screen.render();
}

// ─── Quit confirmation ────────────────────────────────────────────────────────

let confirmingQuit = false;
function confirmQuit() {
  if (confirmingQuit) return;
  confirmingQuit = true;

  let secsLeft = 5;
  const restore = () => {
    confirmingQuit = false;
    clearInterval(countdown);
    setStatus(lastMandate, lastViolations, lastBlocked, lastUpdatedAt
      ? `{green-fg}Updated: ${lastUpdatedAt.toLocaleTimeString()}{/}`
      : 'Ready');
    screen.render();
  };

  const showPrompt = () => {
    statusBox.setContent(` {red-fg}Quit Mercer?{/}  {cyan-fg}[y]{/} Yes   {cyan-fg}[n]{/} No  {grey-fg}(${secsLeft}s){/}`);
    screen.render();
  };

  showPrompt();

  const countdown = setInterval(() => {
    secsLeft--;
    if (secsLeft <= 0) { restore(); return; }
    showPrompt();
  }, 1000);

  screen.once('keypress', (ch) => {
    if (ch === 'y' || ch === 'Y') { screen.destroy(); process.exit(0); }
    restore();
  });
}

// ─── Key bindings ─────────────────────────────────────────────────────────────

// ── Resize — reflow all baked-width content to new terminal dimensions ────────
screen.on('resize', () => {
  if (lastReasonResult)   updateReasonDisplay(lastReasonResult, lastReasonTrigger);
  if (lastPortfolio)      updatePortfolioTable(lastPortfolio, lastMarketSnapshot ?? {});
  if (lastMarketSnapshot) updateMarketBox(selectedMarketToken, lastMarketSnapshot);
  updateLaunchTicker();
  updateTradeLog();
  screen.render();
});

// ─── Manual sell ─────────────────────────────────────────────────────────────

function confirmSell(symbol) {
  let secsLeft = 5;
  const restore = () => {
    clearInterval(countdown);
    if (lastUpdatedAt) setStatus(lastMandate, lastViolations, lastBlocked,
      `{green-fg}Updated: ${lastUpdatedAt.toLocaleTimeString()}{/}`);
    screen.render();
  };
  const showPrompt = () => {
    statusBox.setContent(`{red-fg}Force sell ${symbol}?{/}  {cyan-fg}[y]{/} Yes  {cyan-fg}[n]{/} No  {grey-fg}(${secsLeft}s){/}`);
    screen.render();
  };
  showPrompt();
  const countdown = setInterval(() => { secsLeft--; if (secsLeft <= 0) { restore(); return; } showPrompt(); }, 1000);
  screen.once('keypress', (ch) => {
    clearInterval(countdown);
    if (ch === 'y' || ch === 'Y') {
      statusBox.setContent(`{yellow-fg}Selling ${symbol}…{/}`);
      screen.render();
      fetchJSON(`${API_BASE}/force-sell`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol }),
      }, 30_000).then(r => {
        notify('Mercer — Manual Sell', `${symbol} sell submitted`);
        if (r.execution?.trades) {
          for (const t of r.execution.trades) {
            if (t.status === 'executed') sessionTradeCount++;
            tradeHistory.unshift({ time: new Date(), side: 'sell', asset: symbol, amountUsd: t.amountUsd ?? 0, status: t.status });
          }
          if (tradeHistory.length > 20) tradeHistory = tradeHistory.slice(0, 20);
          updateTradeLog();
        }
        doDataRefresh();
      }).catch(err => {
        statusBox.setContent(`{red-fg}Sell failed: ${err.message}{/}`);
        screen.render();
        setTimeout(restore, 3000);
      });
    } else {
      restore();
    }
  });
}

screen.key(['q', 'C-c'],  () => { confirmQuit(); });
screen.key(['r'],          () => { doRefresh(true); });
screen.key(['p'],          () => { doDataRefresh(); });
screen.key(['a'],          () => { openAskTerminal(); });

screen.key(['s'], () => {
  if (activeDropdown) return;
  const tradeable = (lastPortfolio?.holdings ?? [])
    .filter(h => h.token && h.token !== 'USDC' && h.token !== 'SOL' && h.value > 0)
    .map(h => `${h.token.padEnd(10)} ${fmtUSD(h.value)}`);
  if (tradeable.length === 0) {
    setStatus(lastMandate, lastViolations, lastBlocked, '{grey-fg}No positions to sell{/}');
    return;
  }
  showDropdown(['Cancel', ...tradeable], tableBox, (choice) => {
    if (choice.startsWith('Cancel')) return;
    const symbol = choice.trim().split(/\s+/)[0];
    confirmSell(symbol);
  });
});
screen.key(['up'],         () => { reasonBox.scroll(-1); screen.render(); });
screen.key(['down'],       () => { reasonBox.scroll(1);  screen.render(); });
screen.key(['pageup'],     () => { reasonBox.scroll(-5); screen.render(); });
screen.key(['pagedown'],   () => { reasonBox.scroll(5);  screen.render(); });

screen.key(['h'], () => { toggleTradeHistory(); });

screen.key(['1'], () => {
  chartWindow = 60;
  updatePnlChart(liveHistory, lastMarketSnapshot ?? {});
  screen.render();
});
screen.key(['4'], () => {
  chartWindow = 240;
  updatePnlChart(liveHistory, lastMarketSnapshot ?? {});
  screen.render();
});
screen.key(['0'], () => {
  chartWindow = 300;
  updatePnlChart(liveHistory, lastMarketSnapshot ?? {});
  screen.render();
});

screen.key(['m'], () => {
  if (activeDropdown) {
    activeDropdown.destroy();
    activeDropdown = null;
    screen.render();
    return;
  }
  if (!lastMarketSnapshot) return;
  showDropdown(['All Tokens', ...heldTokens()], solBox, (choice) => {
    selectedMarketToken = choice === 'All Tokens' ? null : choice;
    updateMarketBox(selectedMarketToken, lastMarketSnapshot);
    screen.render();
  });
});

screen.key(['c'], () => {
  if (activeDropdown) {
    activeDropdown.destroy();
    activeDropdown = null;
    screen.render();
    return;
  }
  showDropdown(['Portfolio', ...heldTokens()], pnlChart, (choice) => {
    selectedChartSeries = choice === 'Portfolio' ? 'portfolio' : choice;
    updatePnlChart(liveHistory, lastMarketSnapshot ?? {});
    screen.render();
  });
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

screen.render();
async function doChartRefresh() {
  if (!lastPortfolio) return;
  try {
    const market = await fetchJSON(`${API_BASE}/market`);
    mergePortfolioIntoMarket(market, lastPortfolio);

    // Track per-token price history + flash on price change
    const now = new Date().toISOString();
    for (const [sym, data] of Object.entries(market)) {
      if (!tokenPriceHistory[sym]) tokenPriceHistory[sym] = [];
      const prev = lastMarketSnapshot?.[sym];
      if (prev?.price && data.price && data.price !== prev.price) {
        rowFlash.set(sym, { dir: data.price > prev.price ? 'up' : 'down', expiresAt: Date.now() + 2500 });
      }
      tokenPriceHistory[sym].push({ timestamp: now, price: data.price });
      if (tokenPriceHistory[sym].length > 300) tokenPriceHistory[sym] = tokenPriceHistory[sym].slice(-300);
    }

    if (liveHistory.length === 0) {
      try {
        const h = await fetchJSON(`${API_BASE}/portfolio/history`);
        liveHistory = h.slice(-60);
      } catch { /* no history yet */ }
    }
    const total = lastPortfolio.holdings.reduce((sum, h) => {
      const price = market[h.token]?.price ?? h.price ?? 0;
      return sum + h.balance * price;
    }, 0);
    liveHistory.push({ timestamp: now, totalValueUsd: total });
    if (!sessionBaseline && total > 0) sessionBaseline = total;
    if (liveHistory.length > 300) liveHistory = liveHistory.slice(-300);
    lastMarketSnapshot = market;
    updateMarketBox(selectedMarketToken, market);
    updatePnlChart(liveHistory, market);
    screen.render();
  } catch { /* silent */ }
}

// Trade-signal poller — triggers an immediate portfolio refresh when executor
// confirms a new on-chain trade, so new holdings appear within 5s.
let _lastSeenTradeAt  = null;
let _lastEarlyReason  = 0; // timestamp of last early-reason trigger
const EARLY_REASON_CD = 60_000; // minimum 60s between early reasoning cycles

async function pollTradeSignal() {
  try {
    const { lastTradeAt, earlyReason } = await fetchJSON(`${API_BASE}/events`);
    if (earlyReason && (Date.now() - _lastEarlyReason) > EARLY_REASON_CD) {
      _lastEarlyReason = Date.now();
      doRefresh(true);
    } else if (lastTradeAt && lastTradeAt !== _lastSeenTradeAt) {
      _lastSeenTradeAt = lastTradeAt;
      doDataRefresh();
    }
  } catch { /* server may not be up yet */ }
}

showSplash(() => {
  loadLastDecision();
  setInterval(doRefresh, REFRESH_MS);
  setInterval(doDataRefresh, DATA_REFRESH_MS);
  setInterval(doChartRefresh, 1_000);
  setInterval(pollTradeSignal, 5_000);
  // Cycle ticker every 10s
  setInterval(() => {
    const n = Object.keys(latestLaunches).length;
    if (n > 0) { tickerOffset = (tickerOffset + 4) % n; updateLaunchTicker(); screen.render(); }
  }, 10_000);
  doRefresh(true);
});
