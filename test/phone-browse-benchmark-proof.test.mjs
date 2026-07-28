import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

const root = path.resolve(import.meta.dirname, '..');
const finalizer = path.join(
  root,
  'phone-paradigm/device/phone-tools/benchmark-browse-finalize.py',
);
const benchmarkScript = fs.readFileSync(
  path.join(root, 'phone-paradigm/device/phone-tools/benchmark-browse-models.sh'),
  'utf8',
);
const phoneHelper = fs.readFileSync(
  path.join(root, 'phone-paradigm/device/phone-tools/phone.sh'),
  'utf8',
);
const accessibilityService = fs.readFileSync(
  path.join(root, 'android-shell/src/net/dangish/evogent/EvogentAccessibilityService.java'),
  'utf8',
);
const shareReceiver = fs.readFileSync(
  path.join(root, 'android-shell/src/net/dangish/evogent/ShareReceiverActivity.java'),
  'utf8',
);
const provenanceStore = fs.readFileSync(
  path.join(root, 'android-shell/src/net/dangish/evogent/EvogentBenchmarkShareProvenance.java'),
  'utf8',
);
const provenanceConsumeMethod = provenanceStore.slice(
  provenanceStore.indexOf('static Consumed consume'),
  provenanceStore.indexOf('static boolean clear'),
);
const submitRoute = fs.readFileSync(
  path.join(root, 'src/app/api/internal/browse-cache/submit/route.ts'),
  'utf8',
);
const serverProofValidation = fs.readFileSync(
  path.join(root, 'src/lib/browse-benchmark-proof.ts'),
  'utf8',
);

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sourceSetDigest(shares) {
  return digest(shares.map((share) => share.sourceIdDigest).sort().join('\n'));
}

function shareReceiptSetDigest(shares) {
  return digest(canonicalJson(shares));
}

function createSchema(db) {
  db.exec(`
    CREATE TABLE browse_cache_items (
      source TEXT NOT NULL,
      source_id TEXT NOT NULL,
      url TEXT,
      title TEXT,
      payload_json TEXT,
      fetched_at_ms INTEGER NOT NULL
    );
    CREATE TABLE browse_cache_refresh_runs (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      triggered_by TEXT NOT NULL,
      started_at_ms INTEGER,
      completed_at_ms INTEGER,
      status TEXT NOT NULL,
      items_added INTEGER NOT NULL,
      error TEXT,
      metadata_json TEXT
    );
  `);
}

