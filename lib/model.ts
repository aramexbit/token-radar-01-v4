// Token Radar v4 — the value model.
//
// The radar ranks protocols that record no token by what a launch would be
// worth if their record stayed as it is. It never predicts whether or when
// a token appears: it fits the market value of live-token protocols against
// their TVL, then reads each pre-token protocol through that fitted curve,
// bent a little by its recent growth and by how long it has run unlaunched.
//
// v4 keeps the v3 size curve exactly (the shrinkage shootout of 17 Nov 2026
// found no variant beating it by 5 points on leave-one-out or time-split
// error, so the model is unchanged) and adds what v3 lacked: a walk-forward
// validation and a bootstrap refit that put a value band and a rank range on
// every row, netted farm economics (expected farm value minus gas minus
// fees, with a farm / thin / skip verdict), and deposit-sized day-by-day
// farm plans. Every number below comes from the snapshot's own fields or
// from a stated assumption labelled as one; nothing is invented.

import { readFileSync } from 'node:fs';

// ------------------------------------------------------------------ types

export interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

export interface Fit {
  slope: number;
  intercept: number;
  n: number;
  medianRatio: number;
  method: 'global' | 'category' | 'median';
}

export interface Curves {
  global: Fit;
  byCategory: Record<string, Fit>;
}

export interface Implied {
  value: number;
  curveValue: number;
  growth: number;
  age: number;
  fit: Fit;
  capped: boolean;
}

export interface Validation {
  n: number;
  medErr: number;
  in2x: number;
}

export interface SplitValidation extends Validation {
  cutoff: string;
  nTrain: number;
  nTest: number;
}

export interface WalkForward {
  pooled: Validation;
  folds: { train: number; test: number; medErr: number; in2x: number }[];
}

export interface BootstrapBand {
  slug: string;
  lo: number;
  med: number;
  hi: number;
  rankLo: number;
  rankHi: number;
}

// ------------------------------------------------------------------ snapshot

export function loadSnapshot(path: string): Snapshot {
  return JSON.parse(readFileSync(path, 'utf8')) as Snapshot;
}

// ------------------------------------------------------------------ eligibility

/** Categories the watchlist rule throws out outright. */
export const EXCLUDED_CATEGORIES: ReadonlySet<string> = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

/** True when the record carries no token at all. */
export function recordsNoToken(p: Protocol): boolean {
  return p.gecko_id === null && p.symbol === null;
}

/** A name ends in a version marker: a space, then V2, v2, 2.0 or the like. */
const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
/** A whole word that marks a wrapped or staked product of another token. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
/** Exchange names a protocol may not start with. */
const EXCHANGE_PREFIXES = [
  'Binance',
  'Coinbase',
  'Bybit',
  'Kraken',
  'Bitget',
  'OKX',
  'Bitfinex',
  'Gemini',
];

/** The watchlist rule, minus the TVL floor: category, name and origin. */
export function passesWatchlistRules(p: Protocol): boolean {
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (VERSION_SUFFIX.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  for (const prefix of EXCHANGE_PREFIXES) {
    if (p.name.startsWith(prefix)) return false;
  }
  return true;
}

/** A protocol belongs on the board: no token recorded, and the rule keeps it. */
export function isBoardEligible(p: Protocol): boolean {
  return recordsNoToken(p) && passesWatchlistRules(p);
}

// ------------------------------------------------------------------ helpers

function log10(x: number): number {
  return Math.log10(x);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function clamp(x: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, x));
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

/** The fitted market value of one protocol, as a multiple of its own TVL. */
function mcTvlRatio(p: Protocol): number {
  return (p.mcap_usd ?? 0) / p.tvl_usd;
}

/** Deterministic RNG (mulberry32) so bootstrap refits are byte-identical. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------ curve fitting
// Unchanged from v3: the 17 Nov 2026 shrinkage shootout tested slope
// shrinkage for all categories, intercept shrinkage, a 1-observation prior
// and a pure global baseline against this fit on leave-one-out, time-split
// and walk-forward error. None beat it by 5 points (best: global baseline,
// LOO 85.2% vs 89.0%), so v3's fit ships again.

/**
 * Least-squares fit of log10(market cap) on log10(TVL) over the comps that
 * carry both figures, plus their median market-cap-to-TVL ratio.
 */
export function fitSizeCurve(comps: Protocol[]): Fit {
  const usable = comps.filter((p) => (p.mcap_usd ?? 0) > 0 && p.tvl_usd > 0);
  const n = usable.length;
  if (n === 0) {
    return { slope: 1, intercept: 0, n: 0, medianRatio: 0, method: 'global' };
  }
  const xs = usable.map((p) => log10(p.tvl_usd));
  const ys = usable.map((p) => log10(p.mcap_usd!));
  const ratios = usable.map(mcTvlRatio);
  const medianRatio = median(ratios);
  if (n === 1) {
    return { slope: 1, intercept: ys[0]! - xs[0]!, n: 1, medianRatio, method: 'global' };
  }
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) * (xs[i]! - mx);
  }
  const slope = den === 0 ? 1 : num / den;
  return { slope, intercept: my - slope * mx, n, medianRatio, method: 'global' };
}

/**
 * The global fit, plus one fit per category that has comps. A category with
 * five or more comps gets its own least-squares line, shrunk toward the
 * global slope (weight n/(n+10), slope capped at 1) and re-anchored at the
 * category's own centroid, so a small category cannot run away with the
 * board. A category with one to four comps gets a median-ratio fit instead:
 * its median MC/TVL ratio, shrunk in log space toward the global median
 * with the same 10-observation prior, read as a slope-1 line. Categories
 * with no comps fall back to the global fit at read time.
 */
