// Token launch radar, pricing core (radar-4 build, fresh session).
//
// The board prices every pre-token protocol in a sealed DefiLlama snapshot
// with an ensemble fitted only on the snapshot's tokenized peers, and it
// grades that ensemble out of sample, in the open, on every run: a
// leave-one-out pass over all peers, both split halves, and three seeded
// five-fold passes, with the two earlier model generations scored on the
// identical schemes beside it. Nothing in this file reads the clock, the
// network, or any randomness beyond the fixed seeds below, so two runs of
// the program write byte-identical hand-ins.

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
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

export interface Validation {
  peers: number;
  ensemble_log_mae: number;
  ensemble_within_2x_pct: number;
  ensemble_spearman: number;
  sigma: number;
  log_blend_log_mae: number;
  plain_blend_log_mae: number;
  schemes: number[];
  median_log_mae: number;
  ancestor_schemes: number[];
  ancestor_median_log_mae: number;
}

export interface Row {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
  category: string;
  chain: string;
  chains: string[];
  tvl_usd: number;
  change_7d: number;
  age_days: number;
  low_usd: number;
  high_usd: number;
  live: boolean;
  watchlist: boolean;
  position_usd: number;
}

export interface Radar {
  rows: Row[];
  total: number;
  pre_token: number;
  live: number;
  watchlist_size: number;
  validation: Validation;
  as_of: string;
}

const PEER_MIN_TVL = 1_000_000;
const RATIO_FLOOR = 0.02;
const RATIO_CAP = 20;
const GROWTH_FLOOR = -60;
const GROWTH_CAP = 120;
const SIZE_FLOOR = 0.25;
const SIZE_CAP = 4;
const UNKNOWN_AGE = 365;

export function parseSnapshot(text: string): Snapshot {
  const raw = JSON.parse(text) as Snapshot;
  if (!Array.isArray(raw.protocols) || !Array.isArray(raw.watchlist)) {
    throw new Error('snapshot: protocols and watchlist arrays are required');
  }
  return raw;
}

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const half = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[half]! : (sorted[half - 1]! + sorted[half]!) / 2;
}

