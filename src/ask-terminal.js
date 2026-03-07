// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — ask-terminal.js
// Standalone Ask Mercer terminal — two-panel layout with live context
// Run directly: node src/ask-terminal.js
// Or opened automatically when pressing [a] in the dashboard.
// ─────────────────────────────────────────────────────────────────────────────

import 'dotenv/config';
import blessed from 'blessed';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const API_BASE  = 'http://localhost:3000';
const __dirname = dirname(fileURLToPath(import.meta.url));
const HIST_FILE = join(__dirname, '..', 'data', 'ask-history.json');

// ─── Persist ──────────────────────────────────────────────────────────────────

function loadHistory() {
  try { return JSON.parse(readFileSync(HIST_FILE, 'utf8')); } catch { return []; }
}

function saveHistory(h) {
  try {
    mkdirSync(join(__dirname, '..', 'data'), { recursive: true });
    writeFileSync(HIST_FILE, JSON.stringify(h.slice(-100)));
  } catch { /* silent */ }
}

// ─── Screen ───────────────────────────────────────────────────────────────────

const screen = blessed.screen({ smartCSR: true, title: 'Mercer — Ask' });

// ─── Header ───────────────────────────────────────────────────────────────────

blessed.box({
  parent:  screen,
  top:     0,
  left:    0,
  width:   '100%',
  height:  1,
  content: ' ▓▓  MERCER SYSTEMS  ◈  Ask Mercer  ◈  Powered by Claude  ▓▓',
  tags:    true,
  align:   'center',
  style:   { fg: 'black', bg: 'cyan', bold: true },
});

// ─── Conversation panel (left 65%) ────────────────────────────────────────────

const historyBox = blessed.box({
  parent:       screen,
  top:          1,
  left:         0,
  width:        '65%',
  bottom:       4,
  tags:         true,
  scrollable:   true,
  alwaysScroll: true,
  mouse:        true,
  keys:         false,
  border:       { type: 'line', fg: 'cyan' },
  label:        ' Conversation ',
  scrollbar:    { ch: '│', style: { fg: 'cyan' } },
  padding:      { top: 0, left: 1, right: 1 },
  style:        { fg: 'white', bg: 'black', border: { fg: 'cyan' } },
  content:      '\n  {grey-fg}Ask Mercer anything about your portfolio,{/}\n  {grey-fg}market conditions, or strategy.{/}',
});

// ─── Live context panel (right 35%) ───────────────────────────────────────────

const contextBox = blessed.box({
  parent:  screen,
  top:     1,
  left:    '65%',
  width:   '35%',
  bottom:  4,
  tags:    true,
  border:  { type: 'line', fg: 'cyan' },
  label:   ' Live Context ',
  padding: { top: 0, left: 1, right: 1 },
  style:   { fg: 'white', bg: 'black', border: { fg: 'cyan' } },
  content: '{grey-fg}Connecting...{/}',
});

// ─── Input box ────────────────────────────────────────────────────────────────

const inputBox = blessed.textbox({
  parent:       screen,
  bottom:       1,
  left:         0,
  width:        '100%',
  height:       3,
  inputOnFocus: true,
  border:       { type: 'line', fg: 'grey' },
  label:        ' Your Question ',
  style:        { fg: 'white', bg: 'black', border: { fg: 'grey' }, focus: { border: { fg: 'cyan' } } },
  padding:      { left: 1 },
});

// ─── Status bar ───────────────────────────────────────────────────────────────

const statusBar = blessed.box({
  parent:  screen,
  bottom:  0,
  left:    0,
  width:   '100%',
  height:  1,
  tags:    true,
  style:   { fg: 'white', bg: 'black' },
});

const HINTS = ' {grey-fg}[Enter]{/} Send  {grey-fg}[↑↓]{/} Scroll/History  {grey-fg}[c]{/} Clear  {grey-fg}[q]{/} Quit  {grey-fg}|{/}  ';

function setStatus(msg) {
  statusBar.setContent(HINTS + msg);
  screen.render();
}

// ─── State ────────────────────────────────────────────────────────────────────

const history       = loadHistory().map(e => ({ ...e, time: new Date(e.time) }));
let inputHistoryArr = history.filter(e => e.role === 'user').map(e => e.text);
let inputHistoryIdx = -1;
let waiting         = false;
let confirmingClear = false;
let spinnerTimer    = null;
let spinnerFrame    = 0;

// ─── Text helpers ─────────────────────────────────────────────────────────────

function wrapText(text, maxW) {
  const result = [];
  for (const paragraph of text.split('\n')) {
    if (!paragraph.trim()) { result.push(''); continue; }
    const words = paragraph.split(' ');
    let line = '';
    for (const word of words) {
      if (line.length + word.length + 1 > maxW && line.trim()) {
        result.push(line.trimEnd());
        line = word + ' ';
      } else {
        line += word + ' ';
      }
    }
    if (line.trim()) result.push(line.trimEnd());
  }
  return result;
}

// ─── Conversation renderer ────────────────────────────────────────────────────

