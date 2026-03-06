// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — dashboard.js
// Terminal dashboard powered by blessed-contrib
// Auto-refreshes every 900s — connects to Express API on port 3000
// ─────────────────────────────────────────────────────────────────────────────

import 'dotenv/config';
import blessed from 'blessed';
import contrib from 'blessed-contrib';

const API_BASE       = 'http://localhost:3000';
const REFRESH_MS     = 900_000;
const MANDATE_PRESET = process.env.MERCER_MANDATE ?? 'moderate';

// ─── Logo ─────────────────────────────────────────────────────────────────────
// Smoothed version — pure box-drawing, no mixed block/line chars on left edge

const LOGO_LINES = [
  '███╗   ███╗███████╗██████╗  ██████╗███████╗██████╗',
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
  label:   ' SOL / USD ',
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
  label:        ' Latest Claude Decision ',
  tags:         true,
  keys:         true,
  vi:           true,
  border:       { type: 'line', fg: 'cyan' },
  padding:      { top: 0, left: 2 },
  scrollable:   true,
  alwaysScroll: true,
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

// Visible length of a string (strips blessed tags)
function visLen(s) {
  return s.replace(/\{[^}]+\}/g, '').length;
}

// Right-pad a (possibly tag-containing) string to a fixed visible width
function padCol(s, width) {
  return s + ' '.repeat(Math.max(0, width - visLen(s)));
}

// ─── Table + watermark renderer ───────────────────────────────────────────────

const COL_W   = [7, 16, 12, 14, 8];
const COL_SEP = '  ';
const TABLE_W = COL_W.reduce((a, b) => a + b, 0) + COL_SEP.length * (COL_W.length - 1); // ~65