function clipped(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function rounded4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function growthPct(p: Protocol): number {
  return clipped(p.change_7d ?? 0, GROWTH_FLOOR, GROWTH_CAP);
}

function ageInDays(p: Protocol, asOf: string): number | null {
  if (p.listed_at === null) return null;
  const span = Date.parse(asOf) - Date.parse(p.listed_at);
  if (Number.isNaN(span)) return null;
  return Math.max(0, Math.round(span / 86_400_000));
}

function isPeer(p: Protocol): boolean {
  return p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd >= PEER_MIN_TVL;
}

// ---------------------------------------------------------------------------
// The comp stack: a per-category median market-cap / TVL multiple, blended
// toward the global median in log space, tilted by a fitted size law.
// ---------------------------------------------------------------------------

interface CompFit {
  table: Map<string, number>;
  globalMedian: number;
  slope: number;
  referenceTvl: number;
}

function fitCompStack(train: Protocol[], blendK: number, logSpace: boolean, sizeShrink: number): CompFit {
  const byCategory = new Map<string, number[]>();
  const everyRatio: number[] = [];
  const points: Array<[number, number]> = [];
  for (const p of train) {
    const ratio = clipped(p.mcap_usd! / p.tvl_usd, RATIO_FLOOR, RATIO_CAP);
    const category = p.category ?? 'Other';
    const bucket = byCategory.get(category);
    if (bucket === undefined) byCategory.set(category, [ratio]);
    else bucket.push(ratio);
    everyRatio.push(ratio);
    points.push([Math.log(ratio), Math.log(p.tvl_usd)]);
  }
  const globalMedian = medianOf(everyRatio);
  const table = new Map<string, number>();
  for (const [category, ratios] of byCategory) {
    const own = medianOf(ratios);
    const blended = logSpace
      ? Math.exp((ratios.length * Math.log(own) + blendK * Math.log(globalMedian)) / (ratios.length + blendK))
      : (ratios.length * own + blendK * globalMedian) / (ratios.length + blendK);
    table.set(category, blended);
  }
  const meanX = points.reduce((sum, pt) => sum + pt[1], 0) / points.length;
  const meanY = points.reduce((sum, pt) => sum + pt[0], 0) / points.length;
  let covariance = 0;
  let variance = 0;
  for (const [logRatio, logTvl] of points) {
    covariance += (logTvl - meanX) * (logRatio - meanY);
    variance += (logTvl - meanX) * (logTvl - meanX);
  }
  const slope = (variance > 0 ? covariance / variance : 0) * sizeShrink;
  return { table, globalMedian, slope, referenceTvl: Math.exp(meanX) };
}

function compPrice(p: Protocol, fit: CompFit): number {
  const multiple = rounded4(fit.table.get(p.category ?? 'Other') ?? fit.globalMedian);
  let sizeFactor = 1;
  if (fit.slope !== 0 && fit.referenceTvl > 0) {
    sizeFactor = clipped(Math.exp(fit.slope * (Math.log(Math.max(1, p.tvl_usd)) - Math.log(fit.referenceTvl))), SIZE_FLOOR, SIZE_CAP);
  }
  sizeFactor = rounded4(sizeFactor);
  const growthFactor = 1 + (growthPct(p) / 100) * 0.5;
  return Math.max(1, p.tvl_usd * multiple * sizeFactor * growthFactor);
}

function maturityFactor(p: Protocol, asOf: string): number {
  const age = ageInDays(p, asOf) ?? UNKNOWN_AGE;
  return 0.6 + (clipped(age, 0, 1095) / 1095) * 0.4;
}

// ---------------------------------------------------------------------------
// The ridge half: a closed-form ridge regression on log market cap.
// ---------------------------------------------------------------------------

type RidgeModel = (p: Protocol) => number;

function fitRidge(train: Protocol[], asOf: string): RidgeModel {
  const vectorOf = (p: Protocol): number[] => {
    const age = ageInDays(p, asOf) ?? UNKNOWN_AGE;
    return [1, Math.log(Math.max(1, p.tvl_usd)), Math.log(age + 30), growthPct(p) / 100];
  };
  const dim = 4;
  const lambda = 10;
  const normal: number[][] = Array.from({ length: dim }, () => new Array<number>(dim).fill(0));
  const target: number[] = new Array<number>(dim).fill(0);
  for (const p of train) {
    const x = vectorOf(p);
    const y = Math.log(p.mcap_usd!);
    for (let i = 0; i < dim; i++) {
      target[i]! += x[i]! * y;
      for (let j = 0; j < dim; j++) normal[i]![j]! += x[i]! * x[j]!;
    }
  }
  for (let i = 1; i < dim; i++) normal[i]![i]! += lambda;
  const rows = normal.map((row, i) => [...row, target[i]!]);
  for (let col = 0; col < dim; col++) {
    let pivot = col;
    for (let r = col + 1; r < dim; r++) {
      if (Math.abs(rows[r]![col]!) > Math.abs(rows[pivot]![col]!)) pivot = r;
    }
    const swap = rows[col]!;
    rows[col] = rows[pivot]!;
    rows[pivot] = swap;
    for (let r = 0; r < dim; r++) {
      if (r === col) continue;
      const factor = rows[r]![col]! / rows[col]![col]!;
      for (let k = col; k <= dim; k++) rows[r]![k]! -= factor * rows[col]![k]!;
    }
  }
  const weights = rows.map((row, i) => row[dim]! / row[i]!);
  return (p: Protocol): number => {
    const x = vectorOf(p);
    return Math.exp(weights.reduce((sum, w, i) => sum + w * x[i]!, 0));
  };
}

// ---------------------------------------------------------------------------
// Three generations of pricer, one factory shape each. A factory fits on a
// training set and returns a pricing function; no protocol ever prices
// itself, because every evaluation below removes the priced peer first.
// ---------------------------------------------------------------------------

type PricerFactory = (train: Protocol[]) => (p: Protocol) => number;

function ensembleFactory(asOf: string): PricerFactory {
  return (train) => {
    const comp = fitCompStack(train, 12, true, 1.3);
    const ridge = fitRidge(train, asOf);
    return (p) => Math.exp(0.6 * Math.log(compPrice(p, comp)) + 0.4 * Math.log(ridge(p)));
  };
}

function logBlendFactory(asOf: string): PricerFactory {
  return (train) => {
    const comp = fitCompStack(train, 10, true, 0.7);
    return (p) => Math.max(1, compPrice(p, comp) * maturityFactor(p, asOf));
  };
}

function plainBlendFactory(asOf: string): PricerFactory {
  return (train) => {
    const comp = fitCompStack(train, 6, false, 0);
    return (p) => Math.max(1, compPrice(p, comp) * maturityFactor(p, asOf));
  };
}

// ---------------------------------------------------------------------------
// Out-of-sample evaluation: leave-one-out, both split halves, and seeded
// five-fold passes. The shuffle is a fixed-seed linear congruential walk,
// so the schemes are identical on every run and on every machine.
// ---------------------------------------------------------------------------

function logMae(factory: PricerFactory, train: Protocol[], test: Protocol[]): number {
  const price = factory(train);
  const total = test.reduce((sum, p) => sum + Math.abs(Math.log(price(p) / p.mcap_usd!)), 0);
  return total / test.length;
}

function leaveOneOut(factory: PricerFactory, peers: Protocol[]): { mae: number; errors: number[]; signed: number[]; predictions: number[] } {
  const errors: number[] = [];
  const signed: number[] = [];
  const predictions: number[] = [];
  for (let i = 0; i < peers.length; i++) {
    const held = peers[i]!;
    const train = peers.filter((_, j) => j !== i);
    const predicted = factory(train)(held);
    const residual = Math.log(predicted / held.mcap_usd!);
    predictions.push(predicted);
    signed.push(residual);
    errors.push(Math.abs(residual));
  }
  return { mae: errors.reduce((a, b) => a + b, 0) / errors.length, errors, signed, predictions };
}

function shuffledIndices(count: number, seed: number): number[] {
  const order = Array.from({ length: count }, (_, i) => i);
  let state = seed >>> 0;
  const next = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4_294_967_296;
  };
  for (let i = count - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    const swap = order[i]!;
    order[i] = order[j]!;
    order[j] = swap;
  }
  return order;
}