export function fitAllCurves(comps: Protocol[]): Curves {
  const global = fitSizeCurve(comps);
  const byCategory: Record<string, Fit> = {};
  const groups = new Map<string, Protocol[]>();
  for (const p of comps) {
    if (p.category === null) continue;
    const group = groups.get(p.category);
    if (group) group.push(p);
    else groups.set(p.category, [p]);
  }
  for (const [category, group] of groups) {
    const n = group.length;
    if (n >= 5) {
      const own = fitSizeCurve(group);
      const w = n / (n + 10);
      const slope = Math.min(w * own.slope + (1 - w) * global.slope, 1.0);
      const xs = group.map((p) => log10(p.tvl_usd));
      const ys = group.map((p) => log10(p.mcap_usd!));
      const mx = xs.reduce((a, b) => a + b, 0) / n;
      const my = ys.reduce((a, b) => a + b, 0) / n;
      byCategory[category] = {
        slope,
        intercept: my - slope * mx,
        n,
        medianRatio: own.medianRatio,
        method: 'category',
      };
    } else {
      const rCat = median(group.map(mcTvlRatio));
      const rShrunk = Math.exp(
        (n * Math.log(rCat) + 10 * Math.log(global.medianRatio)) / (n + 10),
      );
      byCategory[category] = {
        slope: 1,
        intercept: log10(rShrunk),
        n,
        medianRatio: rShrunk,
        method: 'median',
      };
    }
  }
  return { global, byCategory };
}

/** A category's fit when it has one, else the global fit. */
export function curveFor(category: string | null, curves: Curves): Fit {
  if (category !== null && curves.byCategory[category]) {
    return curves.byCategory[category]!;
  }
  return curves.global;
}

/** The curve's market-cap reading for a TVL. */
export function predictFromCurve(fit: Fit, tvl: number): number {
  return 10 ** (fit.intercept + fit.slope * log10(tvl));
}

// ------------------------------------------------------------------ growth and age

/** Seven-day TVL change, bent into a 0.8–1.2 multiplier; no report, no bend. */
export function growthFactor(change_7d: number | null): number {
  if (change_7d === null) return 1;
  return clamp(1 + change_7d / 100, 0.8, 1.2);
}

/** Whole days between two ISO dates, or null when either is missing. */
export function daysSince(listed_at: string | null, asOf: string): number | null {
  if (listed_at === null || asOf === null) return null;
  const listed = Date.parse(`${listed_at}T00:00:00Z`);
  const at = Date.parse(`${asOf}T00:00:00Z`);
  if (Number.isNaN(listed) || Number.isNaN(at)) return null;
  return Math.floor((at - listed) / 86_400_000);
}

/**
 * How long a protocol has run with no token, as a 0.85–1.0 multiplier: a
 * launch delayed for years is worth a little less than a fresh one, on a
 * log scale that bottoms out at five years. No listing date, no discount.
 */
export function ageFactor(listed_at: string | null, asOf: string): number {
  const days = daysSince(listed_at, asOf);
  if (days === null) return 1;
  const years = days / 365.25;
  const worn = Math.min(1, log10(1 + years) / log10(6));
  return clamp(1 - 0.15 * worn, 0.85, 1.0);
}

// ------------------------------------------------------------------ implied value

/**
 * The implied value: the curve's reading for the protocol's TVL, bent by
 * growth and age, capped at ten times TVL (and at $100T), floored at $1.
 */
export function impliedValue(p: Protocol, curves: Curves, asOf: string): Implied {
  const fit = curveFor(p.category, curves);
  const curveValue = predictFromCurve(fit, p.tvl_usd);
  const growth = growthFactor(p.change_7d);
  const age = ageFactor(p.listed_at, asOf);
  const raw = curveValue * growth * age;
  const cap = Math.min(10 * p.tvl_usd, 1e14);
  const capped = raw > cap;
  const value = Math.max(1, Math.round(Math.min(raw, cap)));
  return { value, curveValue, growth, age, fit, capped };
}

// ------------------------------------------------------------------ validation

function scoreOne(p: Protocol, curves: Curves): { errPct: number; within2x: boolean } {
  const predicted = predictFromCurve(curveFor(p.category, curves), p.tvl_usd);
  const actual = p.mcap_usd!;
  const errPct = (Math.abs(predicted - actual) / actual) * 100;
  const ratio = predicted / actual;
  return { errPct, within2x: ratio >= 0.5 && ratio <= 2 };
}

function summarize(results: { errPct: number; within2x: boolean }[]): Validation {
  const n = results.length;
  const medErr = round1(median(results.map((r) => r.errPct)));
  const in2x = round1((results.filter((r) => r.within2x).length / n) * 100);
  return { n, medErr, in2x };
}

/**
 * Leave-one-out: refit the whole curve set without each comp in turn and
 * predict the held-out one. Reports the median absolute percentage error
 * and the share predicted within a factor of two either way.
 */
export function leaveOneOut(comps: Protocol[]): Validation {
  const usable = comps.filter((p) => (p.mcap_usd ?? 0) > 0 && p.tvl_usd > 0);
  const results: { errPct: number; within2x: boolean }[] = [];
  for (let i = 0; i < usable.length; i++) {
    const rest = usable.slice(0, i).concat(usable.slice(i + 1));
    const curves = fitAllCurves(rest);
    results.push(scoreOne(usable[i]!, curves));
  }
  return summarize(results);
}

/**
 * Time split (the blind / out-of-sample test): sort the dated comps by
 * listing day, cut at the median date, fit on the older half and score the
 * newer half — the test half is never seen while fitting. Reports the
 * cutoff, the two sizes, the median error and the within-two share.
 */
export function timeSplitTest(comps: Protocol[]): SplitValidation {
  const dated = comps
    .filter((p) => (p.mcap_usd ?? 0) > 0 && p.tvl_usd > 0 && p.listed_at !== null)
    .sort((a, b) =>
      a.listed_at! < b.listed_at! ? -1 : a.listed_at! > b.listed_at! ? 1 : a.slug < b.slug ? -1 : 1,
    );
  const cutoff = dated[Math.floor(dated.length / 2)]!.listed_at!;
  const train = dated.filter((p) => p.listed_at! < cutoff);
  const test = dated.filter((p) => p.listed_at! >= cutoff);
  const curves = fitAllCurves(train);
  const scored = summarize(test.map((p) => scoreOne(p, curves)));
  return { cutoff, nTrain: train.length, nTest: test.length, ...scored };
}

/**
 * Walk-forward validation: sort the dated comps by listing day and roll
 * the fit forward in three expanding windows — fit on the earliest 40%
 * and test the next 20%, then fit on the earliest 60% and test the next
 * 20%, then fit on the earliest 80% and test the last 20%. Each test fold
 * is future data relative to its own training window. Reports the pooled
 * error over all three test folds plus each fold on its own.
 */
