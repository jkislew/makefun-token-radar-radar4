// Token launch radar — program entry point (Node 22, standard library only).
//
// Reads the sealed snapshot (--input <file|dir>, default /input/snapshot.json),
// builds the full-universe board with lib/model.ts, and writes the hand-in
// into the output directory (MAKEFUN_OUTPUT_DIR, or /output in the grader's
// container): board.json, data.js for the dashboard, dashboard/ and
// screenshots/ copied from this repository, and dossier.json written last
// with the vendored make.fun library, byte for byte what the scorer rebuilds.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_LIMITS = { max: 4, max_bytes: 524_288 };
const DASHBOARD_LIMITS = { max_files: 400, max_bytes: 4_194_304 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

function argument(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const inline = process.argv.find((a) => a.startsWith(`--${name}=`));
  return inline === undefined ? fallback : inline.slice(name.length + 3);
}

const here = fileURLToPath(new URL('.', import.meta.url));
const inputArg = argument('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`radar: no snapshot at ${inputFile} — pass --input <snapshot.json|directory>\n`);
  process.exit(2);
}
const outDir = argument('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const radar = buildRadar(snapshot);
const problem = boardIssue(radar.rows, snapshot);
if (problem !== null) {
  process.stderr.write(`radar: the board fails its own shape check: ${problem}\n`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ rows: radar.rows })}\n`);
writeFileSync(join(outDir, 'data.js'), dataScript(radar));

function copyTree(from: string, to: string): string[] {
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

copyTree(join(here, 'dashboard'), join(outDir, 'dashboard'));
const shots = copyTree(join(here, 'screenshots'), join(outDir, 'screenshots'));
if (shots.length < 3 || shots.length > 4) {
  process.stderr.write(`radar: screenshots/ holds ${shots.length} images — hand in 3 or 4 (board, detail, filtered)\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`radar: screenshots/${name}: names are letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

const dossierText = buildDossier(outDir, {
  text_max_bytes: TEXT_MAX_BYTES,
  screenshots: SCREENSHOT_LIMITS,
  dashboard: DASHBOARD_LIMITS,
});
writeFileSync(join(outDir, 'dossier.json'), dossierText);

const v = radar.validation;
process.stdout.write(
  `radar: ${radar.total} protocols accounted for — ${radar.pre_token} pre-token ranked, ${radar.live} live at market cap, watchlist ${radar.watchlist_size}/${radar.watchlist_size} covered\n` +
    `radar: leave-one-out on ${v.peers} peers — ensemble log-MAE ${v.ensemble_log_mae}, within-2x ${v.ensemble_within_2x_pct}%, Spearman ${v.ensemble_spearman} (log-blend ${v.log_blend_log_mae}, plain blend ${v.plain_blend_log_mae})\n` +
    `radar: median across six schemes ${v.median_log_mae} against the previous generation's ${v.ancestor_median_log_mae}\n` +
    `radar: wrote board.json, data.js, dashboard/, screenshots/ (${shots.length}) and dossier.json to ${outDir}\n`,
);
