// Token Radar v4 — entrypoint.
//
// Reads the sealed snapshot, fits the size curve on the live-token comps,
// ranks every eligible pre-token protocol by implied value, and writes the
// board, the dashboard data, the dashboard files, the screenshots and the
// dossier into the output directory. Node 22 standard library only.
//
// v4 additions over v3: walk-forward validation, a 200-refit bootstrap
// that puts a value band and a rank range on every row, netted farm
// economics (expected − gas − fees, farm / thin / skip), and deposit-sized
// day-by-day 8-step farm plans. The size curve itself is unchanged from v3.
//
// Usage: MAKEFUN_OUTPUT_DIR=out node main.ts --input path/to/snapshot.json
// Defaults: input /input/snapshot.json, output $MAKEFUN_OUTPUT_DIR or /output.

import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NET_FORMULA,
  PLANS,
  bootstrapBands,
  familyFor,
  farmChain,
  farmEconomics,
  farmStepsFor,
  fitAllCurves,
  gasCostUsd,
  hasGasEntry,
  impliedValue,
  isBoardEligible,
  leaveOneOut,
  loadSnapshot,
  secondChain,
  timeSplitTest,
  walkForwardTest,
} from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

// The repository root, from this file's own URL — never the working directory.
const ROOT = dirname(fileURLToPath(import.meta.url));

function argValue(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1]! : null;
}

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

