// Token Radar: a pre-token protocol board, scored from the sealed snapshot alone.
//
// The program reads the sealed snapshot from /input/snapshot.json (or --input <file|dir>),
// scores every pre-token protocol that can plausibly launch a token of its own, writes the
// ranked board to /output/board.json, writes the dashboard's data beside the page as data.js,
// copies this repository's dashboard/ and screenshots/ to /output, and writes
// /output/dossier.json with the vendored make.fun library.
//
// The model ("radar-2") is derived from the snapshot's own figures, never from a list of names:
//   anchor  = the category's median market-cap/TVL among the protocols whose token already
//             trades, pulled toward the market-wide median when the category has few live
//             protocols (shrinkage), and capped at 1.0x TVL: no token is assumed to be worth
//             more than the value locked in its protocol.
//   base    = tvl_usd x anchor
//   growth  = 1 + clamp(change_7d, -50, +100) / 100 x 0.6
//   age     = days since first listed (median pre-token age when unlisted: 516 days here)
//   mature  = 0.65 + 0.35 x ln(1 + min(age, 1460)) / ln(1 + 1460)
//   implied = max(1, round(base x growth x mature))
//
// Protocols that cannot launch a token of their own are set aside, not ranked: bridges and
// canonical bridges, wrapped/staked products, exchanges, and versioned pools. The watchlist's
// own rule is applied to the whole board, so the top of the board is never WBTC or an exchange.
// The set-aside list is shown on the dashboard with its reason, and the live-token protocols
// are shown with their market caps: the board separates what trades from what is still to come.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps (reference/gate.json): the text cap shapes the bytes, the rest refuse. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** The model's version label: the dashboard names it. */
const MODEL_VERSION = 'radar-2';

/** Shrinkage: a category's anchor is pulled toward the market median with this prior weight. */
const PRIOR_WEIGHT = 8;
/** No category's anchor is assumed above 1.0x TVL, nor below 0.05x. */
const ANCHOR_CAP = 1.0;
const ANCHOR_FLOOR = 0.05;
/** Growth: seven-day TVL change, clamped, weighted. */
const GROWTH_FLOOR = -50;
const GROWTH_CAP = 100;
const GROWTH_WEIGHT = 0.6;
/** Maturity: a log curve over at most 1460 days, from 0.65 to 1.00. */
const MATURITY_FLOOR = 0.65;
const MATURITY_RANGE = 0.35;
const MATURITY_DAYS = 1460;
/** How many live-token protocols the dashboard's Live view carries, by market cap. */
const LIVE_ROWS = 24;

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
interface SnapshotProtocol {
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

/** The whole snapshot document. */
interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** One category's anchor: the live median, its sample size, and the shrunk value the model uses. */
interface Anchor {
  category: string;
  live_n: number;
  live_median: number | null;
  anchor: number;
}

/** One row of board.json: the ranked board's row. */
interface BoardRow {
  rank: number;
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
  token_status: 'pre-token';
  watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  model: {
    anchor: number;
    anchor_live_n: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value. */
interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** A protocol set aside from the ranking, with the reason it cannot launch a token of its own. */
interface SetAsideRow {
  slug: string;
  name: string;
  category: string | null;
  tvl_usd: number;
  reason: string;
}

/** Everything the dashboard needs: the board, the live set, the anchors, and the set-aside list. */
interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: {
    version: string;
    prior_weight: number;
    anchor_cap: number;
    anchor_floor: number;
    growth_floor: number;
    growth_cap: number;
    growth_weight: number;
    maturity_floor: number;
    maturity_range: number;
    maturity_days: number;
    unknown_age_days: number;
    global_median: number;
  };
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  set_aside_size: number;
  anchors: Anchor[];
  rows: RadarRow[];
  live: LiveRow[];
  set_aside: SetAsideRow[];
}

/** The dashboard's compact view of one row. */
interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  watchlist: boolean;
  implied_value_usd: number;
  anchor: number;
  anchor_live_n: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  farm_steps: string[];
}

/** Why the snapshot is not one this model can score. */
class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** The median of a sorted array, or null when it holds nothing. */
function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.floor(sorted.length / 2)]!;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
/** Categories that are a wrapped, staked or bridged product of a token that already trades. */
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
/** A name carrying one of these whole words is a wrapped or staked product, not a launch. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
/** A name beginning with an exchange's name is that exchange's product. */
const EXCHANGE_START = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/i;

