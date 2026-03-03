// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — routes/mandates.js
// GET  /mandates          — list all mandate presets
// POST /mandates/validate — validate a decision against a mandate
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from 'express';
import { MANDATE_PRESETS, enforceMandate } from '../agent/mandate.js';

const router = Router();

/**
 * Resolves a mandate from a string preset name or a full mandate object.
 * Returns null if a string preset name is unknown.
 */
function resolveMandate(mandate) {
  if (typeof mandate === 'string') {
    return MANDATE_PRESETS[mandate] ?? null;
  }
  return mandate ?? null;
}

export function getMandates() {
  return MANDATE_PRESETS;
}

// GET /mandates
router.get('/', (_req, res) => {
  res.json(MANDATE_PRESETS);
});

// POST /mandates/validate
router.post('/validate', (req, res, next) => {
  try {
    const { decision, mandate: mandateInput, portfolio } = req.body ?? {};

    if (!decision || mandateInput == null || !portfolio) {
      return next(Object.assign(
        new Error('Request body must include: decision, mandate, portfolio'),
        { status: 400 }
      ));
    }

    const mandate = resolveMandate(mandateInput);
    if (!mandate) {
      return next(Object.assign(
        new Error(`Unknown mandate preset: "${mandateInput}". Valid presets: ${Object.keys(MANDATE_PRESETS).join(', ')}`),
        { status: 400 }
      ));
    }

    if (typeof portfolio.totalValueUsd !== 'number') {
      return next(Object.assign(
        new Error('portfolio.totalValueUsd must be a number'),
        { status: 400 }
      ));
    }

    if (!Array.isArray(portfolio.holdings)) {
      return next(Object.assign(
        new Error('portfolio.holdings must be an array'),
        { status: 400 }
      ));
    }

    const { decision: validatedDecision, violations, blocked } = enforceMandate(decision, mandate, portfolio);

    res.json({ decision: validatedDecision, violations, blocked });
  } catch (err) {
    next(err);
  }
});

export default router;