function main(): void {
  const inputPath = argValue(process.argv.slice(2), '--input') ?? '/input/snapshot.json';
  const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  const snap = loadSnapshot(inputPath);

  // The comparables: live-token protocols that carry both a market cap and
  // a TVL, the only ones a size curve can be fitted on.
  const comps = snap.protocols.filter((p) => (p.mcap_usd ?? 0) > 0 && p.tvl_usd > 0);
  const curves = fitAllCurves(comps);
  const loo = leaveOneOut(comps);
  const split = timeSplitTest(comps);
  const walk = walkForwardTest(comps);

  // Score every eligible pre-token protocol and rank by implied value,
  // ties broken by slug so the order is stable across runs.
  const scored = snap.protocols
    .filter(isBoardEligible)
    .map((p) => ({ p, implied: impliedValue(p, curves, snap.as_of) }))
    .sort((a, b) => b.implied.value - a.implied.value || (a.p.slug < b.p.slug ? -1 : 1));
  const onBoard = new Set(scored.map((s) => s.p.slug));
  for (const slug of snap.watchlist) {
    if (!onBoard.has(slug)) throw new Error(`watchlist protocol missing from board: ${slug}`);
  }

  // Every chain on the board must have an explicit gas-table entry: a
  // protocol whose cheapest chain fell back to a default gas label would
  // be costed on invented numbers.
  for (const s of scored) {
    for (const chain of s.p.chains) {
      if (!hasGasEntry(chain)) throw new Error(`board chain missing from gas table: ${chain}`);
    }
  }

  // Bootstrap bands + rank ranges, in board order (seeded: deterministic).
  const bands = bootstrapBands(comps, scored.map((s) => s.p), snap.as_of, 200, 20261117);
  const bandBySlug = new Map(bands.map((b) => [b.slug, b]));

  // The board file. Farm steps are eight day-by-day steps, each 20–600
  // characters, per the gate; anything outside that range is a bug.
  const rows = scored.map((s, i) => {
    const steps = farmStepsFor(s.p, snap.as_of);
    for (const step of steps) {
      if (step.length < 20 || step.length > 600) {
        throw new Error(`farm step out of gate range for ${s.p.slug}: ${step.length} chars`);
      }
    }
    return {
      slug: s.p.slug,
      name: s.p.name,
      rank: i + 1,
      implied_value_usd: s.implied.value,
      farm_steps: steps,
    };
  });

  // The dashboard's chains, in first-appearance order across the board.
  const chains: string[] = [];
  const chainIdx = new Map<string, number>();
  for (const s of scored) {
    for (const chain of s.p.chains) {
      if (!chainIdx.has(chain)) {
        chainIdx.set(chain, chains.length);
        chains.push(chain);
      }
    }
  }

  // One fit per category for the dashboard, in the compact wire form:
  // a = intercept, b = slope, n = comps, r = median MC/TVL, m = kind.
  const fitJson = (fit: { intercept: number; slope: number; n: number; medianRatio: number; method: string }) => ({
    a: round6(fit.intercept),
    b: round6(fit.slope),
    n: fit.n,
    r: round6(fit.medianRatio),
    m: fit.method === 'global' ? 'glo' : fit.method === 'category' ? 'cat' : 'med',
  });
  const fits: Record<string, unknown> = { '*': fitJson(curves.global) };
  for (const category of Object.keys(curves.byCategory).sort()) {
    fits[category] = fitJson(curves.byCategory[category]!);
  }

  const watch = new Set(snap.watchlist);
  // Row layout (dashboard/app.js reads the same indexes):
  // 0 slug, 1 name, 2 category, 3 tvl, 4 change7d, 5 listedAt, 6 implied,
  // 7 planKey, 8 cheapestChainIdx, 9 watchFlag, 10 bandLo, 11 bandHi,
  // 12 rankLo, 13 rankHi, 14 net, 15 verdict (0 skip, 1 thin, 2 farm),
  // 16 expected, 17 gasTotal, 18 fees, 19 deposit, 20 secondChainIdx (-1 none).
  const boardRows = scored.map((s) => {
    const band = bandBySlug.get(s.p.slug)!;
    const econ = farmEconomics(s.p, band.lo);
    const second = secondChain(s.p);
    return [
      s.p.slug,
      s.p.name,
      s.p.category,
      s.p.tvl_usd,
      s.p.change_7d,
      s.p.listed_at,
      s.implied.value,
      familyFor(s.p.category),
      chainIdx.get(farmChain(s.p)) ?? 0,
      watch.has(s.p.slug) ? 1 : 0,
      band.lo,
      band.hi,
      band.rankLo,
      band.rankHi,
      round6(econ.net),
      econ.verdict === 'farm' ? 2 : econ.verdict === 'thin' ? 1 : 0,
      round6(econ.expected),
      round6(econ.gasTotal),
      round6(econ.fees),
      econ.deposit,
      second === null ? -1 : (chainIdx.get(second) ?? -1),
    ];
  });

  // The live-token table: every protocol with a recorded market cap,
  // richest first, so the board can be checked against what already trades.
  const live = snap.protocols
    .filter((p) => p.mcap_usd !== null)
    .sort((a, b) => b.mcap_usd! - a.mcap_usd! || (a.slug < b.slug ? -1 : 1))
    .map((p) => [p.slug, p.name, p.category, p.tvl_usd, p.mcap_usd]);

  const payload = {
    asOf: snap.as_of,
    floor: snap.floor_usd,
    nBoard: scored.length,
    nWatch: snap.watchlist.length,
    nComps: comps.length,
    model: {
      fits,
      loo: { n: loo.n, medErr: loo.medErr, in2x: loo.in2x },
      split: {
        cutoff: split.cutoff,
        nTrain: split.nTrain,
        nTest: split.nTest,
        medErr: split.medErr,
        in2x: split.in2x,
      },
      walk: {
        pooled: { n: walk.pooled.n, medErr: walk.pooled.medErr, in2x: walk.pooled.in2x },
        folds: walk.folds,
      },
      bootstrap: { nRefits: 200, seed: 20261117 },
      netFormula: NET_FORMULA,
    },
    chains,
    gasCosts: chains.map((c) => gasCostUsd(c)),
    plans: PLANS,
    rows: boardRows,
    live,
  };

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ as_of: snap.as_of, rows }, null, 2)}\n`, 'utf8');
  writeFileSync(join(outDir, 'data.js'), `window.RADAR = ${JSON.stringify(payload)};\n`, 'utf8');
  cpSync(join(ROOT, 'dashboard'), join(outDir, 'dashboard'), { recursive: true });
  cpSync(join(ROOT, 'screenshots'), join(outDir, 'screenshots'), { recursive: true });

  // The dossier, exactly as the library writes it from these files.
  const dossier = buildDossier(outDir, { text_max_bytes: 65536 });
  writeFileSync(join(outDir, 'dossier.json'), dossier);

  const verdicts = { farm: 0, thin: 0, skip: 0 };
  for (const r of boardRows) {
    if (r[15] === 2) verdicts.farm++;
    else if (r[15] === 1) verdicts.thin++;
    else verdicts.skip++;
  }
  console.log(
    `token-radar: ${rows.length} rows, ${snap.watchlist.length} watchlist, ${comps.length} comps, ` +
      `LOO ${loo.medErr}% / ${loo.in2x}% in 2x, blind split ${split.medErr}% / ${split.in2x}% in 2x, ` +
      `walk-forward ${walk.pooled.medErr}% / ${walk.pooled.in2x}% in 2x, ` +
      `verdicts farm ${verdicts.farm} / thin ${verdicts.thin} / skip ${verdicts.skip}`,
  );
}

main();
