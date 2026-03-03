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

## How it works

```
Live prices (Jupiter Price API)
        ↓
Portfolio state builder
        ↓
Claude reasoning loop (claude-sonnet-4-6)
        ↓
Mandate enforcement layer
        ↓
Approved decision + risk report
```

1. **Fetch** — pulls live prices from Jupiter Price API for every holding
2. **Reason** — Claude analyzes the portfolio against the active risk mandate and returns a structured decision (hold / rebalance / buy / sell / alert)
3. **Enforce** — the mandate layer validates every proposed trade: whitelist, position sizing, stop-loss, drawdown halt
4. **Output** — color-coded terminal report with approved trades, violations, and reasoning

---

## Quickstart

```bash
# 1. Clone
git clone https://github.com/MercerSystems/mercer-agent.git
cd mercer-agent

# 2. Install dependencies
npm install

# 3. Add your Anthropic API key
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env

# 4. Run
npm start
```

---

## Risk mandates

Mercer ships with three preset mandates. Switch between them in `src/index.js`:

```js
const activeMandatePreset = 'moderate'; // 'conservative' | 'moderate' | 'aggressive'
```

| Preset | Max position | Stop-loss | Max drawdown | Allowed assets |
|---|---|---|---|---|
| `conservative` | 20% | 10% | 15% | SOL, USDC, JTO, JITO |
| `moderate` | 35% | 20% | 25% | + BONK, WIF, JUP, PYTH |
| `aggressive` | 50% | 35% | 40% | + MEME, BOME, POPCAT |

The enforcement layer runs after every Claude decision and can **block**, **trim**, or **auto-convert** trades that violate the active mandate.

---

## Project structure

```
src/
├── index.js              Entry point — portfolio setup, main loop
├── agent/
│   ├── mandate.js        Risk enforcement engine + mandate presets
│   ├── prompts.js        Claude system prompt + context builder
│   └── reasoning.js      Anthropic SDK integration + decision parsing
└── market/
    └── prices.js         Live price fetching via Jupiter Price API
```

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | — | Your Anthropic API key |
| `SOLANA_RPC_URL` | No | — | Helius (or other) RPC endpoint for live wallet balances |
| `WALLET_ADDRESS` | No | — | Base58 Solana wallet address to track |
| `MERCER_MODEL` | No | `claude-sonnet-4-6` | Claude model to use for reasoning |

---

## Status

**v0.1.0** — Reasoning engine, mandate enforcement, and live wallet integration are live. On-chain execution via Jupiter is in active development.

**Roadmap:**
- [ ] Jupiter swap execution
- [ ] Scheduled runs (cron / event-driven)
- [ ] Web dashboard
- [ ] Custom mandate builder

---

## Requirements

- Node.js 18+
- Anthropic API key ([console.anthropic.com](https://console.anthropic.com))