function renderHistory() {
  const lines = [];
  const panelW = Math.floor((screen.width || 120) * 0.65);
  const maxW   = Math.max(30, panelW - 8);

  for (let i = 0; i < history.length; i++) {
    const entry  = history[i];
    const time   = entry.time.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    const isUser = entry.role === 'user';

    if (isUser) {
      lines.push(`{grey-fg}${time}{/}  {cyan-fg}{bold}› You{/}`);
      for (const line of wrapText(entry.text, maxW)) {
        lines.push(`  {cyan-fg}${line}{/}`);
      }
    } else {
      lines.push(`{grey-fg}${time}{/}  {green-fg}{bold}◈ Mercer{/}`);
      for (const line of wrapText(entry.text, maxW)) {
        lines.push(`  ${line}`);
      }
      if (i < history.length - 1) {
        lines.push(`  {grey-fg}${'─'.repeat(Math.min(maxW, 40))}{/}`);
      }
    }
    lines.push('');
  }

  historyBox.setContent(lines.join('\n') + '\n');
  historyBox.setScrollPerc(100);
  screen.render();
}

// ─── Live context panel ───────────────────────────────────────────────────────

async function refreshContext() {
  try {
    const [pRes, mRes] = await Promise.all([
      fetch(`${API_BASE}/portfolio`).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(`${API_BASE}/market`).then(r => r.ok ? r.json() : null).catch(() => null),
    ]);

    const lines = [];

    if (pRes) {
      const total = pRes.totalValue ?? pRes.totalValueUsd ?? 0;
      const src   = pRes.source === 'live' ? '{green-fg}◈ LIVE{/}' : '{yellow-fg}◈ MOCK{/}';
      lines.push(`{bold}PORTFOLIO{/}  ${src}`);
      lines.push('{grey-fg}─────────────────────{/}');
      lines.push(`{bold}$${total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}{/}`);
      lines.push('');

      const holdings = (pRes.holdings ?? []).filter(h => h.symbol !== 'SOL');
      for (const h of holdings.slice(0, 7)) {
        const sym = (h.symbol ?? '?').padEnd(6);
        const val = h.valueUsd != null ? `$${h.valueUsd.toFixed(2)}`.padEnd(9) : ''.padEnd(9);
        const pnl = h.pnlPct  != null
          ? h.pnlPct >= 0
            ? `{green-fg}+${h.pnlPct.toFixed(1)}%{/}`
            : `{red-fg}${h.pnlPct.toFixed(1)}%{/}`
          : '';
        lines.push(`${sym} ${val} ${pnl}`);
      }
      lines.push('');
    }

    if (mRes) {
      const sol  = mRes['SOL'];
      if (sol) {
        const s1h  = sol.change1h  ?? 0;
        const s24h = sol.change24h ?? 0;
        const s7d  = sol.change7d  ?? null;

        let regime;
        if      (s7d > 15  && s24h > 0)  regime = '{green-fg}BULL RUN{/}';
        else if (s7d > 5   && s24h >= 0) regime = '{green-fg}RECOVERY{/}';
        else if (s7d > 5   && s24h < -3) regime = '{yellow-fg}PULLBACK{/}';
        else if (s7d < -20)              regime = '{red-fg}BEAR{/}';
        else if (s7d < -8)               regime = '{red-fg}CORRECTION{/}';
        else if (s7d != null && Math.abs(s7d) <= 5 && Math.abs(s24h) > 4) regime = '{yellow-fg}VOLATILE{/}';
        else if (s7d != null)            regime = '{white-fg}CONSOLIDATION{/}';
        else                             regime = s1h > 2 ? '{green-fg}RISK-ON{/}' : s1h < -2 ? '{red-fg}RISK-OFF{/}' : '{white-fg}NEUTRAL{/}';

        const solPriceStr = sol.price != null ? `$${sol.price.toFixed(2)}` : '?';
        const sol1hStr    = `${s1h >= 0 ? '{green-fg}+' : '{red-fg}'}${s1h.toFixed(2)}%{/}`;
        lines.push('{bold}MARKET{/}');
        lines.push('{grey-fg}─────────────────────{/}');
        lines.push(`Regime  ${regime}`);
        lines.push(`SOL  ${solPriceStr}  ${sol1hStr} 1h`);
        lines.push('');
      }

      // Top movers by 1h (not SOL, not USDC)
      const movers = Object.entries(mRes)
        .filter(([sym, d]) => sym !== 'SOL' && sym !== 'USDC' && d.change1h != null)
        .sort((a, b) => b[1].change1h - a[1].change1h)
        .slice(0, 6);

      if (movers.length > 0) {
        lines.push('{bold}TOP MOVERS (1H){/}');
        lines.push('{grey-fg}─────────────────────{/}');
        for (const [sym, d] of movers) {
          const ch = d.change1h >= 0
            ? `{green-fg}+${d.change1h.toFixed(1)}%{/}`
            : `{red-fg}${d.change1h.toFixed(1)}%{/}`;
          const mc = d.marketCapUsd != null
            ? `{grey-fg} $${(d.marketCapUsd / 1e6).toFixed(0)}M{/}`
            : '';
          lines.push(`${sym.padEnd(7)} ${ch}${mc}`);
        }
      }
    }

    contextBox.setContent(lines.length > 0 ? lines.join('\n') : '{grey-fg}No data{/}');
    screen.render();
  } catch {
    contextBox.setContent('{grey-fg}Context unavailable{/}');
    screen.render();
  }
}

