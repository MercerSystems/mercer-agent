// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — server.js
// Express API entry point
// ─────────────────────────────────────────────────────────────────────────────

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import reasonRouter    from './routes/reason.js';
import marketRouter    from './routes/market.js';
import mandatesRouter  from './routes/mandates.js';
import portfolioRouter from './routes/portfolio.js';
import swapRouter      from './routes/swap.js';
import statsRouter     from './routes/stats.js';
import executeRouter   from './routes/execute.js';
import askRouter       from './routes/ask.js';
import { startWatchdog }      from './agent/watchdog.js';
import { warmTokenRegistry } from './market/token-registry.js';
import { getLastTradeAt, consumeEarlyReason } from './trade-signal.js';
import { startPumpMonitor }  from './pump-monitor.js';
import { fetchNewLaunches }  from './market/dexscreener.js';
import { fetchSolanaMarketMap } from './market/solana-market.js';
import { getPortfolio }      from './routes/portfolio.js';
import { executeDecision }   from './executor.js';

const PORT = process.env.PORT ?? 3000;

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('[Mercer] WARNING: ANTHROPIC_API_KEY not set. POST /reason will fail.');
}

const app = express();
app.use(cors());
app.options('*', cors());
app.use(express.json());

app.use('/reason',    reasonRouter);
app.use('/market',    marketRouter);
app.use('/mandates',  mandatesRouter);
app.use('/portfolio', portfolioRouter);
app.use('/swap',      swapRouter);
app.use('/stats',     statsRouter);
app.use('/execute',   executeRouter);
app.use('/ask',       askRouter);

// Lightweight polling endpoint — dashboard uses this to detect new trades
// and trigger an immediate portfolio refresh without waiting for DATA_REFRESH_MS
app.get('/events', (_req, res) => res.json({ lastTradeAt: getLastTradeAt(), earlyReason: consumeEarlyReason() }));

// DexScreener new launches — dashboard ticker
app.get('/launches', async (_req, res, next) => {
  try { res.json(await fetchNewLaunches()); } catch (err) { next(err); }
});

// Force-sell — manual exit from dashboard [s] key, bypasses Claude
app.post('/force-sell', async (req, res, next) => {
  try {
    const { symbol } = req.body ?? {};
    if (!symbol) return res.status(400).json({ error: 'symbol required' });

    const [portfolio, cgMarket, dexLaunches] = await Promise.all([
      getPortfolio(),
      fetchSolanaMarketMap(150),
      fetchNewLaunches().catch(() => ({})),
    ]);
    const market  = { ...cgMarket };
    for (const [sym, entry] of Object.entries(dexLaunches)) {
      if (!market[sym]) market[sym] = entry;
    }

    const holding = portfolio.holdings.find(h => h.token === symbol);
    if (!holding || holding.value <= 0) {
      return res.status(404).json({ error: `No position in ${symbol}` });
    }

    const decision = {
      action:     'sell',
      trades:     [{ type: 'sell', asset: symbol, amountUsd: holding.value }],
      rationale:  'Manual force-sell via dashboard [s] key',
      confidence: 1.0,
    };

    const execution = await executeDecision(decision, market);
    res.json({ ok: true, execution });
  } catch (err) { next(err); }
});

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, _req, res, _next) => {
  console.error('[Mercer API Error]', err.message);
  res.status(err.status ?? 500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`[Mercer] API running on http://localhost:${PORT}`);
  warmTokenRegistry();
  startWatchdog(process.env.MERCER_MANDATE ?? 'moderate');
  startPumpMonitor();
});
