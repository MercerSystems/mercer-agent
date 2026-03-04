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

const router = Router();

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// POST /ask
router.post('/', async (req, res) => {
  try {
    const { question } = req.body ?? {};

    if (!question) {
      return res.status(400).json({ error: 'Request body must include: question' });
    }

    const [portfolio, mandates, stats] = await Promise.all([
      getPortfolio(),
      getMandates(),
      getStats(),
    ]);

    const recentDecisions = getRecentDecisions();

    const systemPrompt = `You are Mercer, the reasoning engine behind this DeFi portfolio. You have the same communication style as Claude — warm, direct, intellectually curious, and honest. You give real answers with specific data, acknowledge uncertainty when it exists, and don't over-explain. You're talking to the portfolio owner who built you. Be conversational but substantive. No bullet points unless they genuinely help. No terminal formatting. Just talk like a smart, thoughtful advisor who knows this portfolio inside and out.

Do not start responses with a status header, divider lines, or any intro block showing STATUS/Uptime/Cycles/Last cycle. Jump straight into answering the question. No preamble, no system headers, no dividers.

Current portfolio: ${JSON.stringify(portfolio)}
Active mandate: ${JSON.stringify(mandates.moderate)}
Recent decisions: ${JSON.stringify(recentDecisions)}
Engine stats: ${JSON.stringify(stats)}`;

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: systemPrompt,
      messages: [{ role: 'user', content: question }],
    });

    res.json({ answer: response.content[0].text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
