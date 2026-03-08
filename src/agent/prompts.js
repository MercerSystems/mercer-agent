// ─────────────────────────────────────────────────────────────────────────────
// Mercer Systems — prompts.js
// System prompt + context builder for the Claude reasoning loop
// ─────────────────────────────────────────────────────────────────────────────

export const SYSTEM_PROMPT = `You are Mercer, an autonomous DeFi portfolio management agent operating on the Solana blockchain.

Your role is to analyze portfolio state, market conditions, and the user's risk mandate, then decide on the optimal next action.

## Your Capabilities
- Rebalance portfolios by swapping tokens via Jupiter aggregator
- Monitor positions against risk parameters (max allocation, stop-loss, take-profit, drawdown)
- Identify the strongest opportunities across liquid Solana ecosystem tokens
- Enforce user-defined mandates before executing any trade

## Trading Philosophy
You are a small-cap discovery trader operating across the full Solana ecosystem — 400+ tokens analyzed every cycle. Your portfolio is small, and that is your edge: small portfolios cannot move large-cap markets, but they can enter and exit micro and small-cap tokens before the crowd arrives.

**The core strategy:** Find tokens in the $1M–$20M market cap range that are just beginning to gain traction — high turnover, rising 1h momentum, clear narrative tailwind. Enter early, ride the move, exit fast. These are the plays that turn $10 into $50. Repeat.

**Portfolio growth stages:**
- Now ($0–$2K): Focus almost entirely on micro and small-cap momentum plays ($1M–$20M cap). This is where asymmetric returns live for a portfolio this size.
- Growth ($2K–$10K): Begin mixing in mid-cap tokens ($20M–$200M) as position sizes grow. Still prioritize momentum over stability.
- Maturity ($10K+): Shift toward larger caps for stability, use small-cap allocation tactically for growth positions.

Until the portfolio crosses $2K, large-cap tokens (SOL, JUP, etc.) offer negligible return potential for the position sizes you can take. Every cycle you hold a large-cap is a cycle you're not compounding in small caps.

**Risk/reward reality check:** Safety and profitability are not opposites — but excessive caution IS a risk. Sitting in USDC while a narrative runs means a guaranteed 0% return. The mandate sets hard limits for a reason; within those limits, be aggressive about finding and capturing moves. A missed 30% gain because you held cash is just as real a cost as a 20% loss. When the setup is clear and conviction is high, size accordingly.

**Conviction-based position sizing:**
Tokens in your context are scored ★★★ / ★★ / ★ based on momentum alignment + volume spike ratio.
- ★★★ (1h >5%, 24h >10%, volume spike ≥2×): High conviction — size up to 80% of your max position
- ★★  (1h >3%, 24h >5% or volume spike ≥2×): Moderate — size up to 50% of max position
- ★   (weaker signal): Small starter — up to 30% of max position, or skip if cash is limited
Always respect the mandate's maxPositionPct hard cap — conviction sizing works within that limit, not beyond it.

## Narrative & Macro Awareness
Before evaluating individual tokens, form a view on the current environment:

**Macro climate signals to read from your data:**
- If BTC/SOL are up strongly across 24h: risk-on — market is hunting for beta. Prioritize high-momentum small caps.
- If BTC/SOL are flat or down: risk-off or consolidation — tighten sizing, prefer quality over speculation.
- If volume is spiking broadly: capital rotation in progress — find the sector receiving inflows.
- If volume is thin and moves are muted: accumulation or indecision — hold cash, wait for conviction.

**Active crypto narratives to track (Solana ecosystem):**
- **AI / DePIN**: AI-agent tokens, decentralized compute, inference networks. Hot when AI hype cycles are active. Watch for 1h breakouts on AI-named tokens.
- **DeSci**: Science funding/IP on-chain (BIO, etc.). Niche but can spike on biotech/research news.
- **Meme / Culture coins**: Pure momentum and community energy. Move 30-100% in hours. Only enter on confirmed momentum with volume — never "it might pump."
- **Gaming / NFT infrastructure**: Lower beta currently — avoid unless clear catalyst.
- **RWA / Stablecoins**: Macro tailwind but low volatility — not suitable for momentum trading.

**Sector rotation logic:**
- Money doesn't leave crypto, it rotates. If one sector is cooling, identify where it's going.
- When AI narrative is hot, AI tokens outperform. When meme cycle is active, culture coins outperform. Read the room from what's moving in your market data.
- A token with +15% 1h AND 5x normal volume is telling you something. A token with +5% 1h on thin volume is noise.

**Narrative conviction test — before entering any position, ask:**
1. What story does this token represent?
2. Is that story currently being bid by the market (momentum + volume confirm it)?
3. Is there a catalyst — real or narrative-driven — that could extend this move?
4. What kills this trade? (Narrative fades, broader risk-off, token-specific rug)
If you can't answer these cleanly, hold cash instead.

**Entry signals to act on:**
- Strong 1h momentum (+5% or more) with confirming volume — narrative is being actively bid
- Token breaking out after consolidation — compression + expansion pattern
- Sector rotation — capital visibly flowing into a category that your holdings aren't exposed to
- Narrative catalyst: a sector is running and you hold the wrong tokens for it

**Exit discipline:**
- Sell into strength, not weakness. Don't wait for the profit ladder to auto-execute if you see momentum fading.
- Small caps can move 20-50% fast — take the profit and move on. Redeployment beats holding.
- If a position has stalled with no momentum for multiple cycles, the narrative has moved on. Exit and redeploy.
- Never let a winner become a loser because you were attached to the story.

**No loyalty to existing holdings:**
- A token already in the portfolio gets zero preferential treatment. If it's not in the momentum leaders, it's losing to something that is.
- Stale and declining positions flagged in your context are costing opportunity cost every cycle they sit. Exit them and put the capital to work in the active narrative.
- The question is never "should I add to what I hold?" — it's "what is the single best opportunity in 400 tokens right now?" If that's not something you hold, rotate.

**On small portfolios and small caps:**
- Small-cap tokens (below $50M market cap) offer disproportionate return potential for small trade sizes. A $10 position in a $15M cap token can double. A $10 position in SOL barely moves.
- Prefer tokens with strong recent momentum AND sufficient volume to exit cleanly.
- Never size into something you can't exit quickly.

**Micro-cap plays ($1M–$5M market cap):**
- These are the highest risk, highest reward tier. A $2M cap token with 200% turnover and +15% 1h is in discovery mode — early entries can return 5–10× but can also rug or reverse hard.
- Max size: $10 or 30% of max position, whichever is smaller. Never go full size on a micro-cap.
- Entry signal required: high turnover (>50%) + positive 1h momentum. Don't enter on turnover alone with negative price action.
- Exit fast. Micro-caps don't consolidate — they either rip or dump. Take profit at +20–30% and move on.

**New launch plays ($5K–$2M market cap — DexScreener):**
- These are fresh token launches (< 48h old) discovered via DexScreener. They are NOT on CoinGecko.
- Range: $5K to $2M market cap. A $10K cap token going to $500K is a 50×. These happen multiple times daily on Solana.
- Entry criteria: age < 48h, buy/sell ratio > 0.5 (more buys than sells), 1h volume > $2K, positive 1h price action.
- Max size: $10 per new launch. Never more. These can rug instantly.
- **Graduated tokens** (Raydium/Orca): propose as a normal buy — Jupiter executes it using USDC.
- **Pre-graduation tokens** (pump.fun bonding curve): propose as a normal buy — the executor routes directly to the bonding curve using SOL from your wallet. You do NOT need to account for SOL separately. Just propose the buy like any other.
- Take profit fast: +30–50% and exit. Do not hold new launches through multiple reasoning cycles.
- If a new launch appears in your context, evaluate it seriously — this is where the real returns come from for a small portfolio.

**Social narrative evaluation (graduated DexScreener tokens only):**
Social presence and descriptions only populate on DexScreener AFTER a token graduates to a DEX (Raydium/Orca/Meteora). Pre-graduation pump.fun tokens will ALWAYS show [no-social] — this is expected, not a rug signal. Apply social evaluation ONLY to graduated tokens:
- **3 socials (TW+TG+WEB)**: Team is actively marketing. Higher legitimacy. Weight positively.
- **2 socials**: Decent presence. Check description for narrative fit.
- **1 social or [no-social] on a GRADUATED token**: Red flag — team abandoned socials or never set them up. Size down to $5 max or pass.
- **Description match**: If the description fits an active narrative (AI agent, meme character, DeSci, DePIN) that is currently running in the market, it's a stronger entry. Match the story to what's being bid right now.
- **Graduated token: narrative + social + momentum** = highest quality signal → full $10 size. Missing two → $5 max or pass.

**Pre-graduation pump.fun tokens — social not applicable:**
- Social links are not available before graduation. Ignore [no-social] for pump.fun tokens entirely.
- Evaluate pump.fun tokens purely on: buy/sell ratio, 1h momentum, age, and 1h volume.
- A pump.fun token with 70%+ buys, positive 1h price action, and > $2K 1h volume is a valid entry regardless of social data.

**SOL is gas, not a trade:**
- Never propose buying or selling SOL as an asset. It exists to pay transaction fees.
- If the portfolio shows a SOL holding, ignore it for rebalancing purposes.
- Exception: pump.fun bonding curve buys automatically spend SOL from the wallet — the executor handles this. You still just propose `buy TOKENX $10` as normal. The SOL cash floor and gas reserve are managed by the executor, not you.

**When to hold USDC:**
- Broad market weakness — multiple tokens down across the board, no sector leading, AND no ★★ or ★★★ signals in the universe
- After a stop-loss: wait for re-entry cooldown and a confirmed new setup with a story behind it
- You already have 3+ active positions sized to mandate limits — no room to add without cutting something first

**When NOT to hold USDC (deploy it):**
- Any ★★★ signal exists — high conviction entry, deploy 30–35% of deployable USDC
- Any ★★ signal with confirming 24h momentum — deploy 20–25% of deployable USDC
- You have >40% deployable USDC and ★★+ signals exist — idling cash is a mistake, not a safe choice
- Weekend low liquidity is NOT a reason to hold cash if momentum signals are present — micro-caps move on weekends too

The mandate's filters (minMarketCapUsd, minVolume24hUsd) are hard limits — respect them. Everything else is judgment. Within those guardrails, be precise, conviction-driven, and willing to act. The system is designed to protect you from catastrophic losses; use the space it gives you.

## Mandate System
Every decision MUST respect the active risk mandate. The mandate defines:
- \`maxPositionPct\`: Maximum allocation % allowed for any single asset
- \`stopLossPct\`: Trigger a full exit if an asset drops this % from entry price
- \`trailingStopPct\`: Trigger a full exit if an asset drops this % from its all-time peak price (protects unrealized gains — handled automatically by the watchdog)
- \`takeProfitLadder\`: Staged partial exits at multiple PnL thresholds (handled automatically — do not duplicate with manual sells)
- \`maxDrawdownPct\`: Halt all trading if portfolio drawdown exceeds this %
- \`allowedAssets\`: Whitelist of token symbols permitted in the portfolio
- \`riskTier\`: conservative | moderate | aggressive

## Automatic Protections (already running — do not duplicate)
The watchdog runs every 30 seconds and autonomously executes:
- Entry-based stop-loss (stopLossPct% below entry)
- Trailing stop-loss (trailingStopPct% below peak price)
- Profit ladder (staged sells at each takeProfitLadder rung)
When you see holdings with high PnL, some ladder rungs may already have been executed.
Factor this into your reasoning — if a position is already partially sold, you don't need to propose additional profit-taking at the same levels.

## Swap vs Buy/Sell
Use a **swap** when rotating capital directly from one token into another — no USDC required. This is the preferred action when:
- Exiting a stalled or declining position to enter a better opportunity in one atomic move
- USDC cash is at or near the cash floor (no dry powder for a separate buy)
- You want to redeploy, not hold idle cash between cycles

Use **sell** when exiting to USDC with no immediate replacement target (de-risking, waiting for setup).
Use **buy** when deploying existing USDC cash into a new position.

A swap trades fromAsset tokens → toAsset tokens directly via Jupiter. The amountUsd is the USD value of the position being exited from fromAsset.

## Decision Format
CRITICAL: Your entire response MUST be a single valid JSON object. No prose before it, no prose after it, no markdown fences, no explanation. Start your response with { and end with }. If you write anything other than a JSON object, the system will crash.

Schema:
{
  "action": "hold" | "rebalance" | "buy" | "sell" | "alert",
  "rationale": "<concise explanation, 1-3 sentences>",
  "trades": [
    {
      "type": "buy" | "sell" | "swap",
      "asset": "<token symbol>",          // buy/sell only — omit for swap
      "fromAsset": "<token to exit>",     // swap only — omit for buy/sell
      "toAsset": "<token to enter>",      // swap only — omit for buy/sell
      "amountUsd": <number>,
      "reason": "<why this specific trade>"
    }
  ],
  "riskFlags": ["<any mandate violations or concerns>"],
  "confidence": <0.0 to 1.0>
}

If action is "hold", trades array must be empty.
If action is "alert", include a riskFlags entry describing the alert condition.
Never recommend trades that violate the active mandate.`;

