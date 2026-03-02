# Mercer Systems

**Autonomous DeFi portfolio agent for the Solana ecosystem.**

**Website:** [mercersys.com](https://mercersys.com) · **Twitter:** [@MercerSystems_](https://twitter.com/MercerSystems_)

---

## How it works

```
Live prices (CoinGecko)
        ↓
Portfolio state builder
        ↓
Claude reasoning loop (claude-sonnet-4-6)
        ↓
Mandate enforcement layer
        ↓
Approved decision + risk report
```

1. **Fetch** — pulls live prices from CoinGecko for every holding
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
    └── coingecko.js      Live price fetching via CoinGecko API
```

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | — | Your Anthropic API key |
| `MERCER_MODEL` | No | `claude-sonnet-4-6` | Claude model to use for reasoning |

---

## Status

**v0.1.0** — Reasoning engine and mandate enforcement are live. Wallet integration and on-chain execution (Jupiter) are in active development.

**Roadmap:**
- [ ] Jupiter swap execution
- [ ] Live wallet state from RPC
- [ ] Scheduled runs (cron / event-driven)
- [ ] Web dashboard
- [ ] Custom mandate builder

---

## Requirements

- Node.js 18+
- Anthropic API key ([console.anthropic.com](https://console.anthropic.com))