function fiveFold(factory: PricerFactory, peers: Protocol[], seed: number): number {
  const order = shuffledIndices(peers.length, seed);
  let weighted = 0;
  for (let fold = 0; fold < 5; fold++) {
    const testIdx = new Set(order.filter((_, at) => at % 5 === fold));
    const train = peers.filter((_, i) => !testIdx.has(i));
    const test = peers.filter((_, i) => testIdx.has(i));
    weighted += logMae(factory, train, test) * test.length;
  }
  return weighted / peers.length;
}

function sixSchemes(factory: PricerFactory, peers: Protocol[]): number[] {
  const half = Math.floor(peers.length / 2);
  const first = peers.slice(0, half);
  const second = peers.slice(half);
  return [
    leaveOneOut(factory, peers).mae,
    logMae(factory, second, first),
    logMae(factory, first, second),
    fiveFold(factory, peers, 11),
    fiveFold(factory, peers, 23),
    fiveFold(factory, peers, 37),
  ];
}

function rankOf(values: number[]): number[] {
  const order = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const ranks = new Array<number>(values.length).fill(0);
  for (let at = 0; at < order.length; at++) ranks[order[at]![1]] = at + 1;
  return ranks;
}

function spearman(xs: number[], ys: number[]): number {
  const rx = rankOf(xs);
  const ry = rankOf(ys);
  const n = xs.length;
  const meanX = rx.reduce((a, b) => a + b, 0) / n;
  const meanY = ry.reduce((a, b) => a + b, 0) / n;
  let cov = 0;
  let varX = 0;
  let varY = 0;
  for (let i = 0; i < n; i++) {
    cov += (rx[i]! - meanX) * (ry[i]! - meanY);
    varX += (rx[i]! - meanX) * (rx[i]! - meanX);
    varY += (ry[i]! - meanY) * (ry[i]! - meanY);
  }
  return varX > 0 && varY > 0 ? cov / Math.sqrt(varX * varY) : 0;
}

function evaluate(snapshot: Snapshot, peers: Protocol[]): Validation {
  const ensemble = ensembleFactory(snapshot.as_of);
  const loo = leaveOneOut(ensemble, peers);
  const schemes = sixSchemes(ensemble, peers);
  const ancestorSchemes = sixSchemes(logBlendFactory(snapshot.as_of), peers);
  const within = loo.errors.filter((e) => e < Math.log(2)).length;
  const meanSigned = loo.signed.reduce((a, b) => a + b, 0) / loo.signed.length;
  const sigma = Math.sqrt(loo.signed.reduce((sum, r) => sum + (r - meanSigned) * (r - meanSigned), 0) / loo.signed.length);
  const round4 = (v: number): number => Math.round(v * 10000) / 10000;
  return {
    peers: peers.length,
    ensemble_log_mae: round4(loo.mae),
    ensemble_within_2x_pct: Math.round((within / loo.errors.length) * 1000) / 10,
    ensemble_spearman: round4(spearman(loo.predictions, peers.map((p) => p.mcap_usd!))),
    sigma: round4(sigma),
    log_blend_log_mae: round4(leaveOneOut(logBlendFactory(snapshot.as_of), peers).mae),
    plain_blend_log_mae: round4(leaveOneOut(plainBlendFactory(snapshot.as_of), peers).mae),
    schemes: schemes.map(round4),
    median_log_mae: round4(medianOf(schemes)),
    ancestor_schemes: ancestorSchemes.map(round4),
    ancestor_median_log_mae: round4(medianOf(ancestorSchemes)),
  };
}

