// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — ask-terminal.js
// Standalone Ask Mercer terminal — same aesthetic as the main dashboard.
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
  content: ' ▓▓  MERCER SYSTEMS  ◈  Ask Mercer  ▓▓',
  tags:    true,
  align:   'center',
  style:   { fg: 'black', bg: 'cyan', bold: true },
});

// ─── Conversation history ─────────────────────────────────────────────────────

const historyBox = blessed.box({
  top:          1,
  left:         0,
  width:        '100%',
  bottom:       5,
  tags:         true,
  scrollable:   true,
  alwaysScroll: true,
  mouse:        true,
  keys:         true,
  vi:           true,
  border:       { type: 'line', fg: 'cyan' },
  label:        ' Conversation ',
  scrollbar:    { ch: '▐', style: { fg: 'cyan' } },
  padding:      { top: 0, left: 2, right: 2 },
  style:        { fg: 'white', bg: 'black', border: { fg: 'cyan' } },
  content:      '{grey-fg}Ask Mercer anything about your portfolio, market conditions, or strategy.{/}',
});
screen.append(historyBox);

// ─── Input box ────────────────────────────────────────────────────────────────

const inputBox = blessed.textbox({
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
screen.append(inputBox);

// ─── Status bar ───────────────────────────────────────────────────────────────

const statusBar = blessed.box({
  bottom:  0,
  left:    0,
  width:   '100%',
  height:  1,
  tags:    true,
  content: ' {cyan-fg}[Enter]{/} Send  {cyan-fg}[↑↓]{/} Scroll  {cyan-fg}[q]{/} Quit  |  {grey-fg}Connected to localhost:3000{/}',
  style:   { fg: 'white', bg: 'black' },
});
screen.append(statusBar);

// ─── State ────────────────────────────────────────────────────────────────────

// Load persisted history, restore timestamps as Date objects
const history = loadHistory().map(e => ({ ...e, time: new Date(e.time) }));

function appendHistory(role, text) {
  history.push({ role, text, time: new Date() });
  saveHistory(history.map(e => ({ ...e, time: e.time.toISOString() })));
  renderHistory();
}

function wrapText(text, maxW) {
  const result = [];
  // Preserve newlines in the response by splitting first
  for (const paragraph of text.split('\n')) {
    if (!paragraph.trim()) { result.push(''); continue; }
    const words = paragraph.split(' ');
    let line = '  ';
    for (const word of words) {
      if (line.length + word.length + 1 > maxW && line.trim()) {
        result.push(line.trimEnd());
        line = '  ' + word + ' ';
      } else {
        line += word + ' ';
      }
    }
    if (line.trim()) result.push(line.trimEnd());
  }
  return result;
}

function renderHistory() {
  const lines = [];
  const maxW  = Math.max(40, (screen.width || 80) - 10);
  for (const entry of history) {
    const time  = entry.time.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    const isUser = entry.role === 'user';
    const label  = isUser ? '{cyan-fg}{bold}You:{/}' : '{green-fg}{bold}Mercer:{/}';
    const color  = isUser ? 'cyan-fg' : 'white-fg';
    lines.push(`{grey-fg}${time}{/}  ${label}`);
    for (const wrapped of wrapText(entry.text, maxW)) {
      lines.push(`{${color}}${wrapped}{/}`);
    }
    lines.push('');
  }
  historyBox.setContent(lines.join('\n') + '\n\n');
  historyBox.setScrollPerc(100);
  screen.render();
}

// ─── API call ─────────────────────────────────────────────────────────────────

async function askMercer(question) {
  statusBar.setContent(' {yellow-fg}Asking Mercer...{/}');
  screen.render();
  try {
    // Send all prior turns (everything before the current question)
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
    appendHistory('mercer', data.answer ?? 'No response.');
    statusBar.setContent(' {cyan-fg}[Enter]{/} Send  {cyan-fg}[↑↓]{/} Scroll  {cyan-fg}[q]{/} Quit  |  {green-fg}Ready{/}');
  } catch (err) {
    appendHistory('mercer', `Error: ${err.message}`);
    statusBar.setContent(` {cyan-fg}[Enter]{/} Send  {cyan-fg}[q]{/} Quit  |  {red-fg}${err.message}{/}`);
  }
  screen.render();
}

// ─── Key bindings ─────────────────────────────────────────────────────────────

inputBox.key(['enter'], async () => {
  const question = inputBox.getValue().trim();
  if (!question) return;
  inputBox.clearValue();
  inputBox.focus();
  screen.render();
  appendHistory('user', question);
  await askMercer(question);
});

screen.key(['q', 'C-c'], () => {
  screen.destroy();
  process.exit(0);
});

// Scroll history with arrow keys
screen.key(['up'],   () => { historyBox.scroll(-1); screen.render(); });
screen.key(['down'], () => { historyBox.scroll(1);  screen.render(); });
screen.key(['pageup'],   () => { historyBox.scroll(-5); screen.render(); });
screen.key(['pagedown'], () => { historyBox.scroll(5);  screen.render(); });

// ─── Boot ─────────────────────────────────────────────────────────────────────

inputBox.focus();
if (history.length > 0) renderHistory();
screen.render();
