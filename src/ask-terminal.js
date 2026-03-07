// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — ask-terminal.js
// Ask Mercer — minimal terminal interface, native background
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

// ─── Header bar ───────────────────────────────────────────────────────────────

blessed.box({
  parent:  screen,
  top: 0, left: 0, width: '100%', height: 1,
  content: ' ▓▓  MERCER SYSTEMS  ◈  Ask Mercer  ◈  Powered by Claude  ▓▓',
  tags:    true,
  align:   'center',
  style:   { fg: 'black', bg: 'cyan', bold: true },
});

// ─── Conversation panel — left 64% ────────────────────────────────────────────

const historyBox = blessed.box({
  parent:       screen,
  top: 1, left: 0, width: '64%', bottom: 3,
  tags:         true,
  scrollable:   true,
  alwaysScroll: true,
  mouse:        true,
  keys:         false,
  padding:      { top: 1, left: 2, right: 1 },
  content:      'Ask Mercer anything about your portfolio, market, or strategy.',
});

// ─── Vertical separator ────────────────────────────────────────────────────────

const vSep = blessed.box({
  parent: screen,
  top: 1, left: '64%', width: 1, bottom: 3,
  tags: true,
});

function renderSep() {
  vSep.setContent(Array(screen.height).fill('│').join('\n'));
}

// ─── Context panel — right 35% ────────────────────────────────────────────────

const contextBox = blessed.box({
  parent:  screen,
  top: 1, left: '65%', width: '35%', bottom: 3,
  tags:    true,
  padding: { top: 1, left: 2, right: 1 },
  content: 'connecting...',
});

// ─── Input separator ─────────────────────────────────────────────────────────

const inputSepBox = blessed.box({
  parent: screen,
  bottom: 2, left: 0, width: '100%', height: 1,
  tags:   true,
});

function renderInputSep() {
  inputSepBox.setContent('─'.repeat(screen.width || 120));
}

// ─── Prompt + input ───────────────────────────────────────────────────────────

blessed.box({
  parent:  screen,
  bottom:  1, left: 0, width: 2, height: 1,
  content: '›',
});

const inputBox = blessed.textbox({
  parent:       screen,
  bottom:       1, left: 2, width: '100%-2', height: 1,
  inputOnFocus: true,
});

// ─── Status bar ───────────────────────────────────────────────────────────────

const statusBar = blessed.box({
  parent: screen,
  bottom: 0, left: 0, width: '100%', height: 1,
  tags:   true,
});

const HINTS = '[enter] send  [↑↓] scroll/history  [ctrl+l] clear  [q] quit    ';

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

// ─── Text wrap ────────────────────────────────────────────────────────────────

