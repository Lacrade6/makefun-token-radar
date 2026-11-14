// Token Radar — the entrypoint for make.fun's token-radar-01 bounty.
//
// The job: turn one sealed snapshot of the protocol universe into the
// ranked board the judge reads, then lay out the dashboard, the
// screenshots and the dossier the judge reads alongside it.
//
// The program is a straight line, four steps in order:
//   1. Load the snapshot. It is a JSON document: a list of protocols, a
//      watchlist of the ones with no token on record, a TVL floor, and the
//      date the data was fetched. Nothing here is fetched live; the file is
//      sealed and every run reads the same bytes.
//   2. Score it. The model in lib/model.ts ranks the pre-token protocols
//      the watchlist rule would keep and writes a farm plan for each one.
//      The model is a function of the snapshot's own figures only (TVL,
//      seven-day growth, age with no token). No name is special-cased.
//   3. Write the outputs. board.json carries the ranked rows, data.js
//      carries the same board for the dashboard page, dashboard/ and
//      screenshots/ are copied through unchanged.
//   4. Build the dossier. The vendored library turns /output into the
//      single JSON document the judge reads: the screenshots plus the
//      dashboard source, in a fixed shape.
//
// The program uses only Node 22's standard library and touches no network.
// The grader runs it in a sandbox with /input mounted read-only and
// /output writable:
//   node main.ts
// While developing, --input / --output (or MAKEFUN_OUTPUT_DIR) point it
// elsewhere, as this example shows:
//   MAKEFUN_OUTPUT_DIR=out node main.ts --input ../token-radar-01-kit/input/snapshot.json
//
// Every failure is loud and early: a missing snapshot, a board the gate
// would refuse, too few screenshots, or a bad screenshot name all print
// one line to stderr and exit non-zero, so a broken entry is never
// mistaken for a valid one.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  boardIssue as checkBoard,
  buildRadar as scoreSnapshot,
  dataScript as renderData,
  parseSnapshot as readSnapshot,
} from './lib/model.ts';
import { buildDossier as writeDossier } from './vendor/makefun-board.ts';

// The directory this file lives in: dashboard/ and screenshots/ sit next to it.
const repoRoot = fileURLToPath(new URL('.', import.meta.url));

// The dossier caps the gate enforces. The text cap keeps the dashboard
// source small enough that the dossier shows it whole; the screenshot and
// dashboard caps are the gate's own limits (see the competition's RULES).
const DOSSIER_TEXT_CAP = 65_536;
const SHOT_LIMITS = { max: 4, max_bytes: 524_288 };
const DASHBOARD_LIMITS = { max_files: 400, max_bytes: 4_194_304 };
// Screenshot filenames: letters, digits, dot, underscore and dash only,
// 1 to 128 characters, and never starting with a dot or a dash.
const SHOT_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** The program's version, printed by --version. */
const PROGRAM_VERSION = 'token-radar-01 radar-2';

/** Print how to run the program, then stop successfully. */
function printUsage(): void {
  process.stdout.write(
    [
      'token radar — make.fun token-radar-01 entry',
      '',
      'Usage: node main.ts [--input <snapshot.json|directory>] [--output <directory>]',
      '  --input    snapshot file or directory (default /input)',
      '  --output   output directory (default $MAKEFUN_OUTPUT_DIR or /output)',
      '  --help     show this text and stop',
      '  --version  print the version and stop',
      '',
      'Reads the sealed snapshot, scores the pre-token protocols, and writes',
      'board.json, data.js, dashboard/, screenshots/ and dossier.json.',
    ].join('\n') + '\n',
  );
}

/** A fatal complaint: print it and stop with a non-zero exit code. */
function fail(message: string, code = 1): never {
  process.stderr.write(`token radar: ${message}\n`);
  process.exit(code);
}

/** Read a --name value or --name=value out of argv, or the fallback. */
function readFlag(name: string, fallback: string): string {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === `--${name}` && i + 1 < argv.length) return argv[i + 1]!;
    if (token.startsWith(`--${name}=`)) return token.slice(name.length + 3);
  }
  return fallback;
}

/** The snapshot file: --input names a directory or the JSON file itself. */
function snapshotFile(): string {
  const given = readFlag('input', '/input');
  return given.endsWith('.json') ? given : path.join(given, 'snapshot.json');
}

/** Where the outputs go: --output beats the env var, which beats /output. */
function outputDir(): string {
  return readFlag('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');
}

