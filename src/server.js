// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — server.js
// Express API entry point
// ─────────────────────────────────────────────────────────────────────────────

import 'dotenv/config';
import express from 'express';
import reasonRouter   from './routes/reason.js';
import marketRouter   from './routes/market.js';
import mandatesRouter from './routes/mandates.js';

const PORT = process.env.PORT ?? 3000;

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('[Mercer] WARNING: ANTHROPIC_API_KEY not set. POST /reason will fail.');
}

const app = express();
app.use(express.json());

app.use('/reason',   reasonRouter);
app.use('/market',   marketRouter);
app.use('/mandates', mandatesRouter);

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, _req, res, _next) => {
  console.error('[Mercer API Error]', err.message);
  res.status(err.status ?? 500).json({ error: err.message });
});

app.listen(PORT, () => console.log(`[Mercer] API running on http://localhost:${PORT}`));
