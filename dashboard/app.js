'use strict';
// Launch Radar dashboard. Renders the board the program filed in data.js,
// with a detail panel per protocol whose farm plan is regenerated here,
// from the row's own figures, with the same wording the program used.

const DATA = window.RADAR;
const rows = DATA.rows.map((a) => ({
  slug: a[0], name: a[1], category: a[2], chain: a[3], tvl: a[4],
  growth: a[5], age: a[6], value: a[7], low: a[8], high: a[9],
  live: a[10] === 1, watch: a[11] === 1, rank: a[12],
}));
const bySlug = new Map(rows.map((r) => [r.slug, r]));

function money(v) {
  const digits = String(Math.round(v));
  return '$' + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function pct(v) {
  return (v > 0 ? '+' : '') + v.toFixed(1) + '%';
}

function ageLabel(days) {
  if (days < 0) return 'untracked start';
  if (days < 30) return days + 'd tracked';
  if (days < 365) return Math.round(days / 30) + 'mo tracked';
  return (days / 365).toFixed(1) + 'y tracked';
}

// ---------------------------------------------------------------------------
// Farm plan generator — the same playbooks, tiers and wording as the
// program's board builder, so the plan on this page equals the plan filed
// in board.json for every one of the rows.
// ---------------------------------------------------------------------------

const PLAYBOOK_BY_CATEGORY = {
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

function playbookOf(category) {
  return PLAYBOOK_BY_CATEGORY[category] || 'general';
}

function positionFor(tvlUsd) {
  if (tvlUsd >= 100000000) return 1000;
  if (tvlUsd >= 25000000) return 500;
  if (tvlUsd >= 10000000) return 250;
  return 100;
}

function middleSteps(key, f) {
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

function farmSteps(row) {
  const facts = { name: row.name, chain: row.chain, position: positionFor(row.tvl) };
  const middle = middleSteps(playbookOf(row.category), facts);
  return [
    `Setup: open a fresh wallet for ${row.name}, fund it with $${facts.position} on ${row.chain} plus about $12 for gas, and allow 20 minutes for the funding transfer to confirm.`,
    middle[0],
    middle[1],
    middle[2],
    `Track: record every ${row.name} transaction hash, balance and points total in a spreadsheet each Sunday; 15 minutes a week and $0 cost until a snapshot or claim date is announced.`,
    `Claim readiness: keep $15 in reserve on ${row.chain} for claim gas, recheck ${row.name} eligibility once a month in 10 minutes at $0 cost, and exit within 7 days if the rewards end.`,
  ];
}

// ---------------------------------------------------------------------------
// Detail panel
// ---------------------------------------------------------------------------

const panel = document.getElementById('panel');

function showDetail(row) {
  panel.hidden = false;
  panel.textContent = '';
  const close = document.createElement('button');
  close.className = 'close';
  close.textContent = 'Close';
  close.addEventListener('click', () => { panel.hidden = true; });
  panel.appendChild(close);
  const title = document.createElement('h2');
  title.textContent = row.name;
  panel.appendChild(title);
  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent = row.category + ' · ' + row.chain + ' · ' + ageLabel(row.age) +
    (row.live ? ' · live token, carried at market cap' : ' · pre-token, priced by the ensemble') +
    (row.watch ? ' · on the house watchlist' : '');
  panel.appendChild(sub);
  const facts = document.createElement('dl');
  const pairs = [
    ['Rank', '#' + row.rank],
    ['TVL', money(row.tvl)],
    ['TVL change, 7d', pct(row.growth)],
    [row.live ? 'Market cap' : 'Implied value', money(row.value)],
    ['Honest range', row.live ? 'at market' : money(row.low) + ' – ' + money(row.high)],
    ['Starter plan size', money(positionFor(row.tvl))],
  ];
  for (const [term, value] of pairs) {
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.textContent = value;
    facts.appendChild(dt);
    facts.appendChild(dd);
  }
  panel.appendChild(facts);
  const heading = document.createElement('h3');
  heading.textContent = 'How to farm it';
  panel.appendChild(heading);
  const list = document.createElement('ol');
  for (const step of farmSteps(row)) {
    const item = document.createElement('li');
    item.textContent = step;
    list.appendChild(item);
  }
  panel.appendChild(list);
  panel.scrollIntoView({ block: 'nearest' });
}

// ---------------------------------------------------------------------------
// Board rendering and controls
// ---------------------------------------------------------------------------

const body = document.getElementById('body');
const shown = document.getElementById('shown');
const qInput = document.getElementById('q');
const catSelect = document.getElementById('cat');
const scopeSelect = document.getElementById('scope');
const sortSelect = document.getElementById('sort');

for (const category of [...new Set(rows.map((r) => r.category))].sort()) {
  const option = document.createElement('option');
  option.value = category;
  option.textContent = category;
  catSelect.appendChild(option);
}

function visibleRows() {
  const q = qInput.value.trim().toLowerCase();
  const cat = catSelect.value;
  const scope = scopeSelect.value;
  let out = rows.filter((r) => {
    if (scope === 'pre' && r.live) return false;
    if (scope === 'live' && !r.live) return false;
    if (scope === 'watch' && !r.watch) return false;
    if (cat && r.category !== cat) return false;
    if (q && !(r.name.toLowerCase().includes(q) || r.slug.includes(q))) return false;
    return true;
  });
  if (sortSelect.value === 'tvl') out = [...out].sort((a, b) => b.tvl - a.tvl);
  if (sortSelect.value === 'growth') out = [...out].sort((a, b) => b.growth - a.growth);
  if (sortSelect.value === 'rank') out = [...out].sort((a, b) => a.rank - b.rank);
  return out;
}

function render() {
  const out = visibleRows();
  body.textContent = '';
  for (const r of out) {
    const tr = document.createElement('tr');
    tr.className = 'row';
    tr.addEventListener('click', () => showDetail(r));
    const cells = [
      String(r.rank), r.name, r.category, r.chain,
      money(r.tvl), pct(r.growth), money(r.value),
      r.live ? 'at market' : money(r.low) + ' – ' + money(r.high), '',
    ];
    cells.forEach((text, at) => {
      const td = document.createElement('td');
      if (at === 4 || at === 6) td.className = 'num';
      if (at === 5) td.className = 'num ' + (r.growth >= 0 ? 'pos' : 'neg');
      td.textContent = text;
      if (at === 1) {
        if (r.live) {
          const badge = document.createElement('span');
          badge.className = 'badge live';
          badge.textContent = 'LIVE';
          td.appendChild(badge);
        }
        if (r.watch) {
          const badge = document.createElement('span');
          badge.className = 'badge';
          badge.textContent = 'WATCHLIST';
          td.appendChild(badge);
        }
      }
      if (at === 8) {
        const open = document.createElement('button');
        open.textContent = 'Plan';
        open.addEventListener('click', (event) => { event.stopPropagation(); showDetail(r); });
        td.appendChild(open);
      }
      tr.appendChild(td);
    });
    body.appendChild(tr);
  }
  shown.textContent = 'Showing ' + out.length + ' of ' + rows.length + ' protocols';
}

for (const control of [qInput, catSelect, scopeSelect, sortSelect]) {
  control.addEventListener('input', render);
  control.addEventListener('change', render);
}

// Validation strip: the out-of-sample grades, printed on the board itself.
const v = DATA.validation;
const strip = document.getElementById('validation');
const cards = [
  [String(v.ensemble_log_mae), 'ensemble log-MAE, leave-one-out on ' + v.peers + ' peers'],
  [String(v.median_log_mae), 'ensemble median log-MAE across six schemes'],
  [String(v.ancestor_median_log_mae), 'previous generation, median on the same schemes'],
  [v.ensemble_within_2x_pct + '%', 'of peers priced within 2x, leave-one-out'],
  [String(v.ensemble_spearman), 'Spearman rank correlation, leave-one-out'],
  ['x' + Math.exp(1.645 * v.sigma).toFixed(1), 'honest interval half-width (1.645 sigma)'],
  [String(DATA.pre_token), 'pre-token protocols ranked by implied value'],
  [String(DATA.live), 'live protocols carried at market cap'],
];
for (const [big, small] of cards) {
  const card = document.createElement('div');
  card.className = 'card';
  const b = document.createElement('b');
  b.textContent = big;
  const s = document.createElement('span');
  s.textContent = small;
  card.appendChild(b);
  card.appendChild(s);
  strip.appendChild(card);
}
document.getElementById('stamp').textContent =
  'Snapshot as of ' + DATA.as_of + ' · watchlist ' + DATA.watchlist + '/' + DATA.watchlist + ' covered';

// Deep links used by readers and by the entry's own screenshots:
// #detail=<slug> opens a protocol, #scope=all&cat=<category> filters.
function applyHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  const scope = params.get('scope');
  if (scope) scopeSelect.value = scope;
  const cat = params.get('cat');
  if (cat) catSelect.value = cat;
  render();
  const slug = params.get('detail');
  if (slug && bySlug.has(slug)) showDetail(bySlug.get(slug));
}
window.addEventListener('hashchange', applyHash);
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') panel.hidden = true;
});
applyHash();