function makeShare({
  db,
  runId,
  startedAtMs,
  sequence,
  sourceId,
  token = String(sequence).repeat(64),
  title = `Substantive benchmark video ${sequence}`,
}) {
  const tokenDigest = digest(token);
  const receiptId = `benchmark-share-${tokenDigest}`;
  const armedAtMs = startedAtMs + sequence * 100;
  const fetchedAtMs = armedAtMs + 20;
  const sourceIdDigest = digest(sourceId);
  const share = {
    sequence,
    receiptId,
    tokenDigest,
    sourceIdDigest,
    armedAtMs,
    fetchedAtMs,
  };
  db.prepare(`
    INSERT INTO browse_cache_items
      (source, source_id, url, title, payload_json, fetched_at_ms)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    'youtube',
    sourceId,
    `https://www.youtube.com/watch?v=${sourceId}`,
    title,
    '{}',
    fetchedAtMs,
  );
  db.prepare(`
    INSERT INTO browse_cache_refresh_runs
      (id, source, triggered_by, started_at_ms, completed_at_ms, status,
       items_added, error, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    receiptId,
    'youtube',
    'phone-benchmark-full-browse-share',
    fetchedAtMs,
    fetchedAtMs,
    'completed',
    1,
    null,
    JSON.stringify({
      benchmarkShareProof: {
        schemaVersion: 1,
        kind: 'full_browse_share',
        benchmarkRunId: runId,
        ...share,
      },
    }),
  );
  return { share, token, sourceId, title };
}

function insertTerminal({ db, runId, startedAtMs, completedAtMs, shares }) {
  db.prepare(`
    INSERT INTO browse_cache_refresh_runs
      (id, source, triggered_by, started_at_ms, completed_at_ms, status,
       items_added, error, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    runId,
    'youtube',
    'phone-benchmark-full-browse',
    startedAtMs,
    completedAtMs,
    'completed',
    shares.length,
    null,
    JSON.stringify({
      benchmarkProof: {
        schemaVersion: 2,
        kind: 'full_browse',
        runId,
        freshRows: shares.length,
        completeRows: shares.length,
        sourceSetDigest: sourceSetDigest(shares),
        shareReceiptSetDigest: shareReceiptSetDigest(shares),
        shares,
      },
    }),
  );
}

function withProofFixture(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-browse-proof-'));
  const databasePath = path.join(directory, 'media-agent.db');
  const db = new Database(databasePath);
  const startedAtMs = Date.now() - 2_000;
  const completedAtMs = startedAtMs + 1_000;
  const runId = `full-browse-test-${process.pid}-${startedAtMs}`;
  createSchema(db);
  const first = makeShare({
    db,
    runId,
    startedAtMs,
    sequence: 1,
    sourceId: 'AAAAAAAAAAA',
  });
  const second = makeShare({
    db,
    runId,
    startedAtMs,
    sequence: 2,
    sourceId: 'BBBBBBBBBBB',
  });
  const shares = [first.share, second.share];
  insertTerminal({ db, runId, startedAtMs, completedAtMs, shares });

  try {
    run({
      db,
      databasePath,
      directory,
      runId,
      startedAtMs,
      completedAtMs,
      shares,
      first,
      second,
    });
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function verify(paths) {
  return JSON.parse(execFileSync('python3', [
    finalizer,
    '--database', paths.databasePath,
    'verify',
    '--run-id', paths.runId,
    '--started-at-ms', String(paths.startedAtMs),
    '--max-completed-at-ms', String(paths.completedAtMs + 1_000),
  ], { encoding: 'utf8' }));
}

function rewriteTerminalProof(paths, mutate) {
  const row = paths.db.prepare(
    'SELECT metadata_json FROM browse_cache_refresh_runs WHERE id = ?',
  ).get(paths.runId);
  const metadata = JSON.parse(row.metadata_json);
  mutate(metadata.benchmarkProof);
  paths.db.prepare(
    'UPDATE browse_cache_refresh_runs SET metadata_json = ? WHERE id = ?',
  ).run(JSON.stringify(metadata), paths.runId);
}

test('full browse proof verifies the exact token-bound receipt for every share', () => {
  withProofFixture((paths) => {
    assert.deepEqual(verify(paths), {
      terminalProof: true,
      terminalItems: 2,
      freshRows: 2,
      completeRows: 2,
      runDigest: digest(paths.runId),
    });
  });
});

test('unrelated rows inside the run window are ignored rather than attributed', () => {
  withProofFixture((paths) => {
    paths.db.prepare(`
      INSERT INTO browse_cache_items
        (source, source_id, url, title, payload_json, fetched_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      'youtube',
      'CCCCCCCCCCC',
      'https://www.youtube.com/watch?v=CCCCCCCCCCC',
      'Ambient row that has no benchmark token receipt',
      '{}',
      paths.startedAtMs + 300,
    );
    assert.equal(verify(paths).terminalItems, 2);
  });
});

test('a delayed or ambient row cannot substitute for a missing expected receipt', () => {
  withProofFixture((paths) => {
    paths.db.prepare('DELETE FROM browse_cache_refresh_runs WHERE id = ?')
      .run(paths.second.share.receiptId);
    paths.db.prepare(`
      INSERT INTO browse_cache_items
        (source, source_id, url, title, payload_json, fetched_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      'youtube',
      'CCCCCCCCCCC',
      'https://www.youtube.com/watch?v=CCCCCCCCCCC',
      'Delayed complete row from unrelated acquisition',
      '{}',
      paths.second.share.fetchedAtMs,
    );
    assert.throws(() => verify(paths));
  });
});

test('a receipt for another run cannot satisfy the expected share token', () => {
  withProofFixture((paths) => {
    const row = paths.db.prepare(
      'SELECT metadata_json FROM browse_cache_refresh_runs WHERE id = ?',
    ).get(paths.second.share.receiptId);
    const metadata = JSON.parse(row.metadata_json);
    metadata.benchmarkShareProof.benchmarkRunId =
      `full-browse-other-${process.pid}-${paths.startedAtMs}`;
    paths.db.prepare(
      'UPDATE browse_cache_refresh_runs SET metadata_json = ? WHERE id = ?',
    ).run(JSON.stringify(metadata), paths.second.share.receiptId);
    assert.throws(() => verify(paths));
  });
});

test('token, source, sequence, and aggregate tampering fail closed', async (t) => {
  const mutations = [
    ['token digest', (proof) => {
      proof.shares[1].tokenDigest = digest('wrong-token');
      proof.shareReceiptSetDigest = shareReceiptSetDigest(proof.shares);
    }],
    ['source digest', (proof) => {
      proof.shares[1].sourceIdDigest = proof.shares[0].sourceIdDigest;
      proof.sourceSetDigest = sourceSetDigest(proof.shares);
      proof.shareReceiptSetDigest = shareReceiptSetDigest(proof.shares);
    }],
    ['sequence', (proof) => {
      proof.shares[1].sequence = 1;
      proof.shareReceiptSetDigest = shareReceiptSetDigest(proof.shares);
    }],
    ['aggregate digest', (proof) => {
      proof.shareReceiptSetDigest = digest('forged aggregate');
    }],
  ];
  for (const [label, mutate] of mutations) {
    await t.test(label, () => {
      withProofFixture((paths) => {
        rewriteTerminalProof(paths, mutate);
        assert.throws(() => verify(paths));
      });
    });
  }
});

test('arm, synchronous confirmation, and finalization emit only content-free proof', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-browse-flow-'));
  const databasePath = path.join(directory, 'media-agent.db');
  const stateDir = path.join(directory, 'state');
  const capturePath = path.join(directory, 'captured-request.json');
  const phoneStub = path.join(directory, 'phone-stub.mjs');
  const curlStub = path.join(directory, 'curl-stub.mjs');
  const db = new Database(databasePath);
  createSchema(db);
  fs.writeFileSync(phoneStub, `#!/usr/bin/env node
const [command, runId, sequence, token, armedAtMs] = process.argv.slice(2);
if (!/^full-browse-/.test(runId || '')) process.exit(2);
if (command === 'benchmark-share-arm' && /^[1-5]$/.test(sequence || '')
    && /^[a-f0-9]{64}$/.test(token || '') && /^[1-9][0-9]{11,14}$/.test(armedAtMs || '')) {
  process.stdout.write('BROWSE_SHARE_ARMED ' + sequence + '\\n');
} else if (command === 'benchmark-share-clear' && !sequence
    && process.env.EVOGENT_TASK_OWNER === 'test-benchmark-owner'
    && process.env.EVOGENT_CONTROL_ROOT === '/private/test-control-root') {
  process.stdout.write('BROWSE_SHARE_CLEARED\\n');
} else process.exit(3);
`);
  fs.writeFileSync(curlStub, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
const index = args.indexOf('--data-binary');
const payload = JSON.parse(args[index + 1]);
fs.writeFileSync(process.env.EVOGENT_TEST_CAPTURE, JSON.stringify(payload));
process.stdout.write(JSON.stringify({
  ok: true,
  run: { id: payload.runId, status: payload.status, itemsAdded: payload.itemsAdded },
}));
`);
  fs.chmodSync(phoneStub, 0o755);
  fs.chmodSync(curlStub, 0o755);

  const startedAtMs = Date.now() - 100;
  const runId = `full-browse-flow-${process.pid}-${startedAtMs}`;
  const globalArgs = [
    finalizer,
    '--database', databasePath,
    '--state-dir', stateDir,
  ];
  try {
    assert.match(execFileSync('python3', [
      ...globalArgs,
      'begin',
      '--run-id', runId,
      '--started-at-ms', String(startedAtMs),
    ], { encoding: 'utf8' }), /^BROWSE_BENCHMARK_READY /);
    const armOutput = execFileSync('python3', [
      ...globalArgs,
      'arm-share',
      '--run-id', runId,
      '--sequence', '1',
      '--phone-helper', phoneStub,
    ], { encoding: 'utf8' });
    assert.equal(armOutput, 'BROWSE_SHARE_ARMED 1\n');

    const statePath = fs.readdirSync(stateDir)
      .map((name) => path.join(stateDir, name))
      .find((candidate) => candidate.endsWith('.json'));
    assert.ok(statePath);
    assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
    const armedState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const pending = armedState.pending;
    assert.deepEqual(Object.keys(pending).sort(), [
      'armedAtMs',
      'receiptId',
      'sequence',
      'tokenDigest',
    ]);
    const sourceId = 'ZZZZZZZZZZZ';
    const title = 'Private source title must never enter the proof';
    const fetchedAtMs = pending.armedAtMs + 10;
    const share = {
      sequence: 1,
      receiptId: pending.receiptId,
      tokenDigest: pending.tokenDigest,
      sourceIdDigest: digest(sourceId),
      armedAtMs: pending.armedAtMs,
      fetchedAtMs,
    };
    db.prepare(`
      INSERT INTO browse_cache_items
        (source, source_id, url, title, payload_json, fetched_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      'youtube',
      sourceId,
      `https://www.youtube.com/watch?v=${sourceId}`,
      title,
      '{}',
      fetchedAtMs,
    );
    db.prepare(`
      INSERT INTO browse_cache_refresh_runs
        (id, source, triggered_by, started_at_ms, completed_at_ms, status,
         items_added, error, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      share.receiptId,
      'youtube',
      'phone-benchmark-full-browse-share',
      fetchedAtMs,
      fetchedAtMs,
      'completed',
      1,
      null,
      JSON.stringify({
        benchmarkShareProof: {
          schemaVersion: 1,
          kind: 'full_browse_share',
          benchmarkRunId: runId,
          ...share,
        },
      }),
    );

    assert.equal(execFileSync('python3', [
      ...globalArgs,
      'confirm-share',
      '--run-id', runId,
      '--sequence', '1',
      '--wait-seconds', '0',
    ], { encoding: 'utf8' }), 'BROWSE_SHARE_CONFIRMED 1\n');
    const confirmedState = fs.readFileSync(statePath, 'utf8');
    assert.doesNotMatch(confirmedState, /"token":/);

    assert.match(execFileSync('python3', [
      ...globalArgs,
      'finalize',
      '--run-id', runId,
      '--started-at-ms', String(startedAtMs),
      '--declared-count', '1',
      '--curl', curlStub,
    ], {
      encoding: 'utf8',
      env: { ...process.env, EVOGENT_TEST_CAPTURE: capturePath },
    }), new RegExp(`^BROWSE_BENCHMARK_RECEIPT ${runId} 1`));

    const captured = fs.readFileSync(capturePath, 'utf8');
    const payload = JSON.parse(captured);
    assert.equal(payload.metadata.benchmarkProof.schemaVersion, 2);
    assert.equal(payload.metadata.benchmarkProof.shares.length, 1);
    assert.equal(payload.metadata.benchmarkProof.shares[0].receiptId, share.receiptId);
    assert.equal(payload.items.length, 0);
    assert.doesNotMatch(captured, /"token":/);
    assert.doesNotMatch(captured, new RegExp(sourceId));
    assert.doesNotMatch(captured, new RegExp(title));

    execFileSync('python3', [
      ...globalArgs,
      'cleanup',
      '--run-id', runId,
      '--phone-helper', phoneStub,
    ], {
      env: {
        ...process.env,
        EVOGENT_TASK_OWNER: 'test-benchmark-owner',
        EVOGENT_CONTROL_ROOT: '/private/test-control-root',
      },
    });
    assert.equal(fs.existsSync(statePath), false);
    assert.deepEqual(fs.readdirSync(stateDir), []);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('the APK and server implement one-shot provenance without changing ordinary share ingest', () => {
  assert.match(accessibilityService, /case "benchmark_share_arm"/);
  assert.match(accessibilityService, /EvogentBenchmarkShareProvenance\.arm/);
  assert.match(accessibilityService, /case "benchmark_share_clear"/);
  assert.match(phoneHelper, /benchmark-share-arm/);
  assert.match(phoneHelper, /a11y_grab --es op benchmark_share_arm/);
  assert.match(provenanceStore, /SharedPreferences/);
  assert.match(provenanceStore, /preferences\.edit\(\)\.clear\(\)\.commit\(\)/);
  assert.match(provenanceStore, /raw random token[\s\S]*never persisted/i);
  assert.ok(
    provenanceConsumeMethod.indexOf('hasStoredArmState')
      < provenanceConsumeMethod.indexOf('preferences.edit().clear().commit()'),
    'empty-state return must precede every synchronous preferences clear',
  );
  assert.match(shareReceiver, /EvogentBenchmarkShareProvenance\.consume\(this/);
  assert.match(shareReceiver, /\? "phone-browse"\s*: BENCHMARK_SHARE_TRIGGERED_BY/);
  assert.match(shareReceiver, /body\.put\("runId", benchmarkProof\.receiptId\)/);
  assert.match(submitRoute, /validateBenchmarkSharePayload/);
  assert.match(serverProofValidation, /sourceIdDigest !== sha256\(sourceId\)/);
  assert.match(serverProofValidation, /item\.url !== canonicalUrl/);
});

test('the benchmark lifecycle retains its exclusive lock and requires per-share confirmation', () => {
  assert.match(benchmarkScript, /control_lock_acquire "\$BENCH_LOCK" browse-benchmark/);
  assert.match(benchmarkScript, /benchmark-browse-finalize\.py arm-share --run-id/);
  assert.match(benchmarkScript, /benchmark-browse-finalize\.py confirm-share --run-id/);
  assert.match(benchmarkScript, /python3 "\$FINALIZER" begin --run-id/);
  assert.match(benchmarkScript, /cleanup_benchmark_proof/);
  assert.match(
    benchmarkScript,
    /env EVOGENT_TASK_OWNER="\$CONTROL_OWNER_ID" EVOGENT_CONTROL_ROOT="\$CONTROL_ROOT"[\s\S]*?python3 "\$FINALIZER" cleanup/,
  );
  assert.match(benchmarkScript, /"task":"browse_full_v2"/);
});