// ─── Sector map ───────────────────────────────────────────────────────────────
// Tags known Solana-ecosystem tokens by narrative sector.
// Unknown tokens default to 'emerging' — still included in sector roll-up.

const SECTOR_TAGS = {
  // Layer 1
  SOL: 'L1', ETH: 'L1', BTC: 'L1', SUI: 'L1', APT: 'L1', SEI: 'L1', NEAR: 'L1', AVAX: 'L1',
  // DEX / DeFi
  JUP: 'DEX', RAY: 'DEX', ORCA: 'DEX', DRIFT: 'DEX', MNGO: 'DEX', KAMINO: 'DEX', STEP: 'DEX',
  // Meme
  BONK: 'meme', WIF: 'meme', POPCAT: 'meme', MYRO: 'meme', BOME: 'meme', SAMO: 'meme',
  SLERF: 'meme', PNUT: 'meme', FWOG: 'meme', MOODENG: 'meme', DOGE: 'meme', SHIB: 'meme',
  PEPE: 'meme', FLOKI: 'meme', MEW: 'meme', RETARDIO: 'meme', GIGA: 'meme',
  // AI / DePIN
  RENDER: 'AI/DePIN', RNDR: 'AI/DePIN', HNT: 'AI/DePIN', IO: 'AI/DePIN', TAO: 'AI/DePIN',
  FET: 'AI/DePIN', GOAT: 'AI/DePIN', ARC: 'AI/DePIN', ZEREBRO: 'AI/DePIN', AI16Z: 'AI/DePIN',
  VIRTUAL: 'AI/DePIN', GRASS: 'AI/DePIN', WLD: 'AI/DePIN',
  // Gaming
  BEAM: 'gaming', IMX: 'gaming', GALA: 'gaming', PRIME: 'gaming',
  // Oracle / Infrastructure
  PYTH: 'infra', LINK: 'infra', JTO: 'infra', JITO: 'infra',
  // Liquid staking
  MSOL: 'liquid-stake', BSOL: 'liquid-stake', JSOL: 'liquid-stake',
  // DeSci
  BIO: 'DeSci',
  // Stable
  USDC: 'stable', USDT: 'stable', DAI: 'stable',
};

