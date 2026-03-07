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

Mercer is a fully autonomous on-chain portfolio agent. It connects directly to your Solana wallet, monitors live market conditions across **400+ Solana ecosystem tokens**, and uses Claude (claude-sonnet-4-6) to discover, enter, and exit positions — all while enforcing a strict risk mandate to protect your capital.

Its primary edge: **small-cap discovery**. Mercer hunts for micro and small-cap tokens ($1M–$20M market cap) gaining real traction — early momentum plays before the crowd arrives. As the portfolio grows, it scales into larger-cap assets for stability.

**It runs continuously. It trades real money. It protects itself.**

---

## How It Works

```
Solana Wallet (live SPL balances)
           ↓
CoinGecko — 400+ Solana ecosystem tokens across 3 fetches:
  • Top 250 by market cap (page 1)
  • Tokens 251–500 by market cap (page 2)
  • Top 75 by 24h volume (new launch discovery)
           ↓
Volume baseline tracker — rolling spike ratio per token (~96min window)
           ↓
Portfolio state builder (USD values, PnL vs entry, drawdown)
           ↓
┌─────────────────────────────────────────────┐
│           30s Watchdog (always on)          │
│  • Entry-based stop-loss (micro-cap aware)  │
│  • Trailing stop (from all-time peak)       │
│  • Profit ladder (staged partial exits)     │
│  • 1h momentum alert                        │
└─────────────────────────────────────────────┘
           ↓
Claude reasoning loop (every 15 min, adaptive)
  → Market regime classification (BULL RUN / CORRECTION / BEAR / etc.)
  → Momentum leaders, sustained movers, new launch signals
  → Stale/declining position rotation candidates
  → Returns structured decision: hold/buy/sell/swap
           ↓
Mandate enforcement layer
  → Position size, market cap, volume, drawdown checks
  → Stop-loss cooldown, permanent buy block list
  → Pre-flight balance checks
           ↓
Jupiter aggregator (best-price swap execution)
  → Buy: USDC → token
  → Sell: token → USDC
  → Swap: token → token (direct rotation, no USDC round-trip)
           ↓
Dashboard update + macOS notifications
```

---

## Key Features

### Small-Cap Discovery Strategy

Mercer's primary focus scales with portfolio size:

| Portfolio Size | Strategy |
|---|---|
| Under $2K | Micro/small-cap only ($1M–$20M market cap) — asymmetric upside |
| $2K–$10K | Mix: small-cap momentum + established tokens |
| Over $10K | Shift toward large-cap Solana ecosystem leaders |

Claude scores every opportunity using **conviction stars** (★★★/★★/★) based on 1h/24h momentum and volume spike ratio, then sizes positions accordingly. No loyalty to existing holdings — stale or declining positions are rotation candidates.

### New Launch Discovery

Three parallel market data fetches ensure Mercer sees opportunities across the full spectrum:

- **Market cap sort (pages 1+2):** The established universe — top 500 tokens by market cap
- **Volume sort:** Top 75 tokens by 24h volume — surfaces new launches ranking low by market cap but getting heavy attention right now
- **Volume spike ratio:** Each token's current volume vs. its rolling 96-minute baseline. A spike ratio >3× signals unusual interest. Turnover >50% (volume/marketCap) is a new launch fingerprint.

### Token-to-Token Swaps

Mercer can rotate directly from a declining position into a new one without a USDC round-trip. Swap trades (`type: "swap"`) specify `fromAsset` and `toAsset` — executed natively through Jupiter's routing engine.

### Market Regime Awareness

Claude classifies the current macro environment from SOL's 7d/24h/1h performance before making any decision:

| Regime | Behavior |
|---|---|
| BULL RUN | Bias toward entries, ride momentum |
| RECOVERY | Cautious adds on confirmation |
| PULLBACK | Tighten stops, reduce new exposure |
| CORRECTION | Defensive — hold cash, cut losers |
| BEAR | Capital preservation mode |
| VOLATILE | Small size, fast exits |
| CONSOLIDATION | Wait for breakout confirmation |

### Autonomous Trading
- Connects to any Solana wallet via private key
- Executes live swaps through Jupiter aggregator (best-price routing across all DEXes)
- Token-2022 program support for newer SPL tokens
- `MAX_TRADE_USD` cap and `MIN_CYCLE_INTERVAL` throttle prevent over-trading
- Price impact guard blocks trades with >2% slippage
- USDC and SOL gas balance verified on-chain before every trade

### Multi-Layer Protection (Watchdog)
The watchdog runs every **30 seconds**, independently of the reasoning cycle:

| Protection | What it does |
|---|---|
| **Entry stop-loss** | Exits fully if PnL drops below threshold from entry price |
| **Micro-cap stop-loss** | Tighter 10% stop for tokens under $5M market cap (vs. standard 15%) |
| **Trailing stop** | Exits if price drops X% from its all-time peak — protects unrealized gains |
| **Profit ladder** | Staged partial sells at multiple PnL milestones (sell 33% at +12%, +30%, +60%) |
| **Stop-loss cooldown** | Blocks re-entry into a token for a cooldown period after a stop-out |
| **Permanent buy block** | `data/blocked-buys.json` — tokens that should never be bought |
| **Max drawdown halt** | Blocks all trading if total portfolio drawdown exceeds mandate limit |
| **Health monitoring** | Alert if watchdog itself fails 5 consecutive checks |

All protection state (high-water marks, ladder progress, entry prices, peak portfolio value) is **persisted to disk** and survives restarts.

### Risk Mandate System

Every decision is validated against an active mandate before execution:

| Preset | Max Position | Stop-Loss | Micro-Cap Stop | Trailing Stop | Max Drawdown | Min Market Cap |
|---|---|---|---|---|---|---|
| `conservative` | 20% | 10% | — | 8% | 15% | $500M |
| `moderate` | 35% | 15% | 10% (<$5M cap) | 10% | 25% | $1M |
| `aggressive` | 50% | 35% | — | 25% | 40% | $5M |

The `minMarketCapUsd` filter automatically blocks illiquid tokens — no allowlist to maintain.

### Confidence-Based Position Sizing

Claude reports a confidence score (0–1) with every decision. Positions are automatically scaled:

| Confidence | Trade Size |
|---|---|
| ≥ 0.75 | 100% of proposed size |
| 0.62–0.74 | 65% of proposed size |
| 0.50–0.61 | 35% of proposed size |
| < 0.50 | No buys — hold or sell only |

### Re-Buy Scrutiny

If Claude proposes buying a token purchased within the last 60 minutes, the reasoning context flags it explicitly with the previous purchase time and price. Claude must justify re-entry with a clear reason (e.g. new catalyst, momentum acceleration) or skip the trade.

### Terminal Dashboard
A full blessed-contrib terminal UI showing:
- Live portfolio table: balance, USD value, portfolio %, PnL vs entry, 24h change
- P&L chart with live 1s updates (60/240/300 data point windows)
- Market box: all-token ticker or individual token detail view
- Latest Claude decision: action, confidence bar, trades, risk flags, execution log, recent history
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
npm run watchdog    # auto-restarts on crash
```

### 4. Start the dashboard (separate terminal)

```bash
npm run dashboard
```

### 5. Ask Mercer (optional, separate terminal)

```bash
npm run ask
```

---

## npm Scripts

| Script | Description |
|---|---|
| `npm run serve` | Start API server once (port 3000) |
| `npm run watchdog` | Start server with auto-restart on crash |
| `npm run dashboard` | Launch terminal dashboard |
| `npm run ask` | Launch Ask Mercer interactive chat |
| `npm start` | Run autonomous agent loop |

---

## Dashboard Controls

| Key | Action |
|---|---|
| `r` | Force reasoning cycle (calls Claude immediately) |
| `p` | Refresh portfolio + prices (no Claude call) |
| `a` | Open Ask Mercer chat in new terminal window |
| `1` / `4` / `0` | Chart window: 60 / 240 / 300 data points |
| `m` | Market box — pick token or return to all-token ticker |
| `c` | Chart mode — portfolio or individual token |
| `h` | Trade history overlay (last 20 trades) |
| `↑` `↓` / PgUp PgDn | Scroll decision box |
| `q` | Quit (5s confirmation) |

---

## Project Structure

```
src/
├── server.js                 Express API entry point (port 3000)
├── dashboard.js              blessed-contrib terminal dashboard
├── executor.js               Jupiter swap execution (buy/sell/swap)
├── notify.js                 macOS + Discord notifications
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
│   ├── trailing-stops.js     High-water marks + profit ladder state
│   ├── stop-cooldown.js      Re-entry cooldown after stop-outs
│   └── blocked-buys.js       Permanent buy block list loader
│
├── market/
│   ├── solana-market.js      400+ Solana tokens — 3-fetch strategy (cap p1/p2 + volume)
│   ├── volume-tracker.js     Rolling volume baseline + spike ratio per token
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
    └── solana.js             Dynamic SPL token discovery (standard + Token-2022)

data/
├── decisions.json            Persisted decision history (last 200)
├── entry-prices.json         Token entry prices for PnL tracking
├── blocked-buys.json         Permanently blocked tokens (never buy)
└── volume-baseline.json      Rolling volume baseline per token
```

---

## API Reference

All endpoints served on `http://localhost:3000`.

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/portfolio` | Live wallet balances + USD values. `source: 'live'\|'mock'` |
| `GET` | `/portfolio/history` | Portfolio value snapshots (last 500) |
| `GET` | `/market` | Full ecosystem market map (400+ tokens) |
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
