# riptide

[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/nemesisbug/riptide/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/nemesisbug/riptide/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)

**RIPTIDE** — buys the floor, sells the ceiling: a BTC trading bot that trades
Coinbase Wrapped BTC (cbBTC) against USDC on 1-minute on-chain bars, long
only, from $1,000 of paper money.

Built for the [make.fun bounty](https://make.fun/bounty/btc-race-24h-20261117-0603)
— referral code `w642jqgx`.

## Run it

```sh
node main.ts
```

`main.ts` speaks `agent-fun/bars-replay/v1` on stdin/stdout (Node 22,
standard library only; the wire shim is vendored at
`vendor/makefun-bars.ts`).

## The strategy

A full-size round trip costs ~26 bps in fees, slippage and pool impact
while a typical minute moves ~6 bps, so trading inside the noise loses
money on costs alone. RIPTIDE only trades at the edges of the range the
tape itself has drawn, then lets the swing pay for itself:

1. **Floor** — the close prints within 0.05% of the lowest close of the
   last 300 bars (5 hours). The tape is touching its own support: buyers
   just paid the cheapest price of the last five hours. RIPTIDE buys full
   size.
2. **Ceiling** — the close prints within 0.10% of the highest close of the
   same 300 bars, or 1.50% above entry. The tape has run to its own
   resistance, so RIPTIDE sells the whole position.
3. **Current** — once the position is 0.80% above its entry cost, a
   trailing stop arms: the bot rides the swing and exits on a 0.30%
   pullback from the highest close since entry.
4. **Undertow** — a hard stop 0.80% below entry caps any single trade.

Support and resistance drawn from the last 300 bars, no fitted curve, no
mean to revert to. Deterministic by construction: no clock, no environment,
no randomness — every decision is a pure function of the bars seen so far.

## Backtest (kit dev window, 24h)

Graded with the kit's own harness
(`node cli/makefun.mjs grade-local --kit . --bot . --driver process`),
two executions, byte-for-byte reproduced:

| | RIPTIDE | buy-and-hold |
|---|---|---|
| Net PnL | **+$8.53** | +$1.07 |
| Trades | 2 entries | 1 |
| Max drawdown | 0.9% | 2.1% |

Robustness checks on transformed copies of the same window (same rules,
same parameters): time-reversed +$8.24, mirror-image +$6.54 — the edge
is the shape of the rule, not one window's luck.