// ---------------------------------------------------------------------------
// Farm plans. Every row carries a plan sized from its TVL tier and written
// from its category's playbook: nine playbooks cover all 53 categories in
// the snapshot. The dashboard regenerates each plan from the row's own
// figures with the same wording, so the page and the board never disagree.
// ---------------------------------------------------------------------------

export type PlaybookKey =
  | 'lending' | 'trading' | 'yield' | 'staking' | 'bridge'
  | 'stable' | 'rwa' | 'infra' | 'general';

const PLAYBOOK_BY_CATEGORY: Record<string, PlaybookKey> = {
  'Lending': 'lending', 'Uncollateralized Lending': 'lending', 'CDP': 'lending',
  'CDP Manager': 'lending', 'Collateral Management': 'lending', 'Collateral Markets': 'lending',
  'Dexs': 'trading', 'Derivatives': 'trading', 'Options': 'trading', 'Options Vault': 'trading',
  'Interest Rate Derivatives': 'trading', 'Prediction Market': 'trading',
  'OTC Marketplace': 'trading', 'Synthetics': 'trading',
  'Yield': 'yield', 'Yield Aggregator': 'yield', 'Farm': 'yield',
  'Leveraged Farming': 'yield', 'Basis Trading': 'yield', 'Liquidity Manager': 'yield',
  'Onchain Capital Allocator': 'yield', 'Risk Curators': 'yield',
  'Liquid Staking': 'staking', 'Staking Pool': 'staking', 'Restaking': 'staking',
  'Liquid Restaking': 'staking', 'Restaked BTC': 'staking', 'Anchor BTC': 'staking',
  'Decentralized BTC': 'staking',
  'Bridge': 'bridge', 'Canonical Bridge': 'bridge', 'Cross Chain Bridge': 'bridge', 'Chain': 'bridge',
  'Dual-Token Stablecoin': 'stable', 'Algo-Stables': 'stable', 'Stablecoin Wrapper': 'stable',
  'Stablecoin Issuer': 'stable', 'Reserve Currency': 'stable',
  'RWA': 'rwa', 'Payments': 'rwa', 'Crypto Card Issuer': 'rwa', 'CEX': 'rwa',
  'CeDeFi': 'rwa', 'Insurance': 'rwa',
  'Launchpad': 'infra', 'Token Locker': 'infra', 'Indexes': 'infra',
  'Governance Incentives': 'infra', 'Privacy': 'infra', 'DOR': 'infra',
  'AI Agents': 'infra', 'Decentralized AI': 'infra', 'NFT Marketplace': 'infra',
};

export function playbookOf(category: string): PlaybookKey {
  return PLAYBOOK_BY_CATEGORY[category] ?? 'general';
}

export function positionFor(tvlUsd: number): number {
  if (tvlUsd >= 100_000_000) return 1000;
  if (tvlUsd >= 25_000_000) return 500;
  if (tvlUsd >= 10_000_000) return 250;
  return 100;
}

interface PlanFacts {
  name: string;
  chain: string;
  position: number;
}