export function walkForwardTest(comps: Protocol[]): WalkForward {
  const dated = comps
    .filter((p) => (p.mcap_usd ?? 0) > 0 && p.tvl_usd > 0 && p.listed_at !== null)
    .sort((a, b) =>
      a.listed_at! < b.listed_at! ? -1 : a.listed_at! > b.listed_at! ? 1 : a.slug < b.slug ? -1 : 1,
    );
  const cuts = [0.4, 0.6, 0.8];
  const folds: WalkForward['folds'] = [];
  const all: { errPct: number; within2x: boolean }[] = [];
  for (const c of cuts) {
    const k = Math.floor(dated.length * c);
    const train = dated.slice(0, k);
    const test = dated.slice(k, Math.floor(dated.length * (c + 0.2)));
    const curves = fitAllCurves(train);
    const res = test.map((p) => scoreOne(p, curves));
    all.push(...res);
    const s = summarize(res);
    folds.push({ train: train.length, test: test.length, medErr: s.medErr, in2x: s.in2x });
  }
  return { pooled: summarize(all), folds };
}

/**
 * Bootstrap refits: resample the comps with replacement (seeded, so the
 * run is deterministic), refit, and re-rank the whole board. After
 * nRefits rounds each board protocol carries a value band (10th–90th
 * percentile of its refitted implied values, with the median) and a rank
 * range (5th–95th percentile of its refitted ranks). Thin categories widen
 * fast under resampling, which is the point: the band says how much the
 * ranking depends on one or two comps.
 */
export function bootstrapBands(
  comps: Protocol[],
  board: Protocol[],
  asOf: string,
  nRefits = 200,
  seed = 20261117,
): BootstrapBand[] {
  const rng = mulberry32(seed);
  const vals: number[][] = board.map(() => []);
  const ranks: number[][] = board.map(() => []);
  for (let r = 0; r < nRefits; r++) {
    const sample = Array.from(
      { length: comps.length },
      () => comps[Math.floor(rng() * comps.length)]!,
    );
    const curves = fitAllCurves(sample);
    const scored = board.map((p) => impliedValue(p, curves, asOf).value);
    const order = scored
      .map((v, i) => i)
      .sort((a, b) => scored[b]! - scored[a]! || (board[a]!.slug < board[b]!.slug ? -1 : 1));
    const rankOf = new Array<number>(board.length);
    order.forEach((idx, pos) => {
      rankOf[idx] = pos + 1;
    });
    scored.forEach((v, i) => {
      vals[i]!.push(v);
      ranks[i]!.push(rankOf[i]!);
    });
  }
  const pct = (sorted: number[], q: number): number => {
    const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
    return sorted[i]!;
  };
  return board.map((p, i) => {
    const vs = [...vals[i]!].sort((a, b) => a - b);
    const rs = [...ranks[i]!].sort((a, b) => a - b);
    return {
      slug: p.slug,
      lo: pct(vs, 0.1),
      med: pct(vs, 0.5),
      hi: pct(vs, 0.9),
      rankLo: pct(rs, 0.05),
      rankHi: pct(rs, 0.95),
    };
  });
}

// ------------------------------------------------------------------ gas

/**
 * Mid-range gas cost in dollars for one transaction on a chain. The table
 * names every chain that appears on this snapshot's board — no chain falls
 * back to a default label. Values are stated estimates grouped by tier
 * (cheap L2 / fast L1 $0.03, mid L2 $0.12, heavy L2 / L1 $0.30, Bitcoin
 * $1.00, Ethereum $5.00); they are what the farm plans cost with, not
 * metered prices. main.ts throws if a board chain is missing here.
 */
const CHAIN_GAS_USD = new Map<string, number>([
  ['Solana', 0.01],
  ['Base', 0.03],
  ['Sui', 0.03],
  ['Aptos', 0.03],
  ['Polygon', 0.03],
  ['Hyperliquid L1', 0.03],
  ['Monad', 0.03],
  ['Unichain', 0.03],
  ['Sonic', 0.03],
  ['Plasma', 0.03],
  ['Robinhood Chain', 0.03],
  ['Flare', 0.03],
  ['Arc', 0.03],
  ['Katana', 0.03],
  ['Plume Mainnet', 0.03],
  ['Plume', 0.03],
  ['Stellar', 0.03],
  ['Ink', 0.03],
  ['Hemi', 0.03],
  ['Mantle', 0.03],
  ['TAC', 0.03],
  ['Tempo', 0.03],
  ['BOB', 0.03],
  ['Pharos', 0.03],
  ['Sei', 0.03],
  ['CORE', 0.03],
  ['Stable', 0.03],
  ['Citrea', 0.03],
  ['Etherlink', 0.03],
  ['Fluent', 0.03],
  ['Mezo', 0.03],
  ['Provenance', 0.03],
  ['RSK', 0.03],
  ['World Chain', 0.03],
  ['Ripple', 0.03],
  ['Celo', 0.03],
  ['Morph', 0.03],
  ['Manta', 0.03],
  ['Algorand', 0.03],
  ['RISE', 0.03],
  ['Sophon', 0.03],
  ['Soneium', 0.03],
  ['Mode', 0.03],
  ['Telos', 0.03],
  ['ZetaChain', 0.03],
  ['Fantom', 0.03],
  ['X Layer', 0.03],
  ['Ronin', 0.03],
  ['Kava', 0.03],
  ['Saga', 0.03],
  ['Corn', 0.03],
  ['Tron', 0.03],
  ['Bitlayer', 0.03],
  ['XRPL EVM', 0.03],
  ['BSquared', 0.03],
  ['Aleo', 0.03],
  ['Noble', 0.03],
  ['Babylon Genesis', 0.03],
  ['Rayls', 0.03],
  ['XION', 0.03],
  ['ZIGChain', 0.03],
  ['Op_Bnb', 0.03],
  ['Cronos', 0.03],
  ['Elysium Kinetiq', 0.03],
  ['Peaq', 0.03],
  ['MegaETH', 0.03],
  ['Pulse', 0.03],
  ['Fraxtal', 0.03],
  ['BOT Chain', 0.03],
  ['MetalL2', 0.03],
  ['Lisk', 0.03],
  ['Near', 0.03],
  ['Zcash', 0.03],
  ['Doge', 0.03],
  ['Cardano', 0.03],
  ['Litecoin', 0.03],
  ['Story', 0.03],
  ['Reya Network', 0.03],
  ['Proton', 0.03],
  ['Flow', 0.03],
  ['Hibachi', 0.03],
  ['Canton', 0.03],
  ['Klaytn', 0.03],
  ['Strato', 0.03],
  ['Nibiru', 0.03],
  ['Metis', 0.03],
  ['Zircuit', 0.03],
  ['Filecoin', 0.03],
  ['ApeChain', 0.03],
  ['Taiko', 0.03],
  ['zkLink', 0.03],
  ['Evmos', 0.03],
  ['ThunderCore', 0.03],
  ['Astar', 0.03],
  ['Moonbeam', 0.03],
  ['Goat', 0.03],
  ['HeLa', 0.03],
  ['Bifrost Network', 0.03],
  ['Stacks', 0.03],
  ['Qubic', 0.03],
  ['Swellchain', 0.03],
  ['Optimism', 0.12],
  ['Binance', 0.12],
  ['Linea', 0.12],
  ['Scroll', 0.12],
  ['Blast', 0.12],
  ['Berachain', 0.12],
  ['zkSync Era', 0.12],
  ['Starknet', 0.12],
  ['Polygon zkEVM', 0.12],
  ['Arbitrum', 0.3],
  ['Avalanche', 0.3],
  ['Bittensor', 0.3],
  ['Bittensor EVM', 0.3],
  ['Bitcoin', 1],
  ['Ethereum', 5],
]);

