# Mercer Systems

**Autonomous DeFi portfolio agent for the Solana ecosystem.**

**Website:** [mercersys.com](https://mercersys.com) · **Twitter:** [@MercerSystems_](https://twitter.com/MercerSystems_)

---

```
███╗   ███╗███████╗██████╗  ██████╗███████╗██████╗
████╗ ████║██╔════╝██╔══██╗██╔════╝██╔════╝██╔══██╗
██╔████╔██║█████╗  ██████╔╝██║     █████╗  ██████╔╝
██║╚██╔╝██║██╔══╝  ██╔══██╗██║     ██╔══╝  ██╔══██╗
██║ ╚═╝ ██║███████╗██║  ██║╚██████╗███████╗██║  ██║
╚═╝     ╚═╝╚══════╝╚═╝  ╚═╝ ╚═════╝╚══════╝╚═╝  ╚═╝
                        S Y S T E M S
          ─────────────────────────────────────────
           Autonomous DeFi Portfolio Agent · Solana
```

---

## What Mercer Does

Mercer is a fully autonomous on-chain portfolio agent. It connects directly to your Solana wallet, monitors live market conditions across the top 150 Solana ecosystem tokens, and uses Claude (claude-sonnet-4-6) to make and execute trading decisions — all while enforcing a strict risk mandate to protect your capital.

**It runs continuously. It trades real money. It protects itself.**

---

## How It Works

```
Solana Wallet (live SPL balances)
           ↓
CoinGecko — top 150 Solana ecosystem tokens (dynamic, no hardcoded list)
           ↓
Portfolio state builder (USD values, PnL vs entry, drawdown)
           ↓
┌─────────────────────────────────────────────┐
│           30s Watchdog (always on)          │
│  • Entry-based stop-loss                    │
│  • Trailing stop (from all-time peak)       │
│  • Profit ladder (staged partial exits)     │
│  • 1h momentum alert                        │
└─────────────────────────────────────────────┘
           ↓
Claude reasoning loop (every 10 min)
  → Analyzes all 150 tokens for opportunities
  → Returns structured decision: hold/buy/sell/rebalance
           ↓
Mandate enforcement layer
  → Position size, market cap, drawdown checks
  → Pre-flight USDC + SOL gas balance checks
           ↓
Jupiter aggregator (best-price swap execution)
           ↓
Discord notification + dashboard update
```

---

## Key Features

### Autonomous Trading
- Connects to any Solana wallet via private key
- Executes live swaps through Jupiter aggregator (best-price routing across all DEXes)
- `MAX_TRADE_USD` cap and `MIN_CYCLE_INTERVAL` throttle prevent over-trading
- Price impact guard blocks trades with >2% slippage
- USDC and SOL gas balance verified on-chain before every trade

### Dynamic Market Coverage
- Discovers the **top 150 Solana ecosystem tokens** by market cap from CoinGecko — no hardcoded list
- Market context updates every 2 minutes; Claude sees all 150 when making decisions
- New tokens that gain traction automatically appear in Claude's view
- Stablecoins filtered out — USDC is the cash position, never traded against
- Solana mint addresses resolved dynamically via CoinGecko coin detail API (24h cache)

### Multi-Layer Protection (Watchdog)
The watchdog runs every **30 seconds**, independently of the reasoning cycle:

| Protection | What it does |
|---|---|
| **Entry stop-loss** | Exits fully if PnL drops below threshold from entry price |
| **Trailing stop** | Exits if price drops X% from its all-time peak — protects unrealized gains |
| **Profit ladder** | Staged partial sells at multiple PnL milestones (e.g. sell 25% at +30%, another 25% at +55%) |
| **1h momentum alert** | Discord alert if any holding drops >5% in 1 hour |
| **Max drawdown halt** | Blocks all trading if total portfolio drawdown exceeds mandate limit |
| **Health monitoring** | Discord alert if watchdog itself fails 5 consecutive checks |

All protection state (high-water marks, ladder progress, entry prices, peak portfolio value) is **persisted to disk** and survives restarts.

### Risk Mandate System
Every decision is validated against an active mandate before execution:

| Preset | Max Position | Stop-Loss | Trailing Stop | Max Drawdown | Min Market Cap |
|---|---|---|---|---|---|
| `conservative` | 20% | 5% | 8% | 15% | $500M |
| `moderate` | 30% | 10% | 15% | 25% | $50M |
| `aggressive` | 40% | 15% | 25% | 35% | $5M |

The `minMarketCapUsd` filter automatically blocks illiquid tokens — no allowlist to maintain.

### Terminal Dashboard
A full blessed-contrib terminal UI showing:
- Live portfolio table with balance, USD value, portfolio %, PnL vs entry, 24h change
- P&L chart with live 1s updates
- Market data for held tokens
- Latest Claude decision with full rationale, trades, risk flags, confidence score
- Session cost tracker, countdown to next reasoning cycle
- **Ask Mercer** — natural language Q&A about the portfolio (`[a]` key)

### Ask Mercer
An interactive terminal chat backed by Claude. Ask anything about your portfolio, market conditions, or past decisions. Full conversation history with live portfolio context injected into every message.

---

## Quickstart

### 1. Clone and install

```bash
git clone https://github.com/MercerSystems/mercer-agent.git
cd mercer-agent
npm install
```

### 2. Configure `.env`

```env
# Required
ANTHROPIC_API_KEY=sk-ant-...

# Solana wallet (live trading)
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=...
WALLET_ADDRESS=YourBase58WalletAddress
WALLET_PRIVATE_KEY=YourBase58PrivateKeyOrJSONArray

# Execution
AUTO_EXECUTE=true          # false = dry-run mode (no real trades)
DRY_RUN=false
MAX_TRADE_USD=35           # hard cap per trade
MIN_CYCLE_INTERVAL=300     # minimum seconds between executions

# Optional
COINGECKO_API_KEY=...      # free demo key at coingecko.com — recommended
DISCORD_WEBHOOK_URL=...    # trade alerts, stop-loss notifications
MERCER_MANDATE=moderate    # conservative | moderate | aggressive
MIN_SOL_FOR_GAS=0.01       # minimum SOL balance before blocking trades
MAX_PRICE_IMPACT_PCT=2.0   # max acceptable Jupiter price impact %
```

> **DRY_RUN=true** (default) fetches quotes and logs decisions without broadcasting transactions. Set `DRY_RUN=false` only when ready for live execution.

### 3. Start the server

```bash
node src/server.js
```

### 4. Start the dashboard (separate terminal)

```bash
node src/dashboard.js
```

---

## Dashboard Controls

| Key | Action |
|---|---|
| `r` | Force reasoning cycle (calls Claude immediately) |
| `p` | Refresh portfolio + prices (no Claude call) |
| `a` | Open Ask Mercer chat in new terminal window |
| `1` / `4` / `0` | Chart window: 60 / 240 / 300 data points |
| `m` | Market detail view — pick a token |
| `c` | Chart mode — portfolio or individual token |
| `h` | Trade history overlay |
| `↑` `↓` | Scroll decision box |
| `q` | Quit (5s confirmation) |

---

## Project Structure

```
src/
├── server.js                 Express API entry point (port 3000)
├── dashboard.js              blessed-contrib terminal dashboard
├── ask-terminal.js           Interactive Ask Mercer chat terminal
├── executor.js               Jupiter swap execution layer
├── notify.js                 Discord webhook notifications
├── trade-signal.js           In-process trade signal (instant dashboard refresh)
├── history.js                Portfolio snapshot store
│
├── agent/
│   ├── watchdog.js           30s protection monitor (stop-loss, trailing, ladder)
│   ├── mandate.js            Risk mandate presets + enforcement engine
│   ├── prompts.js            Claude system prompt + context builder
│   ├── reasoning.js          Anthropic SDK integration + decision parsing
│   ├── portfolio.js          Portfolio state builder (USD values, PnL)
│   ├── entry-prices.js       Persisted entry prices + peak value
│   └── trailing-stops.js     High-water marks + profit ladder state
│
├── market/
│   ├── solana-market.js      Top 150 Solana tokens from CoinGecko (primary)
│   ├── token-registry.js     Solana mint address resolver (CoinGecko + cache)
│   └── prices.js             Legacy price fetcher (standalone CLI only)
│
├── routes/
│   ├── reason.js             POST /reason — full reasoning cycle
│   ├── portfolio.js          GET /portfolio — live wallet + USD values
│   ├── market.js             GET /market — ecosystem market map
│   ├── ask.js                POST /ask — natural language Q&A
│   ├── execute.js            POST /execute — manual reason + execute
│   ├── mandates.js           GET /mandates — preset definitions
│   └── stats.js              GET /stats — engine performance metrics
│
└── wallet/
    └── solana.js             Dynamic SPL token discovery via Solana RPC
```

---

## API Reference

All endpoints served on `http://localhost:3000`.

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/portfolio` | Live wallet balances + USD values. `source: 'live'\|'mock'` |
| `GET` | `/portfolio/history` | Portfolio value snapshots (last 500) |
| `GET` | `/market` | Full ecosystem market map (150 tokens) |
| `GET` | `/events` | `{ lastTradeAt }` — poll for trade signals |
| `GET` | `/mandates` | All mandate preset definitions |
| `GET` | `/stats` | Reasoning cycle stats (avg duration, cycle count) |
| `POST` | `/reason` | Run a full reasoning cycle. Body: `{ mandate, trigger? }` |
| `POST` | `/ask` | Ask a question. Body: `{ question, history? }` |
| `POST` | `/execute` | Manual reason + execute. Body: `{ mandate? }` |

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | — | Anthropic API key |
| `SOLANA_RPC_URL` | For live | — | Solana RPC endpoint (Helius recommended) |
| `WALLET_ADDRESS` | For live | — | Base58 wallet address |
| `WALLET_PRIVATE_KEY` | For execution | — | Base58 or JSON byte-array private key |
| `AUTO_EXECUTE` | No | `false` | Enable autonomous trade execution |
| `DRY_RUN` | No | `true` | Fetch quotes only, no broadcast |
| `MAX_TRADE_USD` | No | `35` | Hard cap per individual trade |
| `MIN_CYCLE_INTERVAL` | No | `300` | Min seconds between executions |
| `MERCER_MANDATE` | No | `moderate` | Active risk mandate preset |
| `COINGECKO_API_KEY` | No | — | Free demo key for dedicated rate limits |
| `DISCORD_WEBHOOK_URL` | No | — | Webhook URL for trade + alert notifications |
| `MIN_SOL_FOR_GAS` | No | `0.01` | Minimum SOL before blocking trades |
| `MAX_PRICE_IMPACT_PCT` | No | `2.0` | Maximum Jupiter price impact % |
| `WATCHDOG_INTERVAL_MS` | No | `30000` | Watchdog check interval (ms) |
| `ALERT_1H_DROP_PCT` | No | `5.0` | 1h momentum alert threshold % |
| `DATA_REFRESH_MS` | No | `60000` | Dashboard data refresh interval (ms) |

---

## Requirements

- Node.js 18+
- Anthropic API key — [console.anthropic.com](https://console.anthropic.com)
- Solana RPC endpoint — [Helius](https://helius.dev) (free tier works)
- CoinGecko demo key — [coingecko.com/en/api](https://www.coingecko.com/en/api) (free, recommended)