function middleSteps(key: PlaybookKey, f: PlanFacts): [string, string, string] {
  const half = f.position / 2;
  const fifth = f.position / 5;
  switch (key) {
    case 'lending':
      return [
        `Supply: deposit $${half} (half of the $${f.position} plan) as collateral in ${f.name}'s main market on ${f.chain}; about $4 of gas and 10 minutes to confirm the supply.`,
        `Borrow loop: borrow $${fifth} of a stable asset against that supply and redeposit it once inside ${f.name}; about $6 of gas and 15 minutes, keeping the health factor above 2.0.`,
        `Habit: add $${fifth} of fresh supply to ${f.name} every week for four weeks; about $4 of gas and 10 minutes a week, so the position history is long and consistent.`,
      ];
    case 'trading':
      return [
        `Trade: swap $${half} (half of the $${f.position} plan) through ${f.name} on ${f.chain} in two clips; about $5 of fees and gas and 10 minutes for both swaps.`,
        `Provide: place $${fifth} into ${f.name}'s most active pair or vault so the wallet also earns fees; about $4 of gas and 10 minutes to enter the position.`,
        `Habit: route one $${fifth} swap through ${f.name} every week for four weeks; about $3 of fees and 10 minutes a week, building a steady volume record.`,
      ];
    case 'yield':
      return [
        `Deposit: put $${half} (half of the $${f.position} plan) into ${f.name}'s flagship vault on ${f.chain}; about $4 of gas and 10 minutes to confirm the deposit.`,
        `Compound: harvest and restake the first $${fifth} of rewards inside ${f.name} instead of selling them; about $3 of gas and 10 minutes per harvest.`,
        `Habit: add $${fifth} of fresh capital to ${f.name} every week for four weeks; about $4 of gas and 10 minutes a week, so the balance grows on a regular cadence.`,
      ];
    case 'staking':
      return [
        `Stake: stake $${half} (half of the $${f.position} plan) with ${f.name} on ${f.chain} and keep the receipt token in the same wallet; about $4 of gas and 10 minutes.`,
        `Restake: delegate $${fifth} of the receipt position through ${f.name}'s restaking route for the extra rewards layer; about $5 of gas and 15 minutes.`,
        `Habit: top the stake up by $${fifth} every week for four weeks; about $4 of gas and 10 minutes a week, and never unstake inside a lock window.`,
      ];
    case 'bridge':
      return [
        `Bridge: move $${half} (half of the $${f.position} plan) to ${f.chain} through ${f.name} and keep the arrival transaction as proof; about $6 of fees and 20 minutes.`,
        `Use: deploy $${fifth} of the bridged funds in a ${f.name} partner market on the destination chain the same day; about $4 of gas and 10 minutes.`,
        `Habit: bridge $${fifth} through ${f.name} every week for four weeks, alternating direction; about $6 of fees and 20 minutes a week of steady route history.`,
      ];
    case 'stable':
      return [
        `Mint or buy: acquire $${half} (half of the $${f.position} plan) of ${f.name}'s stable asset on ${f.chain}; about $4 of gas and 10 minutes to settle the position.`,
        `Pair: supply $${fifth} of that stable asset to ${f.name}'s main liquidity pair so the wallet earns fees as well; about $4 of gas and 10 minutes.`,
        `Habit: hold the ${f.name} position untouched for four full weeks and add $${fifth} each week; about $3 of gas and 5 minutes a week of balance history.`,
      ];
    case 'rwa':
      return [
        `Onboard: finish ${f.name}'s account and any identity check on ${f.chain}, then fund $${half} (half of the $${f.position} plan); about 30 minutes and $0 in fees.`,
        `Allocate: place $${fifth} into ${f.name}'s flagship real-world or payments product and save the position statement; about 15 minutes and $0 to $5 in fees.`,
        `Habit: move $${fifth} through ${f.name} every week for four weeks, by payment, card spend or deposit; about 10 minutes a week of genuine usage history.`,
      ];
    case 'infra':
      return [
        `Start: complete ${f.name}'s core action on ${f.chain} with $${half} (half of the $${f.position} plan) committed; about $4 of gas and 15 minutes for the first run.`,
        `Deepen: stake, lock or index $${fifth} through ${f.name} so the wallet holds a lasting position, not a single visit; about $4 of gas and 10 minutes.`,
        `Habit: repeat ${f.name}'s core action with $${fifth} every week for four weeks; about $3 of gas and 10 minutes a week, keeping the activity record unbroken.`,
      ];
    default:
      return [
        `Use: put $${half} (half of the $${f.position} plan) to work in ${f.name}'s main product on ${f.chain}; about $4 of gas and 15 minutes for the first position.`,
        `Explore: try ${f.name}'s second product with $${fifth} so the wallet shows real breadth of use, not one click; about $4 of gas and 15 minutes.`,
        `Habit: return to ${f.name} with $${fifth} of activity every week for four weeks; about $3 of gas and 10 minutes a week of consistent history.`,
      ];
  }
}

export function farmPlan(name: string, category: string, chain: string, position: number): string[] {
  const facts: PlanFacts = { name, chain, position };
  const [second, third, fourth] = middleSteps(playbookOf(category), facts);
  return [
    `Setup: open a fresh wallet for ${name}, fund it with $${position} on ${chain} plus about $12 for gas, and allow 20 minutes for the funding transfer to confirm.`,
    second,
    third,
    fourth,
    `Track: record every ${name} transaction hash, balance and points total in a spreadsheet each Sunday; 15 minutes a week and $0 cost until a snapshot or claim date is announced.`,
    `Claim readiness: keep $15 in reserve on ${chain} for claim gas, recheck ${name} eligibility once a month in 10 minutes at $0 cost, and exit within 7 days if the rewards end.`,
  ];
}

