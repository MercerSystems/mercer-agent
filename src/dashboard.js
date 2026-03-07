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
const tableBox = grid.set(1, 0, 6, 8, blessed.box, {
  label:       ' Portfolio Holdings ',
  tags:        true,
  transparent: true,
  border:      { type: 'line', fg: 'cyan' },
  padding:     { top: 0, left: 1 },
  style:       { fg: 'white' },
});

const solBox = grid.set(1, 8, 3, 4, blessed.box, {
  label:   ' Market ',
  tags:    true,
  border:  { type: 'line', fg: 'cyan' },
  padding: { top: 1, left: 2 },
  content: 'Loading...',
  style:   { fg: 'white' },
});

const pnlChart = grid.set(4, 8, 3, 4, contrib.line, {
  label:            ' Portfolio P&L ',
  showLegend:       false,
  border:           { type: 'line', fg: 'cyan' },
  style:            { line: 'cyan', text: 'white', baseline: 'black' },
  xLabelPadding:    1,
  xPadding:         1,
  wholeNumbersOnly: false,
});

const reasonBox = grid.set(7, 0, 4, 12, blessed.box, {
  label:        ' Claude Decisions',
  tags:         true,
  keys:         true,
  vi:           true,
  border:       { type: 'line', fg: 'blue' },
  padding:      { top: 0, left: 2 },
  scrollable:   true,
  alwaysScroll: false,
  scrollbar:    { ch: '▐', style: { fg: 'blue', bg: 'black' } },
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

// ─── Table + watermark renderer ───────────────────────────────────────────────

const COL_W   = [6, 12, 10, 11, 6, 8, 8];
const COL_SEP = '  ';
const TABLE_W = COL_W.reduce((a, b) => a + b, 0) + COL_SEP.length * (COL_W.length - 1);

function renderTable(portfolio, market = {}) {
  const { holdings, totalValue } = portfolio;
  const entryPrices = loadEntryPrices();

  const divider = COL_W.map(w => '─'.repeat(w)).join(COL_SEP);

  const headers = [
    '{cyan-fg}{bold}Token{/}',
    '{cyan-fg}{bold}Balance{/}',
    '{cyan-fg}{bold}Price{/}',
    '{cyan-fg}{bold}Value{/}',
    '{cyan-fg}{bold}%Port{/}',
    '{cyan-fg}{bold}P&L{/}',
    '{cyan-fg}{bold}24h{/}',
  ];

  const lines = [
    headers.map((h, i) => padCol(h, COL_W[i])).join(COL_SEP),
    divider,
  ];

  for (const h of holdings) {
    const ch       = market[h.token]?.change24h ?? null;
    const chColor  = ch == null ? 'grey-fg' : ch >= 0 ? 'green-fg' : 'red-fg';
    const chStr    = ch == null ? 'N/A' : `${ch >= 0 ? '+' : ''}${ch.toFixed(2)}%`;

    const ep       = entryPrices[h.token];
    const pnlPct   = ep && ep > 0 ? ((h.price - ep) / ep) * 100 : null;
    const pnlColor = pnlPct == null ? 'grey-fg' : pnlPct >= 0 ? 'green-fg' : 'red-fg';
    const pnlStr   = pnlPct == null ? 'N/A' : `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`;

    const row = [
      `{white-fg}${h.token}{/}`,
      '{white-fg}' + fmtQty(h.balance) + '{/}',
      '{white-fg}' + fmtPrice(h.price) + '{/}',
      '{white-fg}' + fmtUSD(h.value) + '{/}',
      '{grey-fg}' + ((h.value / totalValue) * 100).toFixed(1) + '%{/}',
      `{${pnlColor}}${pnlStr}{/}`,
      `{${chColor}}${chStr}{/}`,
    ];
    lines.push(row.map((cell, i) => padCol(cell, COL_W[i])).join(COL_SEP));
  }

  // Session P&L row
  const sessionPnlUsd = sessionBaseline ? totalValue - sessionBaseline : null;
  const sessionPnlPct = sessionBaseline ? (sessionPnlUsd / sessionBaseline) * 100 : null;
  const sPnlColor     = sessionPnlUsd == null ? 'grey-fg' : sessionPnlUsd >= 0 ? 'green-fg' : 'red-fg';
  const sPnlStr       = sessionPnlUsd == null ? ''
    : `${sessionPnlUsd >= 0 ? '+' : ''}${fmtUSD(sessionPnlUsd)} (${sessionPnlPct >= 0 ? '+' : ''}${sessionPnlPct.toFixed(2)}%)`;

  lines.push(divider);
  lines.push([
    padCol('{bold}TOTAL{/}',                 COL_W[0]),
    padCol('',                               COL_W[1]),
    padCol('',                               COL_W[2]),
    padCol(`{bold}${fmtUSD(totalValue)}{/}`, COL_W[3]),
    padCol('{bold}100%{/}',                  COL_W[4]),
    padCol('',                               COL_W[5]),
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

  // ── Watermark logo below the data rows ─────────────────────────────────────
  lines.push('');
  lines.push('');
  for (const l of LOGO_LINES) {
    const pad = ' '.repeat(Math.max(0, Math.floor((TABLE_W - l.length) / 2) - 1));
    lines.push('{grey-fg}' + pad + l + '{/}');
  }
  lines.push('{grey-fg}' + ' '.repeat(Math.max(0, Math.floor((TABLE_W - 13) / 2) - 1)) + 'S Y S T E M S{/}');
  const tagline = 'Autonomous DeFi Portfolio Agent · Solana';
  lines.push('{grey-fg}' + ' '.repeat(Math.max(0, Math.floor((TABLE_W - tagline.length) / 2) - 1)) + tagline + '{/}');

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
      const ch     = d.change24h ?? 0;
      const color  = ch >= 0 ? 'green' : 'red';
      const arrow  = ch >= 0 ? '▲' : '▼';
      const chStr  = `${ch >= 0 ? '+' : ''}${ch.toFixed(2)}%`;
      lines.push(
        ` {white-fg}{bold}${sym.padEnd(5)}{/}` +
        ` {white-fg}${fmtPrice(d.price).padEnd(12)}{/}` +
        ` {${color}-fg}${arrow} ${chStr}{/}`
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

  const execSummary = execTrades.length > 0
    ? (nDone > 0 ? `  {green-fg}✓ ${nDone} on-chain{/}` : '') +
      (nDry  > 0 ? `  {cyan-fg}~ ${nDry} dry run{/}` : '') +
      (nFail > 0 ? `  {red-fg}✗ ${nFail} failed{/}` : '')
    : execution?.status === 'throttled'             ? '  ⏸ throttled'
    : execution?.status === 'skipped_low_confidence' ? '  ⏸ low confidence'
    : '';

  const bypassTag = stopLossBypass  ? '  {red-fg}⚡ STOP-LOSS{/}'
                  : takeProfitBypass ? '  {green-fg}✓ TAKE-PROFIT{/}'
                  : '';
  const trigTag   = triggeredBy ? `  ↳ ${triggeredBy}` : '';

  // ── Build LEFT column lines ───────────────────────────────────────────────
  const L = [];
  const LW = 88; // left column visual width (separator at col 90)

  // Header
  L.push(
    `{bold}{${actionColor}}${(decision.action ?? '?').toUpperCase()}{/}` +
    `  ${bar} {bold}${conf}%{/}` +
    (blocked ? '  {red-fg}⛔ BLOCKED{/}' : '') +
    bypassTag + execSummary + trigTag
  );
  L.push('─'.repeat(LW));

  // Rationale clipped to LW
  const rat = decision.rationale ?? 'N/A';
  L.push(rat.length > LW ? rat.slice(0, LW - 1) + '…' : rat);
  L.push('');

  // Trade table
  const tradesToShow = execTrades.length > 0 ? execTrades : (decision.trades ?? []);
  if (tradesToShow.length > 0) {
    for (const t of tradesToShow) {
      const side = (t.type ?? '?').toUpperCase();
      const sign = t.type === 'buy' ? '+' : '−';
      const asset = (t.asset ?? '').padEnd(8);
      const amt   = (t.amountUsd != null ? fmtUSD(t.amountUsd) : '').padEnd(8);
      let icon, color, label;
      if      (t.status === 'executed') { icon = '✓'; color = 'green-fg';  label = 'on-chain'; }
      else if (t.status === 'dry_run')  { icon = '~'; color = 'cyan-fg';   label = 'dry run';  }
      else if (t.status === 'blocked')  { icon = '✗'; color = 'red-fg';    label = (t.reason ?? 'blocked').slice(0, 30); }
      else if (t.status === 'failed')   { icon = '⚠'; color = 'red-fg';    label = 'FAILED';   }
      else if (t.status === 'skipped')  { icon = '—'; color = 'white-fg';  label = 'skipped';  }
      else                              { icon = '·'; color = t.type === 'buy' ? 'green-fg' : 'red-fg'; label = 'proposed'; }
      L.push(`  {${color}}{bold}${icon}{/} {${color}}${sign} ${side.padEnd(5)} ${asset} ${amt}{/}${label}`);
    }
  } else {
    L.push('  · Holding — no trades');
  }
  L.push('');

  // All flags — no cap, no truncation
  const rawFlags = [
    ...(decision.riskFlags ?? []).filter(f =>
      !f.startsWith('BLOCKED') && !f.startsWith('TRIMMED') &&
      !f.startsWith('AUTO STOP') && !f.startsWith('AUTO-CONVERTED')
    ),
    ...violations.filter(v => !v.startsWith('TRIMMED')),
  ];
  const uniqueFlags = [...new Set(rawFlags)];
  for (const f of uniqueFlags) {
    const isCrit = f.startsWith('BLOCKED') || f.startsWith('HALT') || f.startsWith('STOP');
    const color  = isCrit ? 'red-fg' : 'yellow-fg';
    const icon   = isCrit ? '✗' : '⚠';
    const clip   = f.length > LW - 4 ? f.slice(0, LW - 5) + '…' : f;
    L.push(`  {${color}}${icon} ${clip}{/}`);
  }

  // Recent decisions
  localDecisionHistory.push({
    action: decision.action ?? '?', confidence: conf,
    timestamp: new Date(), triggeredBy: triggeredBy ?? 'manual',
  });
  if (localDecisionHistory.length > 6) localDecisionHistory.shift();

  L.push('');
  L.push('─'.repeat(LW));
  for (const entry of [...localDecisionHistory].reverse()) {
    const ac   = ACTION_COLOR[entry.action] ?? 'white-fg';
    const time = entry.timestamp.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    L.push(`  ${time}  {${ac}}{bold}${entry.action.toUpperCase().padEnd(9)}{/}  ${entry.confidence}%  ${(entry.triggeredBy ?? '').slice(0, 22)}`);
  }

  // ── Build RIGHT column lines — Market Analysis ────────────────────────────
  const R = [];
  const market    = lastMarketSnapshot ?? {};
  const portfolio = lastPortfolio;

  R.push('{bold}Market Analysis{/}');
  R.push('─'.repeat(50));

  // Holdings snapshot: symbol, 1h, 24h
  if (portfolio?.holdings?.length) {
    R.push('{bold}Holdings         1h         24h{/}');
    for (const h of portfolio.holdings.filter(h => h.symbol !== 'USDC' && !h.unpriced)) {
      const m    = market[h.symbol] ?? {};
      const h1   = m.change1h  != null ? `${m.change1h  >= 0 ? '+' : ''}${m.change1h.toFixed(2)}%`  : '  —  ';
      const h24  = m.change24h != null ? `${m.change24h >= 0 ? '+' : ''}${m.change24h.toFixed(2)}%` : '  —  ';
      const c1   = m.change1h  >= 0 ? 'green-fg' : 'red-fg';
      const c24  = m.change24h >= 0 ? 'green-fg' : 'red-fg';
      R.push(
        `  ${h.symbol.padEnd(8)}  {${c1}}${h1.padStart(7)}{/}    {${c24}}${h24.padStart(7)}{/}`
      );
    }
    R.push('');
  }

  // Top 1h movers from full market (not held)
  const heldSet = new Set((portfolio?.holdings ?? []).map(h => h.symbol));
  const movers = Object.entries(market)
    .filter(([sym, d]) => !heldSet.has(sym) && sym !== 'USDC' && d.change1h != null)
    .sort((a, b) => b[1].change1h - a[1].change1h)
    .slice(0, 5);

  if (movers.length > 0) {
    R.push('{bold}Top Movers (1h — not held){/}');
    for (const [sym, d] of movers) {
      const c = d.change1h >= 0 ? 'green-fg' : 'red-fg';
      const vol = d.volume24hUsd != null ? ` vol $${(d.volume24hUsd / 1e6).toFixed(0)}M` : '';
      R.push(`  {${c}}{bold}${sym.padEnd(9)}{/} {${c}}${d.change1h >= 0 ? '+' : ''}${d.change1h.toFixed(2)}%{/}${vol}`);
    }
    R.push('');
  }

  // Market health: up/down ratio across portfolio holdings
  if (portfolio?.holdings?.length) {
    const moves = portfolio.holdings
      .filter(h => h.symbol !== 'USDC' && !h.unpriced && market[h.symbol]?.change24h != null)
      .map(h => market[h.symbol].change24h);
    const up   = moves.filter(c => c > 0).length;
    const down = moves.filter(c => c < 0).length;
    const healthColor = up > down ? 'green-fg' : down > up ? 'red-fg' : 'yellow-fg';
    R.push(`{bold}Holdings Health{/}  {${healthColor}}${up} up / ${down} down{/} (24h)`);

    // Cash & drawdown
    const cashPct = portfolio.totalValueUsd > 0
      ? ((portfolio.cashUsd / portfolio.totalValueUsd) * 100).toFixed(1)
      : '0.0';
    const drawdown = portfolio.peakValueUsd > 0
      ? (((portfolio.peakValueUsd - portfolio.totalValueUsd) / portfolio.peakValueUsd) * 100).toFixed(2)
      : '0.00';
    R.push(`Cash  {white-fg}$${portfolio.cashUsd?.toFixed(2)} (${cashPct}%){/}    Draw  {white-fg}${drawdown}%{/}`);
  }

  // ── Zip left + right columns with │ separator ─────────────────────────────
  const SEP  = ' {white-fg}│{/} ';
  const rows  = Math.max(L.length, R.length);
  const lines = [];
  for (let i = 0; i < rows; i++) {
    const left  = L[i] ?? '';
    const right = R[i] ?? '';
    lines.push(padCol(left, LW) + SEP + right);
  }

  reasonBox.setContent(lines.join('\n'));
  reasonBox.setScrollPerc(0);

  // Record executed trades in session trade history
  if (execution?.trades) {
    for (const t of execution.trades) {
      if (t.status === 'executed' || t.status === 'dry_run') {
        tradeHistory.unshift({
          time:    new Date(),
          side:    t.side ?? t.type ?? '?',
          asset:   t.asset ?? '?',
          amountUsd: t.amountUsd ?? 0,
          status:  t.status,
          txid:    t.txid,
        });
      }
    }
    if (tradeHistory.length > 20) tradeHistory = tradeHistory.slice(0, 20);
  }

  // macOS notifications for significant events
  if (stopLossBypass) {
    notify('Mercer — Stop-Loss', `Mandatory exit triggered. Check dashboard.`);
  } else if (takeProfitBypass) {
    notify('Mercer — Take Profit', `Take-profit target reached. Partial exit executed.`);
  } else if (execution?.trades?.some(t => t.status === 'executed')) {
    const summary = execution.trades
      .filter(t => t.status === 'executed')
      .map(t => `${t.side?.toUpperCase() ?? '?'} ${t.asset ?? ''} ${fmtUSD(t.amountUsd ?? 0)}`)
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
        reasonBox.style.border.fg = 'blue';
        screen.render();
      }
    }, 200);
  }
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

  const mandateStr = mandate
    ? `{cyan-fg}${MANDATE_PRESET.toUpperCase()}{/} · max ${mandate.maxPositionPct}% · SL ${mandate.stopLossPct}%`
    : MANDATE_PRESET.toUpperCase();

  const walletTag = walletSource === 'live'
    ? '{green-fg}◈ LIVE{/}'
    : '{yellow-fg}◈ MOCK{/}';

  statusBox.setContent(
    `{grey-fg} [q]{/} Quit {grey-fg}[r]{/} Reason {grey-fg}[p]{/} Portfolio {grey-fg}[a]{/} Ask {grey-fg}[m]{/} Market {grey-fg}[c]{/} Chart {grey-fg}[h]{/} History {grey-fg}[1][4][0]{/} Window  {grey-fg}|{/}  ${walletTag}  ${mandateStr}  {grey-fg}|{/}  ${violStr}  {grey-fg}|{/}  ${msg}`
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
      reasonBox.setLabel(' Claude Decisions');
      screen.render();
    }
    return;
  }
  spinnerActive = true;
  spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
  const spin = SPINNER_FRAMES[spinnerFrame];
  tableBox.setLabel(` Portfolio Holdings  {cyan-fg}${spin}{/} `);
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
let sessionCycles        = 0;
let localDecisionHistory = [];
let liveHistory          = [];   // in-memory chart data, appended every data refresh
let lastPortfolio        = null; // last fetched portfolio, reused for chart ticks
let lastMaxMovement      = { symbol: null, pct: 0 };
let walletSource         = 'mock';   // 'live' | 'mock'
let adaptiveThreshold    = REASON_THRESHOLD;
let tradeHistory         = [];       // recent executed trades
let selectedMarketToken  = null;     // null = all-token ticker, string = detail view
let selectedChartSeries  = 'portfolio'; // 'portfolio' | token symbol
const tokenPriceHistory  = {};       // token → [{timestamp, price}]
let sessionBaseline      = null;     // first portfolio value this session — P&L anchor
let chartWindow          = 90;       // number of history points to show in chart

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
    // Show the most recent decision in the box immediately
    const last = hist[hist.length - 1];
    if (last) {
      const ts   = new Date(last.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
      const ac   = { hold:'yellow-fg', rebalance:'cyan-fg', buy:'green-fg', sell:'red-fg', alert:'magenta-fg' }[last.action] ?? 'white-fg';
      const conf = ((last.confidence ?? 0) * 100).toFixed(0);
      const rat  = (last.rationale ?? 'N/A');
      const ratClip = rat.length > 74 ? rat.slice(0, 72) + '…' : rat;
      reasonBox.setContent(
        `{bold}{${ac}}${(last.action ?? '?').toUpperCase()}{/}  ${confBar(parseFloat(conf))} {bold}${conf}%{/}  {white-fg}↳ ${ts} · persisted{/}\n` +
        `{white-fg}─────────────────────────────────────────────{/}\n` +
        `${ratClip}\n\n` +
        `{white-fg}Waiting for live data…{/}`
      );
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
    lastMarketSnapshot = market;
    updatePortfolioTable(portfolio, market);
    updateMarketBox(selectedMarketToken, market);

    const mandates = await fetchJSON(`${API_BASE}/mandates`);
    lastMandate    = mandates[MANDATE_PRESET];

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
        const sc   = t.side === 'buy' ? 'green-fg' : 'red-fg';
        const sign = t.side === 'buy' ? '+' : '−';
        lines.push(
          `{grey-fg}${time}{/}  {${sc}}${sign} ${t.side.toUpperCase().padEnd(4)}  ${(t.asset ?? '?').padEnd(6)}  ${fmtUSD(t.amountUsd ?? 0).padEnd(12)}  ${t.status}{/}`
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

screen.key(['q', 'C-c'],  () => { confirmQuit(); });
screen.key(['r'],          () => { doRefresh(true); });
screen.key(['p'],          () => { doDataRefresh(); });
screen.key(['a'],          () => { openAskTerminal(); });
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

    // Track per-token price history for individual token charts
    const now = new Date().toISOString();
    for (const [sym, data] of Object.entries(market)) {
      if (!tokenPriceHistory[sym]) tokenPriceHistory[sym] = [];
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
  doRefresh(true);
});