export function hasGasEntry(chain: string): boolean {
  return CHAIN_GAS_USD.has(chain);
}

export function gasCostUsd(chain: string): number {
  return CHAIN_GAS_USD.get(chain) ?? 0.5;
}

/** The human gas label for a chain, as a dollars-per-transaction range. */
export function gasLabel(chain: string): string {
  const c = gasCostUsd(chain);
  if (c <= 0.01) return '~$0.01';
  if (c <= 0.03) return '~$0.01–0.05';
  if (c <= 0.12) return '~$0.05–0.20';
  if (c <= 0.3) return '~$0.10–0.50';
  if (c <= 1) return '~$0.50–2.00';
  return '~$2–10';
}

/** The protocol's cheapest chain to farm on (first listed wins a tie). */
export function farmChain(p: Protocol): string {
  let best = p.chains[0] ?? 'Ethereum';
  for (const chain of p.chains) {
    if (gasCostUsd(chain) < gasCostUsd(best)) best = chain;
  }
  return best;
}

/** The protocol's second-cheapest chain, for a fallback route; null if one chain. */
export function secondChain(p: Protocol): string | null {
  const first = farmChain(p);
  let best: string | null = null;
  for (const chain of p.chains) {
    if (chain === first) continue;
    if (best === null || gasCostUsd(chain) < gasCostUsd(best)) best = chain;
  }
  return best;
}

// ------------------------------------------------------------------ deposit sizing + netted farm economics

export interface DepositTier {
  lo: number;
  hi: number;
  mid: number;
  label: string;
}

/** Deposit size by TVL tier: small protocols get a small farm, big ones a big one. */
export function depositTier(tvl: number): DepositTier {
  if (tvl < 100_000_000) return { lo: 25, hi: 100, mid: 62.5, label: '$25–100' };
  if (tvl <= 1_000_000_000) return { lo: 100, hi: 500, mid: 300, label: '$100–500' };
  return { lo: 500, hi: 2000, mid: 1250, label: '$500–2,000' };
}

/**
 * On-chain transactions in an 8-step plan: deposit, add, swap-back,
 * withdraw, re-deposit, claim — six in total (step 5 is two legs).
 */
export const PLAN_TXNS = 6;

/** Round-trip pool/swap fee assumption on the deposit (stated, not measured). */
export const FEE_RATE = 0.005;

export interface FarmEconomics {
  deposit: number;
  gasTotal: number;
  fees: number;
  expected: number;
  net: number;
  verdict: 'farm' | 'thin' | 'skip';
}

/**
 * Netted farm economics, in one line:
 *   net = expected − gas − fees
 * where expected = the low end of the bootstrap value band (p10) times the
 * farmer's share of the protocol (deposit ÷ TVL), gas = 6 on-chain
 * transactions on the cheapest chain, and fees = 0.5% of the deposit
 * (a stated assumption for round-trip pool/swap fees). The band's low end
 * is used on purpose: a farm that only pays at the point estimate is not
 * a farm. Verdict: farm when the net clears $25 and at least twice the
 * costs, thin when it is positive but small, skip when it is zero or
 * negative. Nothing here invents an APY, a yield, a pool or a token.
 */
export function farmEconomics(p: Protocol, bandLo: number): FarmEconomics {
  const deposit = depositTier(p.tvl_usd).mid;
  const gasTotal = PLAN_TXNS * gasCostUsd(farmChain(p));
  const fees = FEE_RATE * deposit;
  const expected = (bandLo * deposit) / p.tvl_usd;
  const net = expected - gasTotal - fees;
  const verdict: FarmEconomics['verdict'] =
    net >= 25 && net >= 2 * (gasTotal + fees) ? 'farm' : net > 0 ? 'thin' : 'skip';
  return { deposit, gasTotal, fees, expected, net, verdict };
}

// ------------------------------------------------------------------ farm plans

export interface FarmPlan {
  title: string;
  steps: string[];
}

function tenureText(p: Protocol, asOf: string): string {
  const d = daysSince(p.listed_at, asOf);
  if (d === null) return 'no listing date is reported, so hold the full 8 weeks before judging the farm';
  if (d < 180)
    return `only ${d} days unlaunched — a fresh listing, so move in week 1 and reassess at day 56`;
  if (d <= 540)
    return `${d} days unlaunched — a seasoned wait, so hold the full 8 weeks before judging it`;
  return `${d} days unlaunched (${(d / 365.25).toFixed(1)} years) — a long wait, so treat this as patient accumulation and hold 8+ weeks`;
}