// ─── Spinner ──────────────────────────────────────────────────────────────────

const FRAMES = ['◐', '◓', '◑', '◒'];

function startSpinner() {
  waiting = true;
  spinnerFrame = 0;
  spinnerTimer = setInterval(() => {
    spinnerFrame = (spinnerFrame + 1) % FRAMES.length;
    setStatus(`{yellow-fg}${FRAMES[spinnerFrame]}  Mercer is thinking...{/}`);
  }, 120);
}

function stopSpinner() {
  waiting = false;
  if (spinnerTimer) { clearInterval(spinnerTimer); spinnerTimer = null; }
}

// ─── History helpers ──────────────────────────────────────────────────────────

function appendHistory(role, text) {
  history.push({ role, text, time: new Date() });
  if (role === 'user') {
    inputHistoryArr.push(text);
    inputHistoryIdx = -1;
  }
  saveHistory(history.map(e => ({ ...e, time: e.time.toISOString() })));
  renderHistory();
}

function clearConversation() {
  history.length = 0;
  inputHistoryArr = [];
  inputHistoryIdx = -1;
  saveHistory([]);
  historyBox.setContent('\n  {grey-fg}Conversation cleared.{/}');
  screen.render();
  setStatus('{green-fg}Ready{/}');
}

// ─── API call ─────────────────────────────────────────────────────────────────

async function askMercer(question) {
  startSpinner();
  try {
    const conversationHistory = history.slice(0, -1).map(e => ({
      role:    e.role,
      content: e.text,
    }));

    const res = await fetch(`${API_BASE}/ask`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ question, history: conversationHistory }),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    stopSpinner();
    appendHistory('mercer', data.answer ?? 'No response.');
    setStatus('{green-fg}Ready{/}');
  } catch (err) {
    stopSpinner();
    appendHistory('mercer', `Error contacting server: ${err.message}`);
    setStatus(`{red-fg}${err.message}{/}`);
  }
  inputBox.focus();
  screen.render();
}

// ─── Key bindings ─────────────────────────────────────────────────────────────

inputBox.key(['enter'], async () => {
  if (waiting || confirmingClear) return;
  const question = inputBox.getValue().trim();
  if (!question) return;
  inputBox.clearValue();
  inputHistoryIdx = -1;
  screen.render();
  appendHistory('user', question);
  await askMercer(question);
});

// [c] — clear with confirmation
screen.key(['c'], () => {
  if (waiting || screen.focused !== inputBox || confirmingClear) return;
  if (history.length === 0) return;
  confirmingClear = true;
  setStatus('{yellow-fg}Clear conversation? [y] Yes  [n] No{/}');
});

screen.key(['y'], () => {
  if (!confirmingClear) return;
  confirmingClear = false;
  clearConversation();
});

screen.key(['n'], () => {
  if (!confirmingClear) return;
  confirmingClear = false;
  setStatus('{green-fg}Ready{/}');
});

screen.key(['q', 'C-c'], () => {
  if (confirmingClear) { confirmingClear = false; setStatus('{green-fg}Ready{/}'); return; }
  screen.destroy();
  process.exit(0);
});

// Up/down — history nav when input focused, scroll conversation otherwise
screen.key(['up'], () => {
  if (confirmingClear) return;
  if (screen.focused === inputBox) {
    if (inputHistoryArr.length === 0) return;
    inputHistoryIdx = Math.min(inputHistoryIdx + 1, inputHistoryArr.length - 1);
    inputBox.setValue(inputHistoryArr[inputHistoryArr.length - 1 - inputHistoryIdx]);
    screen.render();
  } else {
    historyBox.scroll(-1); screen.render();
  }
});

screen.key(['down'], () => {
  if (confirmingClear) return;
  if (screen.focused === inputBox) {
    if (inputHistoryIdx <= 0) {
      inputHistoryIdx = -1;
      inputBox.clearValue();
    } else {
      inputHistoryIdx--;
      inputBox.setValue(inputHistoryArr[inputHistoryArr.length - 1 - inputHistoryIdx]);
    }
    screen.render();
  } else {
    historyBox.scroll(1); screen.render();
  }
});

screen.key(['pageup'],   () => { historyBox.scroll(-Math.floor((screen.height - 6) / 2)); screen.render(); });
screen.key(['pagedown'], () => { historyBox.scroll( Math.floor((screen.height - 6) / 2)); screen.render(); });

// ─── Boot ─────────────────────────────────────────────────────────────────────

inputBox.focus();
if (history.length > 0) renderHistory();
setStatus('{green-fg}Ready{/}');
refreshContext();
setInterval(refreshContext, 30_000);
screen.render();
