// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — routes/ask.js
// POST /ask — answer a natural-language question about the portfolio
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { getPortfolio } from './portfolio.js';
import { getMandates } from './mandates.js';
import { getStats } from './stats.js';
import { getRecentDecisions } from '../agent/reasoning.js';
import { fetchSolanaMarketMap } from '../market/solana-market.js';

const router = Router();

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// POST /ask
router.post('/', async (req, res) => {
  try {
    const { question, history = [] } = req.body ?? {};

    if (!question) {
      return res.status(400).json({ error: 'Request body must include: question' });
    }

    const [portfolio, mandates, stats, market] = await Promise.all([
      getPortfolio(),
      getMandates(),
      getStats(),
      fetchSolanaMarketMap(150).catch(() => ({})),
    ]);

    const recentDecisions = getRecentDecisions();

    const systemPrompt = `You are Mercer, the reasoning engine behind this DeFi portfolio. You have the same communication style as Claude — warm, direct, intellectually curious, and honest. You give real answers with specific data, acknowledge uncertainty when it exists, and don't over-explain. You're talking to the portfolio owner who built you. Be conversational but substantive. No bullet points unless they genuinely help. No terminal formatting. Just talk like a smart, thoughtful advisor who knows this portfolio inside and out. Always finish your sentences and paragraphs completely — never trail off mid-thought.

Do not start responses with a status header, divider lines, or any intro block showing STATUS/Uptime/Cycles/Last cycle. Jump straight into answering the question. No preamble, no system headers, no dividers.

Current portfolio: ${JSON.stringify(portfolio)}
Live market prices: ${JSON.stringify(market)}
Active mandate: ${JSON.stringify(mandates.moderate)}
Recent decisions: ${JSON.stringify(recentDecisions)}
Engine stats: ${JSON.stringify(stats)}`;

    // Build multi-turn message array from conversation history
    const messages = [
      ...history.map(m => ({
        role:    m.role === 'mercer' ? 'assistant' : 'user',
        content: m.content,
      })),
      { role: 'user', content: question },
    ];

    const response = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system:     systemPrompt,
      messages,
    });

    const text       = response.content[0].text;
    const truncated  = response.stop_reason === 'max_tokens';
    res.json({ answer: truncated ? text + '…' : text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