function cadenceText(p: Protocol): string {
  const c = p.change_7d;
  if (c === null) return 'no 7-day change reported — check every 2 weeks';
  if (c < -10)
    return `TVL down ${Math.abs(c).toFixed(1)}% in 7 days — check weekly and shrink the next deposit if it keeps falling`;
  if (c > 20)
    return `TVL up ${c.toFixed(1)}% in 7 days — momentum is strong, compound weekly while it lasts`;
  return c >= 0
    ? `TVL up ${c.toFixed(1)}% in 7 days — check every 2 weeks`
    : `TVL down ${Math.abs(c).toFixed(1)}% in 7 days — check every 2 weeks and watch for a deeper slide`;
}

function fallbackText(p: Protocol): string {
  const second = secondChain(p);
  return second === null
    ? 'no second chain is on record — the fallback is to wait, not to bridge blind'
    : `keep ${second} as the fallback route if ${farmChain(p)} stalls`;
}

/**
 * Seventeen farm families, each an 8-step day-by-day plan (Day 1 to Day 56).
 * Slots: {NAME} protocol name, {CHAIN} cheapest chain, {CHAIN2} fallback
 * text, {GAS} gas label, {DEP} deposit range, {DEP2} second-deposit range,
 * {TENURE} tenure sentence, {CADENCE} cadence sentence. Steps 1, 3, 4, 5
 * and 6 are the six on-chain transactions the netting costs; steps 2, 7
 * and 8 are checks, a hold note and a decision. No step invents a pool,
 * a vault name, an APY or a token.
 */
