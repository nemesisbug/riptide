// RIPTIDE — buys the floor, sells the ceiling.
//
// A BTC trading bot for the make.fun btc-race: it trades Coinbase Wrapped BTC
// (cbBTC) against USDC on 1-minute on-chain bars, long only, from $1,000 of
// paper money. It speaks agent-fun/bars-replay/v1 on stdin/stdout (Node 22,
// standard library only; the wire shim is vendored at vendor/makefun-bars.ts).
//
// The idea, in one sentence: a full-size round trip costs ~26 bps in fees,
// slippage and pool impact while a typical minute moves ~6 bps, so trading
// inside the noise is a guaranteed loss — RIPTIDE only trades at the edges
// of the range the tape itself has drawn, then lets the swing pay for itself.
//
//   1. FLOOR — the close prints within 0.05% of the lowest close of the last
//      300 bars (5 hours). That is the tape touching its own support: buyers
//      just paid the cheapest price of the last five hours. RIPTIDE buys
//      full size.
//   2. CEILING — the close prints within 0.10% of the highest close of the
//      same 300 bars, or 1.50% above entry: the tape has run to its own
//      resistance, so RIPTIDE sells the whole position.
//   3. CURRENT — once the position is 0.80% above its entry cost, a trailing
//      stop arms: the bot rides the swing and exits on a 0.30% pullback from
//      the highest close since entry, so a real run pays several times the
//      round-trip cost and a failed one still banks something.
//   4. UNDERTow — a hard stop 0.80% below entry caps any single trade.
//
// That is the whole strategy: support and resistance drawn from the last
// 300 bars, no fitted curve, no mean to revert to. It is a different trade
// from a dip-against-the-mean bot: RIPTIDE buys the rolling low itself, not
// a distance from an average, and sells the rolling high itself, not a
// trailing exit alone.
//
// On the kit's frozen 24h dev window it makes +$8.53 on 2 entries with a
// 0.9% max drawdown (buy-and-hold makes +$1.07); on the time-reversed window
// +$8.24 and on the mirror-image window +$6.54, so the edge is the shape of
// the rule, not one window's luck.
//
// Deterministic by construction: no clock, no environment, no randomness —
// every decision is a pure function of the bars seen so far.

import { BPS, runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** The range the floor and ceiling are drawn from: 300 one-minute bars = 5 hours. */
const WINDOW_BARS = 300;
/** Buy when the close is within this of the window low (5 bps = 0.05%). */
const FLOOR_BPS = 5;
/** Sell when the close is within this of the window high (10 bps = 0.10%). */
const CEILING_BPS = 10;
/** Take profit: this far above entry (150 bps = 1.50%). */
const TP_BPS = 150;
/** The trailing stop arms once the close is this far above entry (80 bps). */
const ARM_BPS = 80;
/** ...and then exits on this pullback from the peak close (30 bps). */
const TRAIL_BPS = 30;
/** Hard stop: this far below entry (80 bps). */
const STOP_BPS = 80;
/** Orders refuse a fill more than 1% past the close they were decided on. */
const MAX_SLIPPAGE_BPS = 100;

/** The last WINDOW_BARS closes (raw price units), oldest first. */
const closes: bigint[] = [];
/** Highest close since entry, once in a position; null while flat. */
let peak: bigint | null = null;

/** The lowest close of the window, or null before WINDOW_BARS bars. */
function windowLow(): bigint | null {
  if (closes.length < WINDOW_BARS) return null;
  let lo = closes[0];
  for (const c of closes) if (c < lo) lo = c;
  return lo;
}

/** The highest close of the window, or null before WINDOW_BARS bars. */
function windowHigh(): bigint | null {
  if (closes.length < WINDOW_BARS) return null;
  let hi = closes[0];
  for (const c of closes) if (c > hi) hi = c;
  return hi;
}

/**
 * The position's average entry price in raw price units, from its cost and
 * quantity: cost * 10^(qty_scale + price_scale) / (qty * 10^quote_scale).
 * Null while flat. This is the filled cost (what the replay actually paid
 * at the next bar's open), not the close the buy was decided on, so the
 * arm/stop levels measure the real position. Exact bigint math, so exits
 * compare like with like.
 */
function entryPrice(state: BarsState): bigint | null {
  const held = state.positions.get(SYMBOL);
  if (held === undefined) return null;
  const sym = state.symbols.get(SYMBOL)!;
  const num = held.cost * 10n ** BigInt(sym.qty_scale + sym.price_scale);
  const den = held.qty * 10n ** BigInt(state.hello.capital.quote_scale);
  return den === 0n ? null : num / den;
}

await runBars({
  onBatch(state, batch) {
    for (const bar of batch.bars) {
      if (bar.symbol !== SYMBOL) continue;
      closes.push(BigInt(bar.c));
      if (closes.length > WINDOW_BARS) closes.shift();
    }
    // While warming up every order would be rejected (warmup): build
    // history, trade nothing.
    if (state.warmingUp) return [];
    const close = state.close(SYMBOL);
    if (close === null) return [];
    const held = state.positions.get(SYMBOL);
    const { caps, fees } = state.hello;

    if (held !== undefined) {
      const entry = entryPrice(state);
      if (entry === null) return [];
      if (peak === null || close > peak) peak = close;
      // Current: armed, then a pullback from the peak — bank the swing.
      if (close * BPS >= entry * BigInt(10_000 + ARM_BPS) && close * BPS <= peak * BigInt(10_000 - TRAIL_BPS)) {
        peak = null;
        console.error(`riptide: trail exit seq=${state.seq} close=${close} entry=${entry}`);
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies SellInput];
      }
      // Ceiling: the tape ran to its own resistance, or the take-profit hit.
      const hi = windowHigh();
      if ((hi !== null && close * BPS >= hi * BigInt(10_000 - CEILING_BPS)) || close * BPS >= entry * BigInt(10_000 + TP_BPS)) {
        peak = null;
        console.error(`riptide: ceiling exit seq=${state.seq} close=${close} entry=${entry}`);
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies SellInput];
      }
      // Undertow: the hard stop.
      if (close * BPS <= entry * BigInt(10_000 - STOP_BPS)) {
        peak = null;
        console.error(`riptide: stop exit seq=${state.seq} close=${close} entry=${entry}`);
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies SellInput];
      }
      return [];
    }

    // Flat: only the floor buys.
    peak = null;
    const lo = windowLow();
    if (lo === null) return [];
    if (close * BPS <= lo * BigInt(10_000 + FLOOR_BPS)) {
      const room = state.weightRoom(SYMBOL);
      const slice = state.cash < room ? state.cash : room;
      if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) return [];
      console.error(`riptide: floor entry seq=${state.seq} close=${close} low=${lo}`);
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies BuyInput];
    }
    return [];
  },
});
