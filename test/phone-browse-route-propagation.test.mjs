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
    /EVOGENT_BRAIN_PROVIDER="\$BRAIN"/,
    `${label} must inherit the cycle's selected provider`,
  );
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
  assert.match(
    appResearch,
    /claude -p "\$RPROMPT" --model "\$BROWSE_MODEL" --effort "\$BROWSE_EFFORT"/,
  );
});

test('routine helpers consume provider, model, and effort through one compatible CLI boundary', () => {
  const helpers = [
    ['browse-x-scrape.py', 'EXTRACT_PROVIDER', 'EXTRACT_MODEL', 'EXTRACT_EFFORT', 'low'],
    ['browse-interests.py', 'BROWSE_PROVIDER', 'BROWSE_MODEL', 'BROWSE_EFFORT', 'low'],
    ['browse-instagram.py', 'BROWSE_PROVIDER', 'BROWSE_MODEL', 'BROWSE_EFFORT', 'low'],
    ['taste-score.py', 'PROVIDER', 'MODEL', 'EFFORT', 'medium'],
    ['backfill-quote-tweets.py', 'PROVIDER', 'MODEL', 'EFFORT', 'low'],
  ];

  for (const [name, provider, model, effort, standaloneDefault] of helpers) {
    const source = read(name);
    const assignment = new RegExp(
      `${effort} = os\\.environ\\.get\\("EVOGENT_BROWSE_REASONING", "${standaloneDefault}"\\)`,
    );
    assert.match(source, assignment, `${name} must accept a per-run effort override`);
    assert.match(source, /from provider_cli import run_provider, selected_provider/);
    assert.match(source, new RegExp(`${provider} = selected_provider\\(\\)`));
    assert.match(source, /run_provider\(/);
    assert.match(source, new RegExp(`provider=${provider}`));
    assert.match(source, new RegExp(`model=${model}`));
    assert.match(source, new RegExp(`effort=${effort}`));
    assert.doesNotMatch(
      source,
      /(?:\["codex",\s*"exec"|\["claude",\s*"-p")/,
      `${name} must not bypass the provider-compatible CLI boundary`,
    );
  }
  assert.match(read('browse-interests.py'), /image_paths=\[path for/);
  assert.match(read('browse-instagram.py'), /image_paths=\[frame for/);
});

test('provider CLI preserves exact model and effort for Codex and Claude', () => {
  const script = [
    'import json,sys',
    `sys.path.insert(0, ${JSON.stringify(tools)})`,
    'from provider_cli import provider_invocation',
    'provider,model,effort=sys.argv[1:4]',
    'command,prompt,environment=provider_invocation("bounded prompt", provider=provider, model=model, effort=effort, image_paths=["/tmp/example.png"], environment={"ANTHROPIC_API_KEY":"must-not-survive"})',
    'print(json.dumps({"command":command,"prompt":prompt.decode(),"anthropicApiKey":"ANTHROPIC_API_KEY" in environment}))',
  ].join('\n');
  const invoke = (provider, model, effort) => {
    const result = spawnSync('python3', ['-c', script, provider, model, effort], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };

  const codex = invoke('codex', 'gpt-5.6-terra', 'medium');
  assert.deepEqual(codex.command.slice(0, 6), [
    'codex', 'exec', '--model', 'gpt-5.6-terra', '-c', 'model_reasoning_effort=medium',
  ]);
  assert.equal(codex.command.at(-3), '-i');
  assert.match(codex.command.at(-2), /\/tmp\/example\.png$/);
  assert.equal(codex.command.at(-1), '-');
  assert.equal(codex.prompt, 'bounded prompt');

  const claude = invoke('claude', 'claude-sonnet-4-6', 'high');
  assert.deepEqual(claude.command.slice(0, 6), [
    'claude', '-p', '--model', 'claude-sonnet-4-6', '--effort', 'high',
  ]);
  assert.match(claude.prompt, /LOCAL IMAGE EVIDENCE/);
  assert.match(claude.prompt, /\/tmp\/example\.png/);
  assert.equal(claude.anthropicApiKey, false);
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
  assert.match(
    curation,
    /metadata\["codexModel" if provider=="codex" else "claudeModel"\]=model/,
  );
  assert.match(curation, /"\$CURATOR_MODEL" "\$BRAIN"/);
  assert.doesNotMatch(curation, /--model "\$BROWSE_MODEL"/);

  assert.match(discovery, /independently configured source-discovery route for the selected Brain Provider/);
  assert.match(discovery, /--task source_discovery/);
  assert.match(discovery, /--provider "\$BRAIN"/);
  assert.match(
    discovery,
    /claude -p "\$PROMPT" --model "\$DISCOVERY_MODEL" --effort "\$DISCOVERY_EFFORT"/,
  );
  assert.match(discovery, /EVOGENT_SOURCE_DISCOVERY_MODEL/);
  assert.match(discovery, /EVOGENT_SOURCE_DISCOVERY_REASONING/);
  assert.doesNotMatch(
    discovery,
    /EVOGENT_(?:BROWSE|CURATOR|CODEX)_(?:MODEL|REASONING)/,
  );

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
    'provider_cli.py',
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
