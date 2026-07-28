import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const tools = path.join(root, 'phone-paradigm/device/phone-tools');
const read = (name) => fs.readFileSync(path.join(tools, name), 'utf8');

function sliceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing start marker: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing end marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

function assertResolvedBrowseEnv(callsite, label) {
  assert.match(
    callsite,
    /EVOGENT_BROWSE_MODEL="\$BROWSE_MODEL"/,
    `${label} must inherit the cycle's resolved browse model`,
  );
  assert.match(
    callsite,
    /EVOGENT_BROWSE_REASONING="\$BROWSE_EFFORT"/,
    `${label} must inherit the cycle's resolved browse effort`,
  );
}

test('cycle passes one resolved browse route to every routine Python browse child', () => {
  const cycle = read('evogent-cycle.sh');

  assert.match(cycle, /resolve_model_route browse_youtube/);
  const promptBrowse = sliceBetween(
    cycle,
    'browse_source(){',
    '# Run one prompt-driven source only when due.',
  );
  assert.match(
    promptBrowse,
    /if \[ "\$src" = youtube \]; then[\s\S]*?route_model="\$YOUTUBE_BROWSE_MODEL"[\s\S]*?route_effort="\$YOUTUBE_BROWSE_EFFORT"/,
  );
  assert.match(
    promptBrowse,
    /codex exec --model "\$route_model" -c model_reasoning_effort="\$route_effort"/,
  );

  assertResolvedBrowseEnv(
    sliceBetween(cycle, 'run_owned_timeout 900 30 env', 'xrc=$?'),
    'X extraction',
  );
  assertResolvedBrowseEnv(
    sliceBetween(cycle, 'run_owned_timeout 340 20 env INTEREST_BUDGET=300', 'IB_RC=$?'),
    'standing-interest extraction',
  );
  assertResolvedBrowseEnv(
    sliceBetween(cycle, 'for rf in "$EVO"/data/phone-sources/*.py', 'r_rc=$?'),
    'private Python recipes',
  );
  assertResolvedBrowseEnv(
    sliceBetween(cycle, 'say "shipment-judgment:', 'else\n  say "source-browse: skipped'),
    'shipment judgment',
  );
  assertResolvedBrowseEnv(
    sliceBetween(cycle, 'QB=$(env', 'say "quote-tweets:'),
    'quote backfill',
  );

  const appResearch = sliceBetween(
    cycle,
    'say "app-research: dispatching research agent',
    'research_rc=$?',
  );
  assert.match(appResearch, /--model "\$BROWSE_MODEL"/);
  assert.match(appResearch, /model_reasoning_effort="\$BROWSE_EFFORT"/);
});

test('routine helpers consume the propagated effort and retain standalone defaults', () => {
  const helpers = [
    ['browse-x-scrape.py', 'EXTRACT_EFFORT', 'low'],
    ['browse-interests.py', 'BROWSE_EFFORT', 'low'],
    ['browse-instagram.py', 'BROWSE_EFFORT', 'low'],
    ['taste-score.py', 'EFFORT', 'medium'],
    ['backfill-quote-tweets.py', 'EFFORT', 'low'],
  ];

  for (const [name, binding, standaloneDefault] of helpers) {
    const source = read(name);
    const assignment = new RegExp(
      `${binding} = os\\.environ\\.get\\("EVOGENT_BROWSE_REASONING", "${standaloneDefault}"\\)`,
    );
    const commandUse = new RegExp(`model_reasoning_effort=\\{${binding}\\}`);
    assert.match(source, assignment, `${name} must accept a per-run effort override`);
    assert.match(source, commandUse, `${name} must pass the selected effort to Codex`);
    assert.doesNotMatch(
      source,
      /"model_reasoning_effort=(?:low|medium|high|xhigh|max|ultra)"/,
      `${name} must not hardcode its Codex effort`,
    );
  }
});

test('independent and deterministic lanes do not acquire browse-route authority', () => {
  const cycle = read('evogent-cycle.sh');
  const discovery = read('source-discovery.sh');

  const diagnosis = sliceBetween(
    cycle,
    'dispatching diagnosis agent',
    'return 0',
  );
  assert.match(diagnosis, /--model "\$DIAGNOSIS_MODEL"/);
  assert.match(diagnosis, /model_reasoning_effort="\$DIAGNOSIS_EFFORT"/);

  const curation = sliceBetween(
    cycle,
    '# ---------- 2. Curation:',
    '# ---------- 4. Durable source discovery',
  );
  assert.match(curation, /"codexModel":sys\.argv\[5\]/);
  assert.doesNotMatch(curation, /--model "\$BROWSE_MODEL"/);

  assert.match(discovery, /independently configured Codex route/);
  assert.match(discovery, /EVOGENT_CODEX_MODEL/);
  assert.doesNotMatch(discovery, /EVOGENT_BROWSE_(?:MODEL|REASONING)/);

  for (const deterministic of ['hn-fetch.py', 'source-scout.py']) {
    assert.doesNotMatch(read(deterministic), /codex|EVOGENT_BROWSE_/i);
  }
});

test('changed shell and Python route consumers remain syntactically valid', () => {
  const shell = spawnSync('bash', ['-n', path.join(tools, 'evogent-cycle.sh')], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(shell.status, 0, shell.stderr);

  const pythonFiles = [
    'browse-x-scrape.py',
    'browse-interests.py',
    'browse-instagram.py',
    'taste-score.py',
    'backfill-quote-tweets.py',
  ].map((name) => path.join(tools, name));
  const python = spawnSync(
    'python3',
    [
      '-c',
      'import pathlib,sys\nfor p in sys.argv[1:]: compile(pathlib.Path(p).read_text(), p, "exec")',
      ...pythonFiles,
    ],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(python.status, 0, python.stderr);
});
