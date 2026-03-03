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

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, _req, res, _next) => {
  console.error('[Mercer API Error]', err.message);
  res.status(err.status ?? 500).json({ error: err.message });
});

app.listen(PORT, () => console.log(`[Mercer] API running on http://localhost:${PORT}`));
