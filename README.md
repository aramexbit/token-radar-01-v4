# Token Radar v4

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/aramexbit/token-radar-01-v4/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/aramexbit/token-radar-01-v4/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A radar for token launches that have not happened yet. It reads a sealed snapshot of every protocol DefiLlama tracks, finds the ones whose record carries no token, and ranks them by what a launch would be worth if their record stayed as it is — each with a concrete eight-step, day-by-day farm plan that is netted to the dollar: expected value minus gas minus fees, with a farm / thin / skip verdict.

## The model

The value comes from the market itself, not from a list of names. Across the 128 live-token protocols that carry both a market cap and a TVL, the radar fits log market cap against log TVL: one line per category where at least five comps exist, shrunk toward the global line (weight n/(n+10), slope capped at 1) and re-anchored at the category's own centroid; categories with one to four comps get a median market-cap-to-TVL ratio instead, shrunk in log space toward the global median with the same prior. Each pre-token protocol is then read through its category's line, bent by its seven-day TVL move (a 0.8–1.2 multiplier) and by how long it has run with no token (0.85–1.0, wearing off on a log scale over five years), and capped at ten times its TVL.

That curve is unchanged from v3, deliberately. A shrinkage shootout on 17 November 2026 tested four alternatives against it on the same leave-one-out, blind time-split and walk-forward errors — slope shrinkage for all categories, intercept shrinkage, a 1-observation prior, and a pure global baseline:

| variant | LOO medErr / in-2× | blind split medErr / in-2× | walk-forward medErr / in-2× |
|---|---|---|---|
| v3 (shipped) | 89.0% / 28.9% | 91.7% / 25.0% | 79.6% / 33.3% |
| slope shrinkage, all categories | 87.4% / 24.2% | 94.7% / 20.8% | 89.7% / 29.8% |
| intercept shrinkage | 86.4% / 30.5% | 92.0% / 22.9% | 77.3% / 36.8% |
| 1-observation prior | 88.6% / 28.1% | 97.8% / 18.8% | 89.7% / 26.3% |
| global baseline | 85.2% / 32.0% | 88.0% / 35.4% | 84.4% / 36.8% |

No variant beat the v3 fit by 5 points on leave-one-out or on the blind split (best: global baseline, −3.8 and −3.7 points), so the v3 model ships again. Most of the ~90% error is dispersion between comps, not fit — the dashboard says so on the page, next to the numbers, and shows the uncertainty instead of hiding it.

## Validation, layered

Four honest numbers, all on the dashboard:

- **Leave-one-out** on 128 comps: median error 89.0%, 28.9% predicted within 2×.
- **Blind / out-of-sample time split** (cutoff 2024-02-18, train 47 / test 48, the test half never seen while fitting): median error 91.7%, 25.0% within 2×.
- **Walk-forward** (fit on earlier listings, test on later ones, three expanding windows): pooled over 57 held-out comps, median error 79.6%, 33.3% within 2×. Per fold: train 38 / test 19 → 55.7% / 52.6%; train 57 / test 19 → 96.9% / 21.1%; train 76 / test 19 → 96.5% / 26.3%.
- **Bootstrap**: 200 refits (comps resampled with replacement, seed 20261117) give every row a value band (10th–90th percentile) and a rank range (5th–95th percentile), shown on the board in compact form and in full in each detail view. The implied values are a ranking, not a price.

## Netted farm economics

Each protocol carries a net farm value, in one line:

> net = expected − gas − fees, where expected = bootstrap band low (p10) × deposit ÷ TVL, gas = 6 tx × cheapest-chain gas, fees = 0.5% of deposit (stated assumption).

The expected value uses the low end of the bootstrap band on purpose: a farm that only pays at the point estimate is not a farm. The verdict is **farm** when the net clears $25 and at least twice the costs, **thin** when it is positive but small, and **skip** when it is zero or negative. Across the board: 15 farm, 158 thin, 25 skip. The gas table names every one of the 120 chains on the board — no chain falls back to a default gas label.

## The board

198 pre-token protocols make the board, including all 40 on the snapshot's watchlist. The top of the board is led by the big risk curators — Sentora Curator at about $719M implied (net +$27.77, farm), Steakhouse Financial at about $676M (net +$25.80, farm), Gauntlet at about $418M (net +$38.28, farm) — with USDD fourth at about $191M but a skip verdict: its bootstrap band collapses to $1.1M at the low end, so its net is −$5.09. Every row shows its fit quality (`n=X comps`, thin-fit styling below 5 comps), its implied/TVL ratio as a coloured pill, its value band and rank range, its net figure and its verdict — and the ratio column sorts.

Each row carries an eight-step farm plan, Day 1 to Day 56, deposit-sized by TVL tier (under $100M → $25–100; $100M–1B → $100–500; over $1B → $500–2,000), with the protocol's own name in step 1, a tenure note from its days unlaunched, a cadence modifier from its 7-day TVL move, and its second-cheapest chain as a fallback route. All 198 step sets are distinct, and no step invents a pool, a vault name, an APY or a token. The dashboard itself is a static page: search, chain and category filters, sortable columns (including ratio and net), a live-token table to check the board against what already trades, and a detail view per protocol with the full breakdown — curve value, fit, growth and age factors, the 10× TVL cap, the bootstrap band and rank range, the netting arithmetic — and the same one-line verdict the model computes.

## Run

```sh
MAKEFUN_OUTPUT_DIR=out node main.ts --input path/to/snapshot.json
```

That writes `out/board.json`, `out/data.js`, copies `dashboard/` and `screenshots/` into `out/`, and writes `out/dossier.json` with `buildDossier` from `vendor/makefun-board.ts`. Node 22 or later, standard library only, no install step. The program is deterministic: two runs write byte-identical output (bootstrap refits are seeded).

## License

MIT — see `LICENSE`.

<sub>Entered on [make.fun](https://make.fun/?ref=rrcbfccn&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