const PLAN_TEMPLATES: Record<string, { title: string; steps: string[] }> = {
  dex: {
    title: 'DEX farming — swap and provide liquidity',
    steps: [
      "Day 1 — Swap {DEP} into {NAME}'s main pair on {CHAIN} (gas {GAS} per swap, ~2 min) and save the receipt.",
      'Day 3 — Check {NAME}\u2019s deepest pool on {CHAIN} and note the fallback: {CHAIN2}.',
      'Day 7 — Add {DEP} of liquidity to the deepest pool ({CADENCE}); deposit gas {GAS}, hold the LP 8 weeks.',
      'Day 14 — Swap back 10–25% of the LP to show repeat usage (one swap, gas {GAS}, ~2 min).',
      'Day 21 — Withdraw a 10–20% test slice of the LP, then re-deposit it the same day (two legs, gas {GAS} each).',
      'Day 28 — Claim trading-fee rewards and re-deposit them (claim gas {GAS}, ~15 min); log the amounts.',
      'Day 42 — {TENURE}; keep the LP open and review the pool\u2019s depth before adding more.',
      'Day 56 — Decide: keep the LP if fees beat gas, else exit to the flagship stablecoin on {CHAIN} and export the full log.',
    ],
  },
  lending: {
    title: 'Lending farming — supply, borrow, repeat',
    steps: [
      "Day 1 — Supply {DEP} of a major asset (ETH, USDC or wBTC) as collateral to {NAME} on {CHAIN} (gas {GAS}, ~3 min).",
      'Day 3 — Check {NAME}\u2019s borrow rates and health-factor rules on {CHAIN}; fallback: {CHAIN2}.',
      'Day 7 — Borrow 20–40% of the supplied value in a stablecoin ({CADENCE}); borrow tx costs {GAS}.',
      'Day 14 — Repay 10–20% of the loan, then re-borrow a different asset (each leg gas {GAS}, ~5 min).',
      'Day 21 — Withdraw a 10–20% test slice of the collateral, then re-supply it the same day (two legs, gas {GAS} each).',
      'Day 28 — Top up collateral by {DEP2} so the position stays healthy (top-up gas {GAS}); log the health factor.',
      'Day 42 — {TENURE}; never let the health factor near 1 — check it weekly, 10 min.',
      'Day 56 — Decide: keep the supply/borrow loop if rates beat gas, else repay in full and export the history.',
    ],
  },
  yield: {
    title: 'Yield farming — vault deposits and compounding',
    steps: [
      "Day 1 — Deposit {DEP} into {NAME}'s highest-TVL vault on {CHAIN} (gas {GAS}, ~3 min); funds stay 8 weeks.",
      'Day 3 — Read {NAME}\u2019s vault list on {CHAIN} and note the fallback: {CHAIN2}.',
      'Day 7 — Harvest or compound the yield ({CADENCE}); each harvest costs {GAS}, ~5 min.',
      'Day 14 — Split a second deposit ({DEP2}) into another vault or strategy to widen coverage (gas {GAS}).',
      'Day 21 — Withdraw a 10–20% test slice, then re-deposit it the same day (two legs, gas {GAS} each).',
      'Day 28 — Claim yield and re-deposit it (claim gas {GAS}, ~10 min); log vault returns weekly.',
      'Day 42 — {TENURE}; keep a weekly log of vault deposits and yields, 10 min a week, no extra gas.',
      'Day 56 — Decide: keep the vaults if net yield beats gas, else withdraw and export the full log.',
    ],
  },
  perps: {
    title: 'Perps farming — small leveraged round trips',
    steps: [
      "Day 1 — Open a small long or short on {NAME} ({DEP} notional, 1–2x leverage) on {CHAIN} (gas {GAS} plus taker fee, ~5 min).",
      'Day 3 — Set a stop-loss and take-profit on the position the same day; fallback: {CHAIN2}.',
      'Day 7 — Close the first position and open a fresh one the next week ({CADENCE}); each close costs {GAS}, ~5 min.',
      'Day 14 — Trade the opposite direction with {DEP2} notional to show two-sided use (gas {GAS} plus taker fee).',
      'Day 21 — Close a 10–20% slice of the open position, then re-open it the same day (two legs, gas {GAS} each).',
      'Day 28 — Settle the month\u2019s round trips and log PnL per trade (settlement gas {GAS}); never risk more than 5% of the farm budget on one trade.',
      'Day 42 — {TENURE}; keep at least 4 round trips over the 8 weeks — breadth beats one big bet.',
      'Day 56 — Decide: keep trading small if the venue\u2019s fees beat gas, else close out and export the trade diary.',
    ],
  },
  rwa: {
    title: 'RWA farming — hold tokenised real-world assets',
    steps: [
      "Day 1 — Mint or buy {DEP} of {NAME}'s tokenised asset on {CHAIN} (gas {GAS}, ~5 min) and keep the receipt.",
      'Day 3 — Check {NAME}\u2019s redemption terms on {CHAIN}; fallback: {CHAIN2}.',
      'Day 7 — Hold the position — RWA farms reward holding time, not churn ({CADENCE}); check the position weekly.',
      'Day 14 — Add {DEP2} to the same asset class to show a growing position (gas {GAS}).',
      'Day 21 — Redeem a 10–20% test slice, then buy it back the same day (two legs, gas {GAS} each) to prove the redemption path.',
      'Day 28 — Claim any payout the asset pays and re-deposit it monthly (claim gas {GAS}, ~10 min).',
      'Day 42 — {TENURE}; keep the purchase receipt and position history — export them monthly (10 min).',
      'Day 56 — Decide: keep holding if the asset\u2019s payout beats gas, else redeem and export the full record.',
    ],
  },
  cdp: {
    title: 'CDP farming — mint stablecoins against collateral',
    steps: [
      "Day 1 — Lock {DEP} of collateral (ETH or wBTC) in a {NAME} vault on {CHAIN} (gas {GAS}, ~3 min).",
      'Day 3 — Check {NAME}\u2019s collateral-ratio rules on {CHAIN}; fallback: {CHAIN2}.',
      'Day 7 — Mint stablecoins against 25–40% of the collateral value ({CADENCE}); minting costs {GAS}, keep the ratio safe.',
      'Day 14 — Repay 10–20% of the minted debt with {DEP2}, then mint a smaller amount again (each leg gas {GAS}).',
      'Day 21 — Withdraw a 10–20% test slice of collateral, then re-lock it the same day (two legs, gas {GAS} each).',
      'Day 28 — Add collateral monthly so the ratio stays above 200% (top-up gas {GAS}, ~5 min); log the ratio weekly.',
      'Day 42 — {TENURE}; check the collateral ratio weekly (10 min) and never let it near liquidation.',
      'Day 56 — Decide: keep the vault open if the minted stablecoins earn more than gas, else repay in full and export the log.',
    ],
  },
  bridge: {
    title: 'Bridge farming — cross-chain crossings',
    steps: [
      "Day 1 — Bridge {DEP} from {CHAIN} to another supported chain through {NAME} (gas {GAS} plus the bridge fee, ~10 min).",
      'Day 3 — Check {NAME}\u2019s supported routes from {CHAIN}; fallback: {CHAIN2}.',
      'Day 7 — Bridge a different asset the following week ({CADENCE}); allow 10–30 min for finality each time.',
      'Day 14 — Bridge {DEP2} back so the flow is two-way, not one-way (return leg gas {GAS} plus the bridge fee).',
      'Day 21 — Bridge a 10–20% test slice out and back the same day (two legs, gas {GAS} each plus bridge fees).',
      'Day 28 — Settle the month\u2019s crossings and log every tx hash (settlement gas {GAS}); keep each bridge above the venue minimum (usually $10–25).',
      'Day 42 — {TENURE}; bridging history is the farm record here — 6+ crossings over 8 weeks beats one burst.',
      'Day 56 — Decide: keep bridging weekly if fees beat gas, else stop and export the crossing history.',
    ],
  },
  chain: {
    title: 'Chain farming — live on the chain itself',
    steps: [
      "Day 1 — Bridge {DEP} onto {NAME}'s chain and make a first swap on its flagship DEX (gas {GAS} each, ~10 min).",
      'Day 3 — Pick a second native dApp to try this week; fallback: {CHAIN2}.',
      'Day 7 — Interact with one native dApp (lending or perps) weekly for 8 weeks ({CADENCE}); each interaction costs {GAS}.',
      'Day 14 — Add {DEP2} to the chain balance and use a second native app (gas {GAS}, ~15 min).',
      'Day 21 — Move a 10–20% test slice to another native app, then move it back the same day (two legs, gas {GAS} each).',
      'Day 28 — Settle the month\u2019s activity and hold a small native-token balance ($10–50) for gas (settlement gas {GAS}).',
      'Day 42 — {TENURE}; keep activity steady — 2–3 tx a week for a month beats 20 tx in one day.',
      'Day 56 — Decide: keep living on the chain if dApp fees beat gas, else consolidate and export the activity log.',
    ],
  },
  stake: {
    title: 'Staking farming — stake and restake rewards',
    steps: [
      "Day 1 — Stake {DEP} of the base asset with {NAME} on {CHAIN} (gas {GAS}, ~3 min); funds stay staked 8 weeks.",
      'Day 3 — Check {NAME}\u2019s staking terms and unbonding time on {CHAIN}; fallback: {CHAIN2}.',
      'Day 7 — Claim staking rewards and restake them ({CADENCE}); each claim costs {GAS}, ~5 min.',
      'Day 14 — Add {DEP2} to the stake to show a growing position (top-up gas {GAS}).',
      'Day 21 — Unstake a 10–20% test slice, then re-stake it the same day (two legs, gas {GAS} each).',
      'Day 28 — Restake a slice (25–50%) of the stake once if restaking is offered (restake gas {GAS}, ~5 min).',
      'Day 42 — {TENURE}; unstaking can take days — plan the exit a week ahead, never at the last minute.',
      'Day 56 — Decide: keep staking if rewards beat gas, else unstake and export the staking history.',
    ],
  },
  vault: {
    title: 'Vault farming — curated vault deposits',
    steps: [
      "Day 1 — Deposit {DEP} into {NAME}'s largest curated vault on {CHAIN} (gas {GAS}, ~3 min); hold 8 weeks.",
      'Day 3 — Check {NAME}\u2019s curator, allocation and APY weekly; fallback: {CHAIN2}.',
      'Day 7 — Harvest or compound vault yield ({CADENCE}); each harvest costs {GAS}, ~5 min.',
      'Day 14 — Add {DEP2} to a second vault run by a different curator (deposit gas {GAS}).',
      'Day 21 — Withdraw a 10–20% test slice, then re-deposit it the same day (two legs, gas {GAS} each).',
      'Day 28 — Claim vault yield and re-deposit it (claim gas {GAS}); switch vaults if the curator changes strategy.',
      'Day 42 — {TENURE}; review the curator\u2019s allocation weekly (10 min) — a strategy change is the signal to move.',
      'Day 56 — Decide: keep the vaults if yield beats gas, else withdraw and export the full log.',
    ],
  },
  index: {
    title: 'Index farming — hold and rebalance the basket',
    steps: [
      "Day 1 — Buy {DEP} of {NAME}'s index token on {CHAIN} (gas {GAS}, ~3 min); hold at least 8 weeks.",
      'Day 3 — Check {NAME}\u2019s basket weights and rebalance date on {CHAIN}; fallback: {CHAIN2}.',
      'Day 7 — Compare the index price to its NAV weekly ({CADENCE}); note any discount — it is part of the farm record.',
      'Day 14 — Add {DEP2} on the monthly rebalance date if the index reweights (top-up gas {GAS}).',
      'Day 21 — Redeem a 10–20% test slice, then buy it back the same day (two legs, gas {GAS} each).',
      'Day 28 — Settle the month\u2019s position and log price vs NAV (settlement gas {GAS}, ~10 min).',
      'Day 42 — {TENURE}; hold through at least one full rebalance cycle (usually a month) before judging the position.',
      'Day 56 — Decide: keep the index if the basket beats gas, else redeem and export the full log.',
    ],
  },
  payments: {
    title: 'Payments farming — pay and settle on-chain',
    steps: [
      "Day 1 — Make a first real payment of {DEP} through {NAME} on {CHAIN} (gas {GAS}, ~3 min) and keep the receipt.",
      'Day 3 — Check {NAME}\u2019s second payment rail or currency on {CHAIN}; fallback: {CHAIN2}.',
      'Day 7 — Repeat a payment weekly for 8 weeks ({CADENCE}); each payment costs {GAS}.',
      'Day 14 — Try a second payment rail or currency with {DEP2} (each try gas {GAS}).',
      'Day 21 — Send a 10–20% test payment out and settle it back the same day (two legs, gas {GAS} each).',
      'Day 28 — Settle accumulated balances monthly (settlement gas {GAS}, ~10 min); export the receipts.',
      'Day 42 — {TENURE}; keep receipts for every payment — export the history monthly (10 min) as proof of sustained use.',
      'Day 56 — Decide: keep paying through {NAME} if fees beat gas, else settle out and export the payment history.',
    ],
  },
  prediction: {
    title: 'Prediction farming — small market positions',
    steps: [
      "Day 1 — Buy {DEP} of shares in a {NAME} market resolving in 2–4 weeks on {CHAIN} (gas {GAS}, ~3 min).",
      'Day 3 — Pick a second market in a different category; fallback: {CHAIN2}.',
      'Day 7 — Trade a second market the next week ({CADENCE}); each trade costs {GAS}.',
      'Day 14 — Add {DEP2} to a market in a new category to widen breadth (gas {GAS}).',
      'Day 21 — Sell a 10–20% test slice of one position, then buy it back the same day (two legs, gas {GAS} each).',
      'Day 28 — Settle the month\u2019s resolved markets and record every outcome (settlement gas {GAS}).',
      'Day 42 — {TENURE}; place 4–8 small trades over 8 weeks rather than one big bet — breadth beats size.',
      'Day 56 — Decide: keep trading small if resolution payouts beat gas, else stop and export the trade history.',
    ],
  },
  insurance: {
    title: 'Insurance farming — cover and underwriting',
    steps: [
      "Day 1 — Buy cover of {DEP} for 30–90 days with {NAME} on {CHAIN} (gas {GAS} plus the premium, ~5 min).",
      'Day 3 — Check {NAME}\u2019s cover terms and claim window on {CHAIN}; fallback: {CHAIN2}.',
      'Day 7 — Hold the cover live — lapsed cover breaks the farm record ({CADENCE}); check the policy weekly.',
      'Day 14 — Extend or top up the cover with {DEP2} if the term allows (gas {GAS}).',
      'Day 21 — Provide a 10–20% test slice of underwriting capacity if offered, then withdraw it the same day (two legs, gas {GAS} each).',
      'Day 28 — Settle the month\u2019s cover and log the policy status (settlement gas {GAS}, ~10 min).',
      'Day 42 — {TENURE}; file a claim only if a real covered event happens — never file a false claim.',
      'Day 56 — Decide: renew the cover if the premium beats gas, else let it lapse and export the policy history.',
    ],
  },
  gov: {
    title: 'Governance farming — lock, vote and discuss',
    steps: [
      "Day 1 — Lock or delegate {DEP} of voting power with {NAME} on {CHAIN} (gas {GAS}, ~3 min); lock for 8 weeks.",
      'Day 3 — Read {NAME}\u2019s live proposals on {CHAIN}; fallback: {CHAIN2}.',
      'Day 7 — Vote on every live proposal while locked ({CADENCE}); voting costs {GAS} each — missing votes is the usual disqualifier.',
      'Day 14 — Add {DEP2} to the lock to show a growing position (top-up gas {GAS}).',
      'Day 21 — Unlock a 10–20% test slice, then re-lock it the same day (two legs, gas {GAS} each).',
      'Day 28 — Claim voting rewards and re-lock them (claim gas {GAS}, ~5 min a week).',
      'Day 42 — {TENURE}; join one governance discussion per proposal cycle (~15 min, no gas).',
      'Day 56 — Decide: keep the lock through at least two proposal cycles before unlocking; early exit can forfeit rewards.',
    ],
  },
  otc: {
    title: 'OTC farming — quoted trades and RFQs',
    steps: [
      "Day 1 — Request a quote for a {DEP} trade with {NAME} on {CHAIN} (quoting is free, settling costs {GAS}, ~10 min).",
      'Day 3 — Check {NAME}\u2019s limit and RFQ order types on {CHAIN}; fallback: {CHAIN2}.',
      'Day 7 — Settle one small trade to open the account history ({CADENCE}); settlement costs {GAS} plus the agreed spread.',
      'Day 14 — Repeat a trade in a different pair with {DEP2} (each settlement gas {GAS}).',
      'Day 21 — Settle a 10–20% test trade out and back the same day (two legs, gas {GAS} each).',
      'Day 28 — Settle the month\u2019s trades and log every fill (settlement gas {GAS}); use limit or RFQ orders when offered.',
      'Day 42 — {TENURE}; keep 4+ settled trades over 8 weeks — export the trade history monthly (10 min).',
      'Day 56 — Decide: keep trading OTC if spreads beat gas, else stop and export the full history.',
    ],
  },
  generic: {
    title: 'General farming — use the core feature weekly',
    steps: [
      "Day 1 — Use {NAME}'s core feature on {CHAIN} with {DEP} (gas about {GAS}) and save the receipt.",
      'Day 3 — Read {NAME}\u2019s secondary features on {CHAIN}; fallback: {CHAIN2}.',
      'Day 7 — Repeat the core feature with a different asset or parameter ({CADENCE}); spend {DEP} again.',
      'Day 14 — Try one secondary feature of {NAME} with {DEP2} (gas {GAS}).',
      'Day 21 — Reverse a 10–20% test slice of the position, then redo it the same day (two legs, gas {GAS} each).',
      'Day 28 — Settle the month\u2019s interactions and log amounts, dates and tx hashes (settlement gas {GAS}).',
      'Day 42 — {TENURE}; keep the position open for the full 8 weeks, checking it weekly.',
      'Day 56 — Decide: keep using {NAME} if the feature beats gas, else wind down and export the full log.',
    ],
  },
};

