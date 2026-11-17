# token-radar-01

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Damon-Xu7890/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Damon-Xu7890/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token launch radar — ranks 198 pre-token DeFi protocols by implied token value, estimated from a frozen DefiLlama snapshot (TVL, 7-day change, age since listing) with per-category market multiples, plus a concrete farming plan for each protocol and an offline dashboard.

## Run it

```sh
git clone https://github.com/Damon-Xu7890/token-radar-01.git
cd token-radar-01
node main.ts --input snapshot.json
```

`snapshot.json` is the frozen DefiLlama snapshot (758 protocols, 2026-11-14) that ships in the make.fun kit as `input/snapshot.json`. The build writes `board.json`, `data.js`, `dashboard/` and `screenshots/` to the output directory (`MAKEFUN_OUTPUT_DIR`, default `out/`).

## How it works

- **Model (radar-2):** per-category mcap/TVL median taken from live-token protocols, shrunk toward the global median (0.2227) with a prior weight of 8, clamped to [0.05, 1.0]. Implied value = TVL × anchor × momentum factor (7-day change, damped 0.6) × maturity factor (log age curve). Protocols with unknown listing age use 516 days, the median age of pre-token protocols.
- **Board (198 rows):** all 40 watchlist protocols plus 158 early pre-token protocols. Bridges, wrapped/staked products, exchanges and versioned pools are set aside with reasons instead of ranked — they cannot launch their own token. The top 24 live-token protocols are listed separately at market cap.
- **Dashboard:** fully offline (zero network requests), sortable/filterable/searchable, with a per-protocol detail drawer that re-derives the model step by step and shows a 7-step farming plan with costs and timing.

---

<sub>Entered on [make.fun](https://make.fun/?ref=yfbmvcwg&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