function renderTable(portfolio, market = {}) {
  const { holdings, totalValue } = portfolio;

  const divider = COL_W.map(w => '─'.repeat(w)).join(COL_SEP);

  const headers = [
    '{cyan-fg}{bold}Token{/}',
    '{cyan-fg}{bold}Balance{/}',
    '{cyan-fg}{bold}Price{/}',
    '{cyan-fg}{bold}Value{/}',
    '{cyan-fg}{bold}% Port{/}',
  ];

  const lines = [
    headers.map((h, i) => padCol(h, COL_W[i])).join(COL_SEP),
    divider,
  ];

  for (const h of holdings) {
    const ch    = market[h.token]?.change24h ?? 0;
    const color = ch >= 0 ? 'green-fg' : 'red-fg';
    const row   = [
      '{white-fg}' + h.token + '{/}',
      '{white-fg}' + fmtQty(h.balance) + '{/}',
      '{white-fg}' + fmtPrice(h.price) + '{/}',
      `{${color}}${fmtUSD(h.value)}{/}`,
      '{white-fg}' + ((h.value / totalValue) * 100).toFixed(1) + '%{/}',
    ];
    lines.push(row.map((cell, i) => padCol(cell, COL_W[i])).join(COL_SEP));
  }

  lines.push(divider);
  lines.push([
    padCol('{bold}TOTAL{/}',                 COL_W[0]),
    padCol('',                               COL_W[1]),
    padCol('',                               COL_W[2]),
    padCol(`{bold}${fmtUSD(totalValue)}{/}`, COL_W[3]),
    padCol('{bold}100%{/}',                  COL_W[4]),
  ].join(COL_SEP));

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

// ─── Display updaters ─────────────────────────────────────────────────────────

function updatePortfolioTable(portfolio, market = {}) {
  tableBox.setContent(renderTable(portfolio, market));
}

function updateSOLPrice(market) {
  const sol = market.SOL;
  if (!sol) {
    solBox.setContent('{red-fg}SOL data unavailable{/}');
    return;
  }
  const ch      = sol.change24h ?? 0;
  const chColor = ch >= 0 ? 'green-fg' : 'red-fg';
  const chSign  = ch >= 0 ? '+' : '';
  const vol     = sol.volume24hUsd ? '$' + (sol.volume24hUsd / 1e9).toFixed(2) + 'B' : 'N/A';

  solBox.setContent(
    ` {bold}{white-fg}${fmtPrice(sol.price)}{/}\n\n` +
    ` {${chColor}}24h  ${chSign}${ch.toFixed(2)}%{/}\n\n` +
    ` {grey-fg}Vol  ${vol}{/}`
  );
}

function updatePnlChart(history) {
  if (history.length < 2) {
    pnlChart.setLabel(' Portfolio P&L — awaiting data ');
    pnlChart.setData([{ title: '', x: [' '], y: [0] }]);
    return;
  }

  const win    = history.slice(-24);
  const first  = win[0].totalValueUsd;
  const last   = win[win.length - 1].totalValueUsd;
  const pnlUsd = last - first;
  const pnlPct = (pnlUsd / first) * 100;
  const sign   = pnlUsd >= 0 ? '+' : '';

  pnlChart.setLabel(` P&L  ${sign}${fmtUSD(pnlUsd)} (${sign}${pnlPct.toFixed(1)}%) `);
  pnlChart.setData([{
    title: 'Value',
    x: win.map(s => hhmm(s.timestamp)),
    y: win.map(s => s.totalValueUsd),
    style: { line: pnlUsd >= 0 ? 'green' : 'red' },
  }]);
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
    lines.push('', '{grey-fg}No trades proposed.{/}');
  }

  if (decision.riskFlags?.length > 0) {
    lines.push('', '{yellow-fg}Risk Flags:{/}');
    for (const f of decision.riskFlags) lines.push(`  {yellow-fg}⚠ ${f}{/}`);
  }

  if (violations.length > 0) {
    lines.push('', '{red-fg}Mandate Enforcements:{/}');
    for (const v of violations) lines.push(`  {red-fg}✗ ${v}{/}`);
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

function setStatus(mandate, violations, blocked, msg) {
  const violStr = blocked
    ? '{red-fg}⛔ BLOCKED{/}'
    : violations?.length
      ? `{red-fg}⚠ ${violations.length} violation(s){/}`
      : '{green-fg}✓ passed{/}';

  const mandateStr = mandate
    ? `{cyan-fg}${MANDATE_PRESET.toUpperCase()}{/} · max ${mandate.maxPositionPct}% · SL ${mandate.stopLossPct}%`
    : MANDATE_PRESET.toUpperCase();

  statusBox.setContent(
    ` {cyan-fg}[q]{/} Quit  {cyan-fg}[r]{/} Refresh  |  ${mandateStr}  |  ${violStr}  |  ${msg}`
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

    // Slide + fade simultaneously — 28 frames × 55ms ≈ 1.5s total
    // No resize: width/height stay fixed so logo never clips
    const FRAMES = 28;
    const DELAY  = 55;
    const fadeAt = 14; // frame at which fade starts (halfway through slide)
    const fadeColors = ['cyan','cyan','blue','blue','grey','grey','grey','black','black','black','black','black','black','black'];

    let frame = 0;
    let fi    = 0;

    const tick = setInterval(() => {
      const t    = Math.min(frame / (FRAMES - 1), 1);
      const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;

      // Slide only — no width/height change
      splash.top  = lerp(startTop,  endTop,  ease);
      splash.left = lerp(startLeft, endLeft, ease);

      // Fade starts halfway through
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

  screen.once('keypress', startTransition);
  setTimeout(startTransition, 3500);
}

// ─── Refresh cycle ────────────────────────────────────────────────────────────

let isRefreshing   = false;
let lastUpdatedAt  = null;
let nextRefreshAt  = null;
let lastMandate    = null;
let lastViolations = [];
let lastBlocked    = false;

async function doRefresh() {
  if (isRefreshing) return;
  isRefreshing  = true;
  nextRefreshAt = Date.now() + REFRESH_MS;

  setStatus(lastMandate, lastViolations, lastBlocked, '{yellow-fg}Fetching...{/}');
  screen.render();

  try {
    const portfolio = await fetchJSON(`${API_BASE}/portfolio`);
    const market    = await fetchJSON(`${API_BASE}/market`);

    updatePortfolioTable(portfolio, market);
    updateSOLPrice(market);
    screen.render();

    const mandates = await fetchJSON(`${API_BASE}/mandates`);
    lastMandate    = mandates[MANDATE_PRESET];

    const history  = await fetchJSON(`${API_BASE}/portfolio/history`);
    updatePnlChart(history);
    screen.render();

    lastUpdatedAt = new Date();
    setStatus(
      lastMandate, lastViolations, lastBlocked,
      `{green-fg}Updated: ${lastUpdatedAt.toLocaleTimeString()}{/}  Next in {cyan-fg}${fmtCountdown(Math.round(REFRESH_MS / 1000))}{/}`
    );
  } catch (err) {
    const msg = err.message.replace(/[{}]/g, '');
    setStatus(lastMandate, lastViolations, lastBlocked, `{red-fg}Error: ${msg}{/}`);
  } finally {
    isRefreshing = false;
    screen.render();
  }
}

// Countdown tick
setInterval(() => {
  if (isRefreshing || !nextRefreshAt || !lastUpdatedAt) return;
  const secsLeft = Math.max(0, Math.round((nextRefreshAt - Date.now()) / 1000));
  setStatus(
    lastMandate, lastViolations, lastBlocked,
    `{green-fg}Updated: ${lastUpdatedAt.toLocaleTimeString()}{/}  Next in {cyan-fg}${fmtCountdown(secsLeft)}{/}`
  );
  screen.render();
}, 1_000);

// ─── Key bindings ─────────────────────────────────────────────────────────────

screen.key(['q', 'C-c'], () => { screen.destroy(); process.exit(0); });
screen.key(['r'], doRefresh);

// ─── Boot ─────────────────────────────────────────────────────────────────────

screen.render();
showSplash(() => {
  doRefresh();
  setInterval(doRefresh, REFRESH_MS);
});