/** The farm family a category belongs to; anything unlisted is generic. */
export function familyFor(category: string | null): string {
  switch (category) {
    case 'Dexs':
      return 'dex';
    case 'Lending':
    case 'Uncollateralized Lending':
    case 'Collateral Markets':
      return 'lending';
    case 'Yield':
    case 'Yield Aggregator':
    case 'Farm':
    case 'Leveraged Farming':
      return 'yield';
    case 'Derivatives':
    case 'Basis Trading':
    case 'Interest Rate Derivatives':
      return 'perps';
    case 'RWA':
    case 'Decentralized BTC':
    case 'Anchor BTC':
    case 'Stablecoin Wrapper':
    case 'Dual-Token Stablecoin':
      return 'rwa';
    case 'CDP':
    case 'CDP Manager':
      return 'cdp';
    case 'Cross Chain Bridge':
      return 'bridge';
    case 'Chain':
      return 'chain';
    case 'Staking Pool':
    case 'Restaking':
      return 'stake';
    case 'Risk Curators':
    case 'Onchain Capital Allocator':
    case 'Liquidity Manager':
    case 'CeDeFi':
      return 'vault';
    case 'Indexes':
      return 'index';
    case 'Payments':
    case 'Crypto Card Issuer':
      return 'payments';
    case 'Prediction Market':
      return 'prediction';
    case 'Insurance':
      return 'insurance';
    case 'Governance Incentives':
      return 'gov';
    case 'OTC Marketplace':
      return 'otc';
    default:
      return 'generic';
  }
}