// ---------------------------------------------------------------------------
// The board itself: the full snapshot universe, exactly once each. Live
// protocols (a recorded market cap above zero) are carried at the market's
// own figure and labelled; every other protocol is priced by the ensemble
// fitted on all peers, with an honest interval of value x exp(+-1.645 sigma)
// where sigma is the ensemble's leave-one-out residual spread.
// ---------------------------------------------------------------------------

export function buildRadar(snapshot: Snapshot): Radar {
  const peers = snapshot.protocols.filter(isPeer);
  const validation = evaluate(snapshot, peers);
  const priceAll = ensembleFactory(snapshot.as_of)(peers);
  const watchlist = new Set(snapshot.watchlist);
  const band = 1.645 * validation.sigma;

  const drafted = snapshot.protocols.map((p) => {
    const live = p.mcap_usd !== null && p.mcap_usd > 0;
    const value = live ? Math.round(p.mcap_usd!) : Math.max(1, Math.round(priceAll(p)));
    const category = p.category ?? 'Other';
    const chain = p.chains[0] ?? 'Ethereum';
    const position = positionFor(p.tvl_usd);
    return {
      slug: p.slug,
      name: p.name,
      implied_value_usd: value,
      farm_steps: farmPlan(p.name, category, chain, position),
      category,
      chain,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d ?? 0,
      age_days: ageInDays(p, snapshot.as_of) ?? -1,
      low_usd: live ? value : Math.max(1, Math.round(value * Math.exp(-band))),
      high_usd: live ? value : Math.round(value * Math.exp(band)),
      live,
      watchlist: watchlist.has(p.slug),
      position_usd: position,
    };
  });
  drafted.sort((a, b) => b.implied_value_usd - a.implied_value_usd || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1));
  const rows: Row[] = drafted.map((row, at) => ({ ...row, rank: at + 1 }));
  return {
    rows,
    total: rows.length,
    pre_token: rows.filter((r) => !r.live).length,
    live: rows.filter((r) => r.live).length,
    watchlist_size: snapshot.watchlist.length,
    validation,
    as_of: snapshot.as_of,
  };
}

export function boardIssue(rows: Row[], snapshot: Snapshot): string | null {
  if (rows.length !== snapshot.protocols.length) {
    return `board carries ${rows.length} rows for ${snapshot.protocols.length} protocols`;
  }
  const slugs = new Set<string>();
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  let covered = 0;
  for (let at = 0; at < rows.length; at++) {
    const row = rows[at]!;
    if (row.rank !== at + 1) return `rank sequence breaks at ${row.slug}`;
    if (slugs.has(row.slug) || !known.has(row.slug)) return `slug problem at ${row.slug}`;
    slugs.add(row.slug);
    if (row.watchlist) covered++;
    if (!Number.isInteger(row.implied_value_usd) || row.implied_value_usd <= 0) return `value problem at ${row.slug}`;
    if (at > 0 && rows[at - 1]!.implied_value_usd < row.implied_value_usd) return `values rise at rank ${row.rank}`;
    if (row.farm_steps.length < 3 || row.farm_steps.length > 12) return `step count problem at ${row.slug}`;
    for (const step of row.farm_steps) {
      const length = step.trim().length;
      if (length < 20 || length > 600) return `step length ${length} at ${row.slug}`;
    }
  }
  if (covered !== snapshot.watchlist.length) return `watchlist covered ${covered} of ${snapshot.watchlist.length}`;
  return null;
}

export function dataScript(radar: Radar): string {
  const rows = radar.rows.map((r) => [
    r.slug, r.name, r.category, r.chain, r.tvl_usd, r.change_7d, r.age_days,
    r.implied_value_usd, r.low_usd, r.high_usd, r.live ? 1 : 0, r.watchlist ? 1 : 0, r.rank,
  ]);
  const payload = {
    as_of: radar.as_of,
    total: radar.total,
    pre_token: radar.pre_token,
    live: radar.live,
    watchlist: radar.watchlist_size,
    validation: radar.validation,
    rows,
  };
  return `window.RADAR = ${JSON.stringify(payload)};\n`;
}