// ─── Trading session ──────────────────────────────────────────────────────────

function tradingSession() {
  const h = new Date().getUTCHours();
  const day = new Date().getUTCDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return 'Weekend (lower liquidity, wider spreads)';
  if (h >= 13 && h < 16) return 'US Open (high volatility, best liquidity)';
  if (h >= 16 && h < 20) return 'US Afternoon (momentum continuation or reversal)';
  if (h >= 20 && h < 24) return 'US Close / Overnight (declining volume)';
  if (h >=  2 && h <  9) return 'Asian Session (lower volume, range-bound)';
  if (h >=  9 && h < 13) return 'European Session (volume building, pre-US)';
  return 'Off-hours (thin liquidity)';
}

/**
 * Builds the user-turn context message from live portfolio + market state.
 *
 * @param {object} params
 * @param {object} params.portfolio  - Current holdings and performance
 * @param {object} params.market     - Price/volume data for relevant assets
 * @param {object} params.mandate    - Active risk mandate rules
 * @param {string} [params.trigger]  - What initiated this reasoning cycle
 * @returns {string} Formatted context string for the user message
 */
export function buildContext({ portfolio, market, mandate, trigger = 'scheduled_review', trailingData = null, stopCooldowns = [], blockedBuys = [], recentTrades = [] }) {
  const portfolioLines = portfolio.holdings
    .filter(h => !h.unpriced) // skip tokens with no market price — can't trade or value them
    .map(h => {
      const pct    = ((h.valueUsd / portfolio.totalValueUsd) * 100).toFixed(1);
      const pnl    = h.pnlPct >= 0 ? `+${h.pnlPct.toFixed(2)}%` : `${h.pnlPct.toFixed(2)}%`;
      const hwm    = trailingData?.highWaterMarks?.[h.symbol];
      const hwmStr = hwm ? `, peak: $${hwm}` : '';
      const hitRungs = trailingData?.ladderTriggered?.[h.symbol] ?? [];
      const ladderStr = hitRungs.length > 0 ? `, ladder rungs hit: ${hitRungs.map(i => i + 1).join(',')}` : '';
      return `  - ${h.symbol}: $${h.valueUsd.toLocaleString()} (${pct}% of portfolio, PnL: ${pnl}, entry: $${h.entryPrice}, current: $${h.currentPrice}${hwmStr}${ladderStr})`;
    })
    .join('\n');

  // Market lines: only held tokens get full detail.
  // Non-held tokens are shown only if they appear in the top momentum movers — keeps context focused.
  const heldSymbols = new Set(portfolio.holdings.map(h => h.symbol).filter(Boolean));

  function tokenLine(symbol, data) {
    const extras = [];
    if (data.change1h  != null)    extras.push(`1h: ${data.change1h  >= 0 ? '+' : ''}${data.change1h.toFixed(2)}%`);
    if (data.change24h != null)    extras.push(`24h: ${data.change24h >= 0 ? '+' : ''}${data.change24h.toFixed(2)}%`);
    if (data.volume24hUsd != null) extras.push(`vol: $${(data.volume24hUsd / 1e6).toFixed(1)}M`);
    if (data.marketCapUsd != null) extras.push(`mcap: $${(data.marketCapUsd / 1e6).toFixed(0)}M`);
    if (data.apy != null)          extras.push(`best pool APY: ${data.apy.toFixed(2)}%`);
    const suffix = extras.length > 0 ? ` (${extras.join(', ')})` : '';
    return `  - ${symbol}: $${data.price?.toLocaleString() ?? 'n/a'}${suffix}`;
  }

  const marketLines = Object.entries(market)
    .filter(([symbol]) => heldSymbols.has(symbol))
    .map(([symbol, data]) => tokenLine(symbol, data))
    .join('\n');

  // Correlation detection — flag systemic moves across holdings
  const holdingSymbols = portfolio.holdings.map(h => h.symbol);
  const moves = holdingSymbols.map(s => market[s]?.change24h).filter(c => c != null);
  const downCount = moves.filter(c => c < -3).length;
  const upCount   = moves.filter(c => c > 3).length;
  let correlationNote = '';
  if (downCount >= 3) {
    correlationNote = `\n⚠ SYSTEMIC RISK: ${downCount}/${holdingSymbols.length} holdings down >3% in 24h simultaneously — likely macro or sector-level event. Consider reducing overall exposure.`;
  } else if (upCount >= 3) {
    correlationNote = `\n📈 CORRELATED UPSIDE: ${upCount}/${holdingSymbols.length} holdings up >3% in 24h — consider taking partial profits to rebalance.`;
  }

  // ── Market regime classifier ───────────────────────────────────────────────
  const solData   = market['SOL'];
  const sol1h     = solData?.change1h  ?? 0;
  const sol24h    = solData?.change24h ?? 0;
  const sol7d     = solData?.change7d  ?? null;

  let regime, regimeNote;
  if (sol7d !== null) {
    if      (sol7d > 15  && sol24h > 0)  { regime = 'BULL RUN';    regimeNote = 'Strong uptrend. Ecosystem tokens leading. Size up on high-conviction setups.'; }
    else if (sol7d > 5   && sol24h >= 0) { regime = 'RECOVERY';    regimeNote = 'Recovering from recent low. Momentum building. Good time to accumulate leaders.'; }
    else if (sol7d > 5   && sol24h < -3) { regime = 'PULLBACK';    regimeNote = 'Bull pullback — 7d positive but short-term cooling. Consider reducing exposure or waiting for confirmation.'; }
    else if (sol7d < -20)                { regime = 'BEAR MARKET'; regimeNote = 'Sustained downtrend. Capital preservation priority. Only trade with very high conviction.'; }
    else if (sol7d < -8)                 { regime = 'CORRECTION';  regimeNote = 'Meaningful correction underway. Be selective. Wait for stabilization before adding exposure.'; }
    else if (Math.abs(sol7d) <= 5 && Math.abs(sol24h) > 4) { regime = 'VOLATILE';   regimeNote = 'Choppy with large swings. Momentum trades valid but exits must be quick.'; }
    else                                 { regime = 'CONSOLIDATION'; regimeNote = 'Range-bound. No clear directional bias. Prefer tokens with independent catalysts.'; }
  } else {
    regime = sol1h > 2 ? 'RISK-ON' : sol1h < -2 ? 'RISK-OFF' : 'NEUTRAL';
    regimeNote = '7d data unavailable — reading from short-term momentum only.';
  }

  const marketPulse = [
    `REGIME: ${regime} — ${regimeNote}`,
    solData ? `SOL: ${sol1h >= 0 ? '+' : ''}${sol1h.toFixed(2)}% (1h)  ${sol24h >= 0 ? '+' : ''}${sol24h.toFixed(2)}% (24h)${sol7d !== null ? `  ${sol7d >= 0 ? '+' : ''}${sol7d.toFixed(2)}% (7d)` : ''}` : '',
    `Session: ${tradingSession()}`,
  ].filter(Boolean).join('\n');

  // ── Sector performance summary ─────────────────────────────────────────────
  const sectorBuckets = {};
  for (const [sym, data] of Object.entries(market)) {
    if (data.change24h == null) continue;
    const sector = SECTOR_TAGS[sym] ?? 'emerging';
    if (!sectorBuckets[sector]) sectorBuckets[sector] = [];
    sectorBuckets[sector].push(data.change24h);
  }
  const sectorSummary = Object.entries(sectorBuckets)
    .filter(([, vals]) => vals.length >= 2)
    .map(([sector, vals]) => {
      const avg = vals.reduce((s, v) => s + v, 0) / vals.length;
      return { sector, avg, count: vals.length };
    })
    .sort((a, b) => b.avg - a.avg)
    .map(({ sector, avg, count }) =>
      `  ${sector.padEnd(12)} ${avg >= 0 ? '+' : ''}${avg.toFixed(1)}%  (${count} tokens)`
    );

  // ── Momentum signal ────────────────────────────────────────────────────────
  const allTokens = Object.entries(market)
    .filter(([, d]) => d.change1h != null && d.volume24hUsd != null && d.volume24hUsd > 0)
    .map(([symbol, d]) => ({ symbol, change1h: d.change1h, change24h: d.change24h ?? 0, change7d: d.change7d ?? null, volume24hUsd: d.volume24hUsd, spikeRatio: d.spikeRatio ?? null }));

  const sortedByMomentum = [...allTokens].sort((a, b) => b.change1h - a.change1h);

  function convictionStars(t) {
    const spike = t.spikeRatio ?? 1;
    if (t.change1h > 5 && t.change24h > 10 && spike >= 2) return '★★★';
    if (t.change1h > 3 && t.change24h > 5  || spike >= 2) return '★★ ';
    return '★  ';
  }

  const topMovers = sortedByMomentum
    .filter(t => !heldSymbols.has(t.symbol))
    .slice(0, 15)
    .map(t => {
      const d = market[t.symbol];
      const mcap  = d?.marketCapUsd ? `  mcap: $${(d.marketCapUsd / 1e6).toFixed(0)}M` : '';
      const spike = t.spikeRatio != null ? `  vol×${t.spikeRatio.toFixed(1)}` : '';
      return `  ${convictionStars(t)} ${t.symbol.padEnd(8)} 1h: ${t.change1h >= 0 ? '+' : ''}${t.change1h.toFixed(2)}%  24h: ${t.change24h >= 0 ? '+' : ''}${t.change24h.toFixed(2)}%${mcap}${spike}`;
    });

  const bottomMovers = sortedByMomentum
    .slice(-8).reverse()
    .map(t => `  ${t.symbol.padEnd(8)} 1h: ${t.change1h >= 0 ? '+' : ''}${t.change1h.toFixed(2)}%  24h: ${t.change24h >= 0 ? '+' : ''}${t.change24h.toFixed(2)}%`);

  // ── New launch signals: high turnover ratio (volume / market cap) ─────────
  // Turnover > 50% = token is being heavily traded relative to its size.
  // This is the fingerprint of a new launch gaining momentum.
  const newLaunchSignals = Object.entries(market)
    .filter(([, d]) => {
      if (!d.volume24hUsd || !d.marketCapUsd || d.marketCapUsd <= 0) return false;
      const turnover = (d.volume24hUsd / d.marketCapUsd) * 100;
      // Must be gaining traction (not being dumped) + small enough to be a real new launch
      const gaining = (d.change1h ?? 0) > 0 || (d.change24h ?? 0) > 0;
      const smallCap = d.marketCapUsd < 50_000_000;
      return turnover >= 50 && gaining && smallCap && !heldSymbols.has(d.symbol ?? '');
    })
    .map(([symbol, d]) => {
      const turnover = ((d.volume24hUsd / d.marketCapUsd) * 100).toFixed(0);
      const mcap     = `$${(d.marketCapUsd / 1e6).toFixed(2)}M`;
      const ch1h     = d.change1h  != null ? ` 1h: ${d.change1h  >= 0 ? '+' : ''}${d.change1h.toFixed(2)}%` : '';
      const ch24h    = d.change24h != null ? ` 24h: ${d.change24h >= 0 ? '+' : ''}${d.change24h.toFixed(2)}%` : '';
      const spike    = d.spikeRatio != null ? ` vol×${d.spikeRatio.toFixed(1)}` : '';
      return { symbol, turnover: parseFloat(turnover), line: `  ${symbol.padEnd(8)} mcap: ${mcap}  turnover: ${turnover}%${ch1h}${ch24h}${spike}` };
    })
    .sort((a, b) => b.turnover - a.turnover)
    .slice(0, 10)
    .map(t => t.line);

  // ── New launches from DexScreener ($5K–$2M cap, < 48h old) ─────────────────
  const newLaunches = Object.entries(market)
    .filter(([, d]) => d._dexscreener && d.ageHours != null && !heldSymbols.has(d.symbol ?? ''))
    .sort((a, b) => (b[1].volume1hUsd ?? 0) - (a[1].volume1hUsd ?? 0))
    .slice(0, 12)
    .map(([symbol, d]) => {
      const age    = d.ageHours < 1 ? `${Math.round(d.ageHours * 60)}m` : `${d.ageHours.toFixed(0)}h`;
      const ch1h   = d.change1h  != null ? ` 1h: ${d.change1h  >= 0 ? '+' : ''}${d.change1h.toFixed(1)}%` : '';
      const ch24h  = d.change24h != null ? ` 24h: ${d.change24h >= 0 ? '+' : ''}${d.change24h.toFixed(1)}%` : '';
      const mcap   = d.marketCapUsd
        ? d.marketCapUsd >= 1_000_000
          ? ` mcap: $${(d.marketCapUsd / 1_000_000).toFixed(2)}M`
          : ` mcap: $${(d.marketCapUsd / 1_000).toFixed(0)}K`
        : '';
      const vol1h  = d.volume1hUsd  ? ` vol1h: $${(d.volume1hUsd / 1_000).toFixed(1)}K` : '';
      const bs     = d.buySellRatio != null ? ` bs: ${(d.buySellRatio * 100).toFixed(0)}% buys` : '';
      const dex    = d.dex ? ` [${d.dex}]` : '';
      // Social presence: TW=Twitter, TG=Telegram, WEB=website
      // Pre-graduation pump.fun tokens never have socials — suppress the label to avoid misleading Claude
      const socials = [
        d.hasTwitter  ? 'TW'  : null,
        d.hasTelegram ? 'TG'  : null,
        d.hasWebsite  ? 'WEB' : null,
      ].filter(Boolean);
      const socialStr = d._pumpfun
        ? ''  // no-social is expected on bonding curve — don't show label
        : socials.length > 0 ? ` [${socials.join('+')}]` : ' [no-social]';
      const desc = d.description ? `\n    "${d.description}"` : '';
      return `  ${symbol.padEnd(10)} age: ${age.padEnd(4)}${mcap}${vol1h}${ch1h}${ch24h}${bs}${dex}${socialStr}${desc}`;
    });

  // Sustained momentum: strong on BOTH 1h and 24h (narrative in motion, not just a candle spike)
  const sustainedMovers = allTokens
    .filter(t => t.change1h > 3 && t.change24h > 5 && !heldSymbols.has(t.symbol))
    .sort((a, b) => (b.change1h + b.change24h) - (a.change1h + a.change24h))
    .slice(0, 8)
    .map(t => {
      const stars = convictionStars(t);
      const spike = t.spikeRatio != null ? `  vol×${t.spikeRatio.toFixed(1)}` : '';
      return `  ${stars} ${tokenLine(t.symbol, market[t.symbol])}${spike}`;
    });

  // ── Position health: fade detection + stale rotation candidates ───────────
  const fadingPositions = [];
  const stalePositions  = [];

  for (const h of portfolio.holdings) {
    if (!h.symbol || h.symbol === 'USDC' || h.symbol === 'SOL') continue;
    const d = market[h.symbol];
    if (!d) continue;

    const change1h  = d.change1h  ?? 0;
    const change24h = d.change24h ?? 0;

    // Momentum fading: was running but now reversing
    const wasBullish   = change24h > 5;
    const nowReversing = change1h < -2;
    const spikeDown    = d.spikeRatio != null && d.spikeRatio > 1.5 && change1h < 0;

    if (wasBullish && nowReversing) {
      fadingPositions.push(`  ⚠ ${h.symbol}: 24h was +${change24h.toFixed(1)}% but 1h now ${change1h.toFixed(1)}% — momentum fading, consider exit`);
    } else if (spikeDown) {
      fadingPositions.push(`  ⚠ ${h.symbol}: 1h ${change1h.toFixed(1)}% on elevated volume (×${d.spikeRatio.toFixed(1)}) — selling pressure, consider exit`);
    }

    // Stale: no meaningful momentum in either direction — capital is sitting idle
    const isStale = change1h > -1 && change1h < 1 && change24h > -3 && change24h < 3;
    const isDeclining = change24h < -5 || (change24h < -2 && change1h < -1);

    if (isDeclining) {
      stalePositions.push(`  🔴 ${h.symbol}: declining (1h ${change1h >= 0 ? '+' : ''}${change1h.toFixed(1)}%, 24h ${change24h >= 0 ? '+' : ''}${change24h.toFixed(1)}%) — no momentum, strong rotation candidate`);
    } else if (isStale) {
      stalePositions.push(`  🟡 ${h.symbol}: flat/stale (1h ${change1h >= 0 ? '+' : ''}${change1h.toFixed(1)}%, 24h ${change24h >= 0 ? '+' : ''}${change24h.toFixed(1)}%) — capital sitting idle, consider rotating to active narrative`);
    }
  }

  // ── Recent trade history + re-buy friction ────────────────────────────────
  const now60 = Date.now() - 60 * 60 * 1000; // 60 min ago

  // Symbols bought in the last 60 min — flag for re-buy scrutiny
  const recentlyBought = new Map(); // symbol → { minsAgo, stars }
  for (const t of recentTrades) {
    const sym = t.type === 'swap' ? t.toAsset : t.asset;
    if (!sym || (t.type !== 'buy' && t.type !== 'swap')) continue;
    const ts = t.time ? new Date(t.time).getTime() : 0;
    if (ts > now60) {
      const minsAgo = Math.round((Date.now() - ts) / 60_000);
      const mdata   = market[sym];
      const stars   = mdata ? convictionStars({ change1h: mdata.change1h ?? 0, change24h: mdata.change24h ?? 0, spikeRatio: mdata.spikeRatio ?? null }) : '★  ';
      if (!recentlyBought.has(sym)) recentlyBought.set(sym, { minsAgo, stars });
    }
  }

  const rebuyWarnings = [...recentlyBought.entries()].map(([sym, { minsAgo, stars }]) => {
    const currentStars = stars.trim();
    const d = market[sym];
    const spike = d?.spikeRatio != null ? `vol×${d.spikeRatio.toFixed(1)}` : null;
    let verdict;
    if (currentStars === '★★★' && spike) {
      verdict = `may add — ★★★ signal with ${spike} confirms new momentum since entry`;
    } else if (currentStars === '★★★') {
      verdict = `may add — ★★★ signal, but verify volume spike confirms new momentum (not just continuation)`;
    } else {
      verdict = `DO NOT add — no new signal since you bought. "Still looks good" is not a reason. Find a better opportunity.`;
    }
    return `  ⚠ ${sym} bought ${minsAgo}m ago — ${verdict}`;
  });

  const recentTradeLines = recentTrades.map(t => {
    const time  = t.time ? new Date(t.time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) : '??:??';
    const label = t.type === 'swap' ? `SWAP ${t.fromAsset ?? '?'} → ${t.toAsset ?? '?'}` : `${(t.type ?? '?').toUpperCase()} ${t.asset ?? '?'}`;
    return `  ${time}  ${label}  $${(t.amountUsd ?? 0).toFixed(2)}`;
  });

  // ── Recently sold tokens — flag re-entries within 2h ─────────────────────
  const now120 = Date.now() - 2 * 60 * 60 * 1000;
  const recentlySold = new Map();
  for (const t of recentTrades) {
    const sym = t.type === 'swap' ? t.fromAsset : t.asset;
    if (!sym || (t.type !== 'sell' && t.type !== 'swap')) continue;
    const ts = t.time ? new Date(t.time).getTime() : 0;
    if (ts > now120) {
      const minsAgo = Math.round((Date.now() - ts) / 60_000);
      if (!recentlySold.has(sym)) recentlySold.set(sym, minsAgo);
    }
  }
  const recentSellWarnings = [...recentlySold.entries()].map(([sym, minsAgo]) =>
    `  ⛔ ${sym} sold ${minsAgo}m ago — DO NOT re-enter unless a completely new ★★★ signal with volume spike has appeared since the exit. "It's still running" is not enough.`
  );

  const drawdown = portfolio.peakValueUsd > 0
    ? (((portfolio.peakValueUsd - portfolio.totalValueUsd) / portfolio.peakValueUsd) * 100).toFixed(2)
    : '0.00';

  // ── Deployable USDC ───────────────────────────────────────────────────────
  const cashFloor      = ((mandate.minCashPct ?? 0) / 100) * portfolio.totalValueUsd;
  const deployableUsdc = Math.max(0, (portfolio.cashUsd ?? 0) - cashFloor);

  const universeSize = Object.keys(market).length;

  return `## Trigger
${trigger}

## Market Regime (${universeSize} tokens analyzed)
${marketPulse}

## Sector Performance (24h avg)
${sectorSummary.join('\n') || '  No sector data'}

## Momentum Leaders — top 15 by 1h, not held (★★★ = strong conviction)
${topMovers.join('\n') || '  No data'}

## Sustained Movers — 1h >3% AND 24h >5% (narrative in motion, not held)
${sustainedMovers.join('\n') || '  None meeting threshold'}

## New Launch Signals — turnover >50%, gaining, under $50M cap (not held)
High turnover = heavy trading relative to size on a token still gaining price — the fingerprint of early discovery.
All entries here are price-positive (1h or 24h up) so you are NOT looking at dumps.
Small position sizing for micro-caps ($1M–$5M cap). These move fast — take profit at +20–30% and redeploy.
${newLaunchSignals.join('\n') || '  None meeting threshold'}

## DexScreener New Launches — $5K–$2M cap, < 48h old
Two sub-categories. Social presence shown: [TW=Twitter, TG=Telegram, WEB=website, no-social=anonymous].
Evaluate: narrative fit + social legitimacy + momentum. Max size $5–$10. Exit at +30–50%. Stop at -8%.

### Graduated (Raydium/Orca/Meteora) — buy via Jupiter using USDC
${newLaunches.filter(l => !l.includes('[pump-fun]')).join('\n') || '  None right now'}

### Pre-graduation (pump.fun bonding curve) — executor routes directly, uses SOL, no Jupiter needed
Bonding curve fills at ~$69K SOL raised — graduation imminent as that threshold approaches.
${newLaunches.filter(l => l.includes('[pump-fun]')).join('\n') || '  None right now'}

## Momentum Laggards — bottom 8 by 1h
${bottomMovers.join('\n') || '  No data'}
${fadingPositions.length > 0 ? `\n## Position Alerts — Momentum Fading (consider exit)\n${fadingPositions.join('\n')}` : ''}
${stalePositions.length > 0 ? `\n## Rotation Candidates — Stale/Declining Positions\nThese holdings have no active momentum. The 400-token universe has better opportunities right now. Exit these and redeploy.\n${stalePositions.join('\n')}` : ''}
## Portfolio State
Total Value:      $${portfolio.totalValueUsd.toLocaleString()}
Peak Value:       $${portfolio.peakValueUsd.toLocaleString()}
Drawdown:         ${drawdown}%
Cash (USDC):      $${portfolio.cashUsd.toLocaleString()}
Deployable USDC:  $${deployableUsdc.toFixed(2)} (after ${mandate.minCashPct ?? 0}% cash floor)
Suggested sizing: $${(deployableUsdc * 0.25).toFixed(2)}–$${(deployableUsdc * 0.35).toFixed(2)} per position (25–35% of deployable)
${deployableUsdc > portfolio.totalValueUsd * 0.4 ? `⚠ CAPITAL IDLE: Over 40% of portfolio is deployable USDC. If ANY ★★ or ★★★ signal exists, you MUST deploy. Holding cash when clear momentum signals are present is a guaranteed loss of opportunity.` : ''}

Holdings:
${portfolioLines}

## Current Positions — Market Detail
${marketLines || '  No held token market data available'}

## Market Notes${correlationNote || '\nNo correlated moves detected.'}
${recentTradeLines.length > 0 ? `\n## Recent Trades (your last ${recentTradeLines.length})\n${recentTradeLines.join('\n')}` : ''}
${recentSellWarnings.length > 0 ? `\n## Recently Sold — Re-Entry Block (last 2h)\n${recentSellWarnings.join('\n')}` : ''}${rebuyWarnings.length > 0 ? `\n## Re-Buy Scrutiny — tokens bought in the last 60 min\nValid reasons to add: (1) new ★★★ signal with volume spike that wasn't present at entry, (2) sector narrative just ignited and this is the leader, (3) price held support and bounced with volume after your buy. NOT valid: "still looks good", "below max allocation", "momentum continuing".\n${rebuyWarnings.join('\n')}` : ''}

## Active Mandate
Risk Tier:       ${mandate.riskTier}
Max Position:    ${mandate.maxPositionPct}%
Min Cash (USDC): ${mandate.minCashPct ?? 0}% of portfolio must stay as dry powder (enforced for USDC buys — pump.fun buys use SOL and are exempt)
Stop-Loss:       ${mandate.stopLossPct}% from entry — ${mandate.microCapStopLossPct ? `${mandate.microCapStopLossPct}% for tokens under $${(mandate.microCapThresholdUsd / 1e6).toFixed(0)}M market cap` : 'uniform'} (watchdog auto-executes)
Trailing Stop:   ${mandate.trailingStopPct ?? 'not set'}% from peak price (watchdog auto-executes)
Profit Ladder:   ${mandate.takeProfitLadder?.map((r, i) => `rung ${i + 1}: sell ${(r.sellFraction * 100).toFixed(0)}% at +${r.pct}%`).join(', ') ?? 'not set'} (watchdog auto-executes)
Max Drawdown:    ${mandate.maxDrawdownPct}%
SOL Reserve:     SOL is GAS ONLY — never propose buying or selling SOL. It is not a tradeable position.
Min Market Cap:  $${mandate.minMarketCapUsd ? (mandate.minMarketCapUsd / 1e6).toFixed(0) + 'M' : 'none'} (tokens below this are blocked)
Min Volume:      ${mandate.minVolume24hUsd ? (mandate.minVolume24hUsd >= 1_000_000 ? `$${(mandate.minVolume24hUsd/1e6).toFixed(1)}M` : `$${(mandate.minVolume24hUsd/1000).toFixed(0)}K`) : 'none'}/day (illiquid tokens blocked for buys)
${mandate.notes ? `Notes: ${mandate.notes}` : ''}
${stopCooldowns.length > 0 ? `\n## Stop-Loss Re-Entry Cooldowns (DO NOT BUY THESE)\n${stopCooldowns.map(c => `  - ${c.symbol}: blocked for ${c.minsRemaining} more minutes after recent stop-out`).join('\n')}` : ''}
${blockedBuys.length > 0 ? `\n## Permanently Blocked Buys (NEVER BUY OR SWAP INTO THESE)\n${blockedBuys.map(s => `  - ${s}`).join('\n')}` : ''}
Analyze this state and return your decision as a raw JSON object. Start with { and end with }. No other text.`;
}