export const PLANS: Record<string, FarmPlan> = Object.fromEntries(
  Object.entries(PLAN_TEMPLATES).map(([k, v]) => [k, { title: v.title, steps: v.steps }]),
);

/** The protocol's eight day-by-day farm steps, with its own name, amounts, chains and gas filled in. */
export function farmStepsFor(p: Protocol, asOf: string): string[] {
  const plan = PLAN_TEMPLATES[familyFor(p.category)]!;
  const chain = farmChain(p);
  const dep = depositTier(p.tvl_usd);
  const dep2 =
    p.tvl_usd < 100_000_000 ? '$25–50' : p.tvl_usd <= 1_000_000_000 ? '$50–200' : '$200–500';
  const slots: Record<string, string> = {
    '{NAME}': p.name,
    '{CHAIN}': chain,
    '{CHAIN2}': fallbackText(p),
    '{GAS}': gasLabel(chain),
    '{DEP}': dep.label,
    '{DEP2}': dep2,
    '{TENURE}': tenureText(p, asOf),
    '{CADENCE}': cadenceText(p),
  };
  return plan.steps.map((s) => {
    let out = s;
    for (const [k, v] of Object.entries(slots)) out = out.replaceAll(k, v);
    return out;
  });
}

/** The title of the protocol's farm plan family. */
export function farmPlanTitle(p: Protocol): string {
  return PLAN_TEMPLATES[familyFor(p.category)]!.title;
}

// ------------------------------------------------------------------ verdict

/** Short dollars: $718.7M, $65.5M, $456K, $12. */
export function fmtUsd(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${Math.round(v / 1e3)}K`;
  return `$${Math.round(v)}`;
}

/** Small dollars with cents and sign: +$27.77, −$5.63. */
export function fmtUsd2(v: number): string {
  const sign = v < 0 ? '−' : v > 0 ? '+' : '';
  const a = Math.abs(v);
  if (a >= 1000) return `${sign}${fmtUsd(a)}`;
  return `${sign}$${a.toFixed(2)}`;
}

/** Small dollars, unsigned (for a cost being subtracted): $0.06, $6.25. */
export function fmtCost(v: number): string {
  if (v >= 1000) return fmtUsd(v);
  return `$${v.toFixed(2)}`;
}

/**
 * One-line verdict for a protocol, from its netted farm economics: the
 * verdict word (farm / thin / skip), the net figure, and the arithmetic
 * behind it — expected value at the band's low end, minus gas, minus fees
 * — on its cheapest chain, with the implied value and its ratio to TVL.
 * The dashboard renders the same words from the same numbers, so the two
 * never disagree.
 */
export function farmVerdict(p: Protocol, implied: number, bandLo: number): string {
  const e = farmEconomics(p, bandLo);
  const ratio = implied / p.tvl_usd;
  const word = e.verdict === 'farm' ? 'Farm' : e.verdict === 'thin' ? 'Thin farm' : 'Skip';
  const chain = farmChain(p);
  return (
    `${word}: net ${fmtUsd2(e.net)} on a $${e.deposit} deposit ` +
    `(expected ${fmtUsd2(e.expected)} − ${fmtCost(e.gasTotal)} gas on ${chain} − ${fmtCost(e.fees)} fees), ` +
    `implied ${fmtUsd(implied)} (${ratio.toFixed(2)}× TVL)`
  );
}

/** The netting formula, stated in one line for the dashboard and dossier. */
export const NET_FORMULA =
  'net = expected − gas − fees, where expected = bootstrap band low (p10) × deposit ÷ TVL, gas = 6 tx × cheapest-chain gas, fees = 0.5% of deposit (stated assumption).';