/** Whether a protocol records no token at all. */
function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Why a pre-token protocol cannot launch a token of its own, or null when it can. */
function setAsideReason(p: SnapshotProtocol): string | null {
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) {
    if (p.category === 'CEX') return 'an exchange, not a protocol launch';
    return `a ${p.category.toLowerCase()} product of a token that already trades`;
  }
  if (WRAPPED_WORD.test(p.name)) return 'a wrapped or staked product of a token that already trades';
  if (EXCHANGE_START.test(p.name)) return "an exchange's own product, not a standalone launch";
  if (VERSIONED.test(p.name)) return 'a versioned pool of another protocol';
  return null;
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** The category anchors, from the live-token protocols' own market-cap/TVL ratios. */
function buildAnchors(snapshot: Snapshot): { anchors: Anchor[]; globalMedian: number } {
  const live = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const ratios = live.map((p) => p.mcap_usd! / p.tvl_usd).sort((a, b) => a - b);
  const globalMedian = median(ratios) ?? 0.2;
  const byCategory = new Map<string, number[]>();
  for (const p of live) {
    const c = p.category ?? 'Other';
    const list = byCategory.get(c) ?? [];
    list.push(p.mcap_usd! / p.tvl_usd);
    byCategory.set(c, list);
  }
  const anchors: Anchor[] = [];
  for (const [category, list] of [...byCategory.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const sorted = list.sort((a, b) => a - b);
    const liveMedian = median(sorted);
    const shrunk = (sorted.length * (liveMedian ?? globalMedian) + PRIOR_WEIGHT * globalMedian) / (sorted.length + PRIOR_WEIGHT);
    anchors.push({ category, live_n: sorted.length, live_median: liveMedian === null ? null : round4(liveMedian), anchor: round4(Math.min(ANCHOR_CAP, Math.max(ANCHOR_FLOOR, shrunk))) });
  }
  return { anchors, globalMedian: round4(globalMedian) };
}

/** The anchor a category scores with: its own shrunk anchor, or the market median when unlisted. */
function anchorFor(anchors: Anchor[], globalMedian: number, category: string | null): { anchor: number; liveN: number } {
  const hit = anchors.find((a) => a.category === (category ?? 'Other'));
  if (hit === undefined) return { anchor: globalMedian, liveN: 0 };
  return { anchor: hit.anchor, liveN: hit.live_n };
}

/** The multipliers and the implied value one protocol gets under the model. */
function impliedValue(
  p: SnapshotProtocol,
  asOf: string,
  anchor: number,
  unknownAgeDays: number,
): { implied: number; growthPct: number; growthMult: number; maturityMult: number; age: number | null } {
  const age = ageDays(asOf, p.listed_at);
  const rawGrowth = finite(p.change_7d, 0);
  const growthPct = Math.min(GROWTH_CAP, Math.max(GROWTH_FLOOR, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * GROWTH_WEIGHT;
  const ageForModel = age ?? unknownAgeDays;
  const maturityMult = MATURITY_FLOOR + (Math.log(1 + Math.min(Math.max(ageForModel, 0), MATURITY_DAYS)) / Math.log(1 + MATURITY_DAYS)) * MATURITY_RANGE;
  const base = p.tvl_usd * anchor;
  const implied = Math.max(1, Math.round(base * growthMult * maturityMult));
  return { implied, growthPct, growthMult, maturityMult, age };
}

// ---------------------------------------------------------------- farm plans

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
function stepText(text: string, cost: string, time: string): string {
  let s = `${text} Cost: ${cost}. Time: ${time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** What one transaction costs on a chain: gas follows the chain, not the protocol. */
function gasFor(chain: string): string {
  const c = chain.toLowerCase();
  if (c === 'ethereum') return 'about $4–$10 of gas per transaction';
  if (c === 'solana') return 'a few cents of gas per transaction';
  if (c === 'base' || c === 'arbitrum' || c === 'optimism' || c === 'zksync era' || c === 'polygon' || c === 'bnb chain' || c === 'avalanche') {
    return 'under $1 of gas per transaction';
  }
  return 'about $1–$3 of gas per transaction';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's first action, in the words a farmer can follow. */
function primaryAction(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('yield aggregator') || c.includes('yield')) return `Deposit $${capital} of USDC into ${name}'s highest-TVL vault on ${chain} and let it compound.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedged position.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one position on a market on ${name} that resolves after the snapshot.`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('onchain capital')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares for the full term.`;
  if (c.includes('stable') || c.includes('cdp')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield-bearing asset on ${chain} and hold it.`;
  if (c.includes('restak') || c.includes('staking pool')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt token.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active.`;
  if (c.includes('launchpad')) return `Stake $${capital} to join ${name}'s next sale on ${chain} and complete the sale's steps.`;
  if (c.includes('privacy')) return `Deposit $${capital} through ${name}'s private pool on ${chain} and keep the note safe.`;
  if (c.includes('nft')) return `List or buy one NFT through ${name} on ${chain} for about $${capital} and hold it.`;
  if (c.includes('payment')) return `Route $${capital} of payments through ${name} on ${chain} and keep the receipts.`;
  if (c.includes('chain')) return `Bridge $${capital} to ${name}'s chain and use it in one of its native apps.`;
  if (c.includes('index')) return `Buy $${capital} of the ${name} index on ${chain} and hold the position.`;
  if (c.includes('ai') || c.includes('decentralized ai')) return `Pay $${capital} for compute or an agent run through ${name} on ${chain} and keep the job receipts.`;
  if (c.includes('basis')) return `Deposit $${capital} into ${name}'s basis vault on ${chain} and keep the position open.`;
  if (c.includes('locker')) return `Lock $${capital} of tokens in ${name} on ${chain} for the shortest term it offers.`;
  if (c.includes('liquidity manager')) return `Deposit $${capital} into a ${name}-managed pool on ${chain} and leave the range to the manager.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** The category's second leg: a farm that does one thing once is easy to discount. */
function secondLeg(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Borrow up to a third of your supplied value from ${name} and use the borrowed funds in one more on-chain action.`;
  if (c.includes('dex') || c.includes('leveraged farm')) return `Route one swap through the same pool and claim any trading fees the position earned.`;
  if (c.includes('yield aggregator') || c.includes('yield')) return `Move the vault's rewards into the same vault once so the compounding is on record.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options')) return `Close the hedge, keep the margin on ${name}, and open a second small position in the other direction.`;
  if (c.includes('prediction')) return `Place a second, smaller position on a different market on ${name}.`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('onchain capital')) return `Join the vault's next rebalancing window so the position is counted in two allocation rounds.`;
  if (c.includes('rwa')) return `Check the asset's redemption terms on ${name} and redeem a small part to prove the exit works.`;
  if (c.includes('restak') || c.includes('staking pool')) return `Use the receipt token as collateral in one lending market on ${chain}.`;
  if (c.includes('stable')) return `Swap a part of the stable asset back through ${name} so both directions are on record.`;
  if (c.includes('launchpad')) return `Vote or complete the sale's community task on ${name} after the stake is in.`;
  if (c.includes('privacy')) return `Withdraw a small part through ${name} to a fresh address and keep the note's record.`;
  if (c.includes('chain')) return `Use the bridged funds in a second native app on ${name}'s chain.`;
  if (c.includes('ai') || c.includes('decentralized ai')) return `Run a second, different job through ${name} so two job types are on record.`;
  if (c.includes('locker')) return `Extend the lock by one term once the first term is recorded.`;
  if (c.includes('index')) return `Rebalance the ${name} index position once, in either direction.`;
  return `Do one more action on ${name} in a different week, such as a second deposit or a vote.`;
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time. The plan is derived
 * from the protocol's own record (category, chains, TVL, age), never from a hand-written list of names.
 */
function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = gasFor(chain);
  return [
    stepText(
      'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.',
      'under $3 of gas for the first transaction',
      '5 minutes',
    ),
    stepText(primaryAction(p, capital, chain), `$${capital} of capital and ${gas}`, '15 minutes to set up'),
    stepText(secondLeg(p, capital, chain), `$${Math.max(10, Math.round(capital / 3))} of capital and ${gas}`, '10 minutes'),
    stepText(
      'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.',
      'about $2 of gas a week',
      '10 minutes a week',
    ),
    stepText(
      `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      `the $${capital} stays in the position`,
      `${hold} days`,
    ),
    stepText(
      "Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.",
      'no fee to check, and never pay to claim',
      '10 minutes',
    ),
    stepText(
      'Write the wallet, the dates and every transaction in a farm log, and unwind in the reverse order you entered.',
      'nothing but the log',
      '5 minutes',
    ),
  ];
}

// ---------------------------------------------------------------- the board

/** The protocols the board ranks, strongest first, with ranks 1..n. */
function buildBoard(snapshot: Snapshot, anchors: Anchor[], globalMedian: number, unknownAgeDays: number): { board: BoardRow[]; setAside: SetAsideRow[] } {
  const watchlist = new Set(snapshot.watchlist);
  const board: BoardRow[] = [];
  const setAside: SetAsideRow[] = [];
  for (const p of snapshot.protocols) {
    if (!isPreToken(p)) continue;
    const reason = setAsideReason(p);
    if (reason !== null) {
      setAside.push({ slug: p.slug, name: p.name, category: p.category, tvl_usd: p.tvl_usd, reason });
      continue;
    }
    const { anchor, liveN } = anchorFor(anchors, globalMedian, p.category);
    const { implied, growthPct, growthMult, maturityMult, age } = impliedValue(p, snapshot.as_of, anchor, unknownAgeDays);
    board.push({
      rank: 0,
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      mcap_usd: p.mcap_usd,
      listed_at: p.listed_at,
      gecko_id: p.gecko_id,
      symbol: p.symbol,
      token_status: 'pre-token',
      watchlist: watchlist.has(p.slug),
      age_days: age,
      implied_value_usd: implied,
      model: {
        anchor,
        anchor_live_n: liveN,
        growth_pct: growthPct,
        growth_multiplier: round4(growthMult),
        maturity_multiplier: round4(maturityMult),
        age_days: age,
      },
      farm_steps: farmSteps(p, age),
    });
  }
  board.sort((a, b) => b.implied_value_usd - a.implied_value_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  board.forEach((r, i) => {
    r.rank = i + 1;
  });
  setAside.sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  return { board, setAside };
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** Everything the dashboard renders, from the snapshot. */
function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const { anchors, globalMedian } = buildAnchors(snapshot);
  const preToken = snapshot.protocols.filter(isPreToken);
  const ages = preToken
    .map((p) => ageDays(snapshot.as_of, p.listed_at))
    .filter((a): a is number => a !== null)
    .sort((a, b) => a - b);
  const unknownAgeDays = median(ages) ?? 365;
  const { board, setAside } = buildBoard(snapshot, anchors, globalMedian, unknownAgeDays);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !r.watchlist).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model: {
      version: MODEL_VERSION,
      prior_weight: PRIOR_WEIGHT,
      anchor_cap: ANCHOR_CAP,
      anchor_floor: ANCHOR_FLOOR,
      growth_floor: GROWTH_FLOOR,
      growth_cap: GROWTH_CAP,
      growth_weight: GROWTH_WEIGHT,
      maturity_floor: MATURITY_FLOOR,
      maturity_range: MATURITY_RANGE,
      maturity_days: MATURITY_DAYS,
      unknown_age_days: unknownAgeDays,
      global_median: globalMedian,
    },
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    set_aside_size: setAside.length,
    anchors,
    rows: board.map((r) => ({
      rank: r.rank,
      slug: r.slug,
      name: r.name,
      category: r.category,
      chains: r.chains,
      tvl_usd: r.tvl_usd,
      change_7d: r.change_7d,
      mcap_usd: r.mcap_usd,
      listed_at: r.listed_at,
      age_days: r.age_days,
      watchlist: r.watchlist,
      implied_value_usd: r.implied_value_usd,
      anchor: r.model.anchor,
      anchor_live_n: r.model.anchor_live_n,
      growth_multiplier: r.model.growth_multiplier,
      maturity_multiplier: r.model.maturity_multiplier,
      farm_steps: r.farm_steps,
    })),
    live,
    set_aside: setAside,
  };
  return { board, radar };
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

// ---------------------------------------------------------------- the program

/** --name <value> out of the arguments, or the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(radar));

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));

process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside, ${radar.set_aside_size} set aside)\n` +
    `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')} (3 files), ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
);