function wrapText(text, maxW) {
  const result = [];
  for (const para of text.split('\n')) {
    if (!para.trim()) { result.push(''); continue; }
    const words = para.split(' ');
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
  const panelW = Math.floor((screen.width || 120) * 0.64);
  const maxW   = Math.max(30, panelW - 6);

  for (let i = 0; i < history.length; i++) {
    const entry  = history[i];
    const time   = entry.time.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    const isUser = entry.role === 'user';

    if (isUser) {
      lines.push(`${time}  you`);
      for (const l of wrapText(entry.text, maxW)) lines.push(`  ${l}`);
    } else {
      lines.push(`${time}  mercer`);
      for (const l of wrapText(entry.text, maxW)) lines.push(`  ${l}`);
      if (i < history.length - 1) lines.push('');
    }
    lines.push('');
  }

  historyBox.setContent(lines.join('\n'));
  historyBox.setScrollPerc(100);
  screen.render();
}

// ─── Context panel ────────────────────────────────────────────────────────────

async function refreshContext() {
  try {
    const [pRes, mRes] = await Promise.all([
      fetch(`${API_BASE}/portfolio`).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(`${API_BASE}/market`).then(r => r.ok ? r.json() : null).catch(() => null),
    ]);

    const lines = [];

    if (pRes) {
      const total = pRes.totalValue ?? pRes.totalValueUsd ?? 0;
      const src   = pRes.source === 'live' ? 'live' : 'mock';
      lines.push(`portfolio  ${src}`);
      lines.push(`$${total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
      lines.push('');

      for (const h of (pRes.holdings ?? []).filter(h => h.symbol !== 'SOL').slice(0, 6)) {
        const sym = (h.symbol ?? '?').padEnd(6);
        const val = h.valueUsd != null ? `$${h.valueUsd.toFixed(2)}` : '';
        const pnl = h.pnlPct  != null
          ? `${h.pnlPct >= 0 ? '+' : ''}${h.pnlPct.toFixed(1)}%`
          : '';
        lines.push(`${sym}  ${val.padEnd(9)}  ${pnl}`);
      }
      lines.push('');
    }

    if (mRes) {
      const sol = mRes['SOL'];
      if (sol) {
        const s1h  = sol.change1h  ?? 0;
        const s24h = sol.change24h ?? 0;
        const s7d  = sol.change7d  ?? null;

        let regime;
        if      (s7d > 15  && s24h > 0)  regime = 'bull run';
        else if (s7d > 5   && s24h >= 0) regime = 'recovery';
        else if (s7d > 5   && s24h < -3) regime = 'pullback';
        else if (s7d < -20)              regime = 'bear';
        else if (s7d < -8)               regime = 'correction';
        else if (s7d != null && Math.abs(s7d) <= 5 && Math.abs(s24h) > 4) regime = 'volatile';
        else if (s7d != null)            regime = 'consolidation';
        else                             regime = s1h > 2 ? 'risk-on' : s1h < -2 ? 'risk-off' : 'neutral';

        lines.push(`market  ${regime}`);
        lines.push(`sol  $${sol.price?.toFixed(2) ?? '?'}  ${s1h >= 0 ? '+' : ''}${s1h.toFixed(2)}% 1h`);
        lines.push('');
      }

      const movers = Object.entries(mRes)
        .filter(([sym, d]) => sym !== 'SOL' && sym !== 'USDC' && d.change1h != null)
        .sort((a, b) => b[1].change1h - a[1].change1h)
        .slice(0, 6);

      if (movers.length > 0) {
        lines.push('top movers 1h');
        for (const [sym, d] of movers) {
          const ch = `${d.change1h >= 0 ? '+' : ''}${d.change1h.toFixed(1)}%`;
          const mc = d.marketCapUsd != null ? `  $${(d.marketCapUsd / 1e6).toFixed(0)}M` : '';
          lines.push(`${sym.padEnd(7)}  ${ch}${mc}`);
        }
      }
    }

    contextBox.setContent(lines.length > 0 ? lines.join('\n') : 'no data');
    screen.render();
  } catch {
    contextBox.setContent('unavailable');
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
    setStatus(`${FRAMES[spinnerFrame]}  thinking...`);
  }, 120);
}

function stopSpinner() {
  waiting = false;
  if (spinnerTimer) { clearInterval(spinnerTimer); spinnerTimer = null; }
}

// ─── History helpers ──────────────────────────────────────────────────────────

function appendHistory(role, text) {
  history.push({ role, text, time: new Date() });
  if (role === 'user') { inputHistoryArr.push(text); inputHistoryIdx = -1; }
  saveHistory(history.map(e => ({ ...e, time: e.time.toISOString() })));
  renderHistory();
}

function clearConversation() {
  history.length = 0;
  inputHistoryArr = [];
  inputHistoryIdx = -1;
  saveHistory([]);
  historyBox.setContent('conversation cleared.');
  screen.render();
  setStatus('ready');
}

// ─── API call ─────────────────────────────────────────────────────────────────

async function askMercer(question) {
  startSpinner();
  try {
    const conversationHistory = history.slice(0, -1).map(e => ({ role: e.role, content: e.text }));
    const res = await fetch(`${API_BASE}/ask`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ question, history: conversationHistory }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    stopSpinner();
    appendHistory('mercer', data.answer ?? 'no response.');
    setStatus('ready');
  } catch (err) {
    stopSpinner();
    appendHistory('mercer', `error: ${err.message}`);
    setStatus(err.message);
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

screen.key(['C-l'], () => {
  if (waiting || confirmingClear || history.length === 0) return;
  confirmingClear = true;
  setStatus('clear conversation? [y] yes  [n] no');
});

screen.key(['y'], () => {
  if (!confirmingClear) return;
  confirmingClear = false;
  clearConversation();
});

screen.key(['n'], () => {
  if (!confirmingClear) return;
  confirmingClear = false;
  setStatus('ready');
});

screen.key(['q', 'C-c'], () => {
  if (confirmingClear) { confirmingClear = false; setStatus('ready'); return; }
  screen.destroy();
  process.exit(0);
});

screen.key(['up'], () => {
  if (confirmingClear) return;
  if (screen.focused === inputBox) {
    if (!inputHistoryArr.length) return;
    inputHistoryIdx = Math.min(inputHistoryIdx + 1, inputHistoryArr.length - 1);
    inputBox.setValue(inputHistoryArr[inputHistoryArr.length - 1 - inputHistoryIdx]);
    screen.render();
  } else { historyBox.scroll(-1); screen.render(); }
});

screen.key(['down'], () => {
  if (confirmingClear) return;
  if (screen.focused === inputBox) {
    if (inputHistoryIdx <= 0) { inputHistoryIdx = -1; inputBox.clearValue(); }
    else { inputHistoryIdx--; inputBox.setValue(inputHistoryArr[inputHistoryArr.length - 1 - inputHistoryIdx]); }
    screen.render();
  } else { historyBox.scroll(1); screen.render(); }
});

screen.key(['pageup'],   () => { historyBox.scroll(-Math.floor((screen.height - 5) / 2)); screen.render(); });
screen.key(['pagedown'], () => { historyBox.scroll( Math.floor((screen.height - 5) / 2)); screen.render(); });

screen.on('resize', () => { renderSep(); renderInputSep(); screen.render(); });

// ─── Boot ─────────────────────────────────────────────────────────────────────

inputBox.focus();
renderSep();
renderInputSep();
if (history.length > 0) renderHistory();
setStatus('ready');
refreshContext();
setInterval(refreshContext, 30_000);
screen.render();