/** Make a directory and its parents when they are missing. */
function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Copy one directory's regular files into the target, skipping names that
 * start with a dot. Returns the names that were copied, in directory order.
 */
function mirrorDirectory(from: string, to: string): string[] {
  if (!fs.existsSync(from)) return [];
  ensureDir(to);
  const copied: string[] = [];
  for (const name of fs.readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const source = path.join(from, name);
    if (!fs.statSync(source).isFile()) continue;
    fs.copyFileSync(source, path.join(to, name));
    copied.push(name);
  }
  return copied;
}

/** Refuse a screenshot set that is too small or has a bad filename. */
function checkShots(shots: string[]): void {
  if (shots.length < 3) {
    fail(`screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'} — hand in 3: the board, a detail view and a filtered view`);
  }
  for (const name of shots) {
    if (!SHOT_NAME.test(name)) {
      fail(`screenshots/${name} is not a legal screenshot name — letters, digits and . _ -, 1 to 128 characters`);
    }
  }
}

function main(): void {
  // --help and --version are answered before anything is read: they need
  // no snapshot and write nothing, so they never touch /input or /output.
  const argv = process.argv.slice(2);
  if (argv.includes('--help')) {
    printUsage();
    return;
  }
  if (argv.includes('--version')) {
    process.stdout.write(`token radar ${PROGRAM_VERSION}\n`);
    return;
  }

  // Step 1: load the snapshot. A missing file is a hard stop: the entry
  // cannot be scored from nothing, and the grader must hear about it.
  const snapFile = snapshotFile();
  if (!fs.existsSync(snapFile)) {
    fail(`no snapshot at ${snapFile} — pass --input <snapshot.json|directory> or mount the sealed /input`, 2);
  }
  const snapshot = readSnapshot(fs.readFileSync(snapFile, 'utf8'));

  // Step 2: score it. The model ranks the pre-token protocols and writes
  // every row's farm plan; checkBoard refuses a board the gate would
  // refuse (missing watchlist slugs, broken ranks, a flat implied value,
  // or a farm step outside the gate's length limits).
  const { board, radar } = scoreSnapshot(snapshot);
  const issue = checkBoard(board, snapshot);
  if (issue !== null) fail(`the model wrote a board the gate refuses: ${issue}`);

  // --dry-run stops after scoring: it prints the strongest rows and the
  // headline figures, and writes nothing, so a model change can be checked
  // without touching /output.
  if (argv.includes('--dry-run')) {
    const strongest = board.slice(0, 5);
    process.stdout.write(
      `token radar (dry run): ${board.length} rows scored, top implied $${board[0]!.implied_value_usd.toLocaleString('en-US')}\n` +
        strongest.map((r) => `  #${r.rank} ${r.name} — $${r.implied_value_usd.toLocaleString('en-US')}`).join('\n') +
        '\n',
    );
    return;
  }

  // Step 3: write the board and the dashboard data, then copy the
  // dashboard and the screenshots through unchanged.
  const out = outputDir();
  ensureDir(out);
  fs.writeFileSync(path.join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
  fs.writeFileSync(path.join(out, 'data.js'), renderData(radar));
  mirrorDirectory(path.join(repoRoot, 'dashboard'), path.join(out, 'dashboard'));
  const shots = mirrorDirectory(path.join(repoRoot, 'screenshots'), path.join(out, 'screenshots'));
  checkShots(shots);

  // Step 4: the dossier, written last. The scorer rebuilds it from this
  // /output and compares it byte for byte, so it must be written from the
  // finished directory, never from a half-built one.
  fs.writeFileSync(
    path.join(out, 'dossier.json'),
    writeDossier(out, {
      text_max_bytes: DOSSIER_TEXT_CAP,
      screenshots: SHOT_LIMITS,
      dashboard: DASHBOARD_LIMITS,
    }),
  );

  // The run is valid. Say what was scored and what was written, so the
  // log alone shows whether the entry that ran is the one that was meant to.
  const earlyCount = radar.early_size;
  const liveCount = radar.live_size;
  process.stdout.write(
    `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${earlyCount} early, ${liveCount} live set aside)\n` +
      `token radar: wrote ${path.join(out, 'board.json')}, ${path.join(out, 'data.js')}, ${path.join(out, 'dashboard')} (3 files), ${path.join(out, 'screenshots')} (${shots.length} images) and ${path.join(out, 'dossier.json')}\n`,
  );
}

main();
