import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const tool = path.join(
  root,
  'phone-paradigm/device/phone-tools/model_routing.py',
);
const policy = path.join(
  root,
  'phone-paradigm/device/phone-tools/model-routing.default.json',
);

function withFixture(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-model-route-'));
  const paths = {
    directory,
    config: path.join(directory, 'config.md'),
    live: path.join(directory, 'model-routing.json'),
    receipts: path.join(directory, 'model-benchmark-results.jsonl'),
  };
  fs.writeFileSync(paths.config, [
    '## Codex Model',
    'gpt-5.6-sol',
    '',
    '## Browse Model',
    'gpt-5.6-sol',
    '',
    '## Browse Reasoning',
    'high',
    '',
    '## Curator Reasoning',
    'high',
  ].join('\n'));
  fs.writeFileSync(paths.live, JSON.stringify({
    schemaVersion: 1,
    routes: {
      browse: {
        model: 'gpt-5.6-terra',
        effort: 'low',
        qualification: { suiteId: 'suite-1' },
      },
      browse_youtube: {
        model: 'gpt-5.6-terra',
        effort: 'low',
        qualification: { suiteId: 'suite-1' },
      },
      curator: {
        model: 'gpt-5.6-terra',
        effort: 'low',
        qualification: { suiteId: 'suite-1' },
      },
    },
  }));
  fs.chmodSync(paths.live, 0o600);
  try {
    run(paths);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function resolve(paths, task = 'browse', {
  modelOverride = '',
  effortOverride = '',
  policyPath = policy,
} = {}) {
  const args = [
    tool,
    'resolve',
    '--task', task,
    '--config', paths.config,
    '--policy', policyPath,
    '--live', paths.live,
    '--receipts', paths.receipts,
    '--json',
  ];
  if (modelOverride) args.push('--model-override', modelOverride);
  if (effortOverride) args.push('--effort-override', effortOverride);
  return JSON.parse(execFileSync('python3', args, { encoding: 'utf8' }));
}

// The production resolver deliberately cannot consume today's browse or
// curator receipt formats. Keep testing their content-free validators in
// isolation so a future safe qualifying harness can reuse the sound parts
// without making the current receipts production proof.
function inspectDormantReceiptValidator(paths, task) {
  const source = String.raw`
import importlib.util, json, pathlib, sys
spec = importlib.util.spec_from_file_location("model_routing", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
rows = []
try:
    for line in pathlib.Path(sys.argv[2]).read_text(encoding="utf-8").splitlines():
        value = json.loads(line)
        if isinstance(value, dict):
            rows.append(value)
except OSError:
    pass
decision = module.qualification_decision(
    rows,
    task=sys.argv[3],
    suite_id="suite-1",
    candidate_model="gpt-5.6-terra",
    candidate_effort="low",
    baseline_model="gpt-5.6-sol",
    baseline_effort="high",
    minimum_paired_passes=3,
    max_age_hours=720,
)
print(json.dumps({
    "model": "gpt-5.6-terra" if decision["qualified"] else "gpt-5.6-sol",
    "effort": "low" if decision["qualified"] else "high",
    "origin": (
        "benchmark_qualified_live"
        if decision["qualified"]
        else "baseline_" + decision["reason"]
    ),
    "qualification": decision,
}))
`;
  return JSON.parse(execFileSync(
    'python3',
    ['-c', source, tool, paths.receipts, task],
    { encoding: 'utf8' },
  ));
}

function inspectDormantBrowseReceiptValidator(paths) {
  return inspectDormantReceiptValidator(paths, 'browse');
}

function inspectDormantCuratorReceiptValidator(paths) {
  return inspectDormantReceiptValidator(paths, 'curator');
}

function record(paths, receipt) {
  execFileSync('python3', [
    tool,
    'record',
    '--ledger', paths.receipts,
    '--receipt-json', JSON.stringify(receipt),
  ], { stdio: 'pipe' });
}

function readReceiptRows(paths) {
  return fs.readFileSync(paths.receipts, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function legacyTaskOnlyBrowsePairedPasses(rows) {
  const byRound = new Map();
  for (const row of rows) {
    if (
      row.schemaVersion !== 1
      || row.task !== 'browse'
      || row.suiteId !== 'suite-1'
    ) {
      continue;
    }
    const pair = byRound.get(row.round) ?? {};
    pair[row.role] = row;
    byRound.set(row.round, pair);
  }
  return [...byRound.values()].filter((pair) => (
    pair.baseline?.mechanicsStatus === 'passed'
    && pair.baseline?.qualityStatus === 'passed'
    && pair.candidate?.mechanicsStatus === 'passed'
    && pair.candidate?.qualityStatus === 'passed'
  )).length;
}

function legacyTaskOnlyCuratorPairedPasses(rows) {
  const byRound = new Map();
  for (const row of rows) {
    if (
      row.schemaVersion !== 1
      || row.task !== 'curator'
      || row.suiteId !== 'suite-1'
    ) {
      continue;
    }
    const pair = byRound.get(row.round) ?? {};
    pair[row.role] = row;
    byRound.set(row.round, pair);
  }
  return [...byRound.values()].filter((pair) => (
    pair.baseline?.mechanicsStatus === 'passed'
    && pair.baseline?.qualityStatus === 'passed'
    && pair.candidate?.mechanicsStatus === 'passed'
    && pair.candidate?.qualityStatus === 'passed'
  )).length;
}

function passingReceipt({
  round,
  role,
  model,
  effort,
  task = 'browse_mixed_full_v3',
  benchmarkKind = 'full_browse_mixed',
  recordedAtMs = Date.now(),
}) {
  const metrics = {
    elapsedMs: role === 'baseline' ? 1000 : 600,
    inputTokens: role === 'baseline' ? 800 : 650,
    cachedInputTokens: role === 'baseline' ? 200 : 150,
    outputTokens: role === 'baseline' ? 200 : 150,
    totalTokens: role === 'baseline' ? 1000 : 800,
    reportedTitles: 5,
    groundedTitles: 5,
    requiredTitles: 5,
  };
  if ([
    'browse_mixed_full_v3',
    'browse_youtube_smoke_v1',
    'browse_youtube_full_v1',
    'browse_full_v2',
  ].includes(task)) {
    Object.assign(metrics, {
      terminalProof: true,
      terminalItems: 5,
      freshRows: 5,
      completeRows: 5,
      runDigest: `${round}${role === 'baseline' ? 'a' : 'b'}`.padEnd(64, '0'),
    });
  }
  return {
    schemaVersion: 1,
    recordedAtMs,
    suiteId: 'suite-1',
    round,
    task,
    benchmarkKind,
    role,
    model,
    effort,
    mechanicsStatus: 'passed',
    qualityStatus: 'passed',
    metrics,
  };
}

function curatorReceipt({
  round,
  role,
  model,
  effort,
  task = 'curator_full_v2',
  mechanicsStatus = 'passed',
  qualityStatus = 'passed',
  reviewed = true,
  benchmarkKind = 'full_curation_snapshot',
  recordedAtMs = Date.now(),
}) {
  const receipt = {
    schemaVersion: 1,
    recordedAtMs,
    suiteId: 'suite-1',
    round,
    task,
    benchmarkKind,
    role,
    model,
    effort,
    mechanicsStatus,
    qualityStatus,
    metrics: {
      elapsedMs: role === 'baseline' ? 2000 : 1400,
      candidateCount: 30,
      slateCount: 8,
      nearMissCount: 4,
      artifactReviewed: reviewed,
      fullSnapshotProof: true,
      terminalProof: true,
    },
  };
  if (reviewed) {
    receipt.metrics.artifactDigest =
      `${round}${role === 'baseline' ? 'c' : 'd'}`.padEnd(64, '0');
    receipt.metrics.runDigest =
      `${round}${role === 'baseline' ? 'e' : 'f'}`.padEnd(64, '0');
    receipt.metrics.reviewedAtMs = recordedAtMs;
  }
  return receipt;
}

test('routine browse ignores persistent overrides while relevance proof is unavailable', () => {
  withFixture((paths) => {
    const result = resolve(paths);
    assert.equal(result.model, 'gpt-5.6-sol');
    assert.equal(result.effort, 'high');
    assert.equal(result.origin, 'baseline_persistent_override_disabled');
    assert.equal(result.qualification, undefined);
  });
});

test('routine override gates remain closed if a local policy accidentally enables them', () => {
  withFixture((paths) => {
    const unsafePolicy = path.join(paths.directory, 'unsafe-policy.json');
    const policyValue = JSON.parse(fs.readFileSync(policy, 'utf8'));
    policyValue.routes.browse.persistentOverrideAllowed = true;
    policyValue.routes.browse_youtube.persistentOverrideAllowed = true;
    policyValue.routes.curator.persistentOverrideAllowed = true;
    fs.writeFileSync(unsafePolicy, JSON.stringify(policyValue));

    for (const task of ['browse', 'browse_youtube', 'curator']) {
      const result = resolve(paths, task, { policyPath: unsafePolicy });
      assert.equal(result.model, 'gpt-5.6-sol');
      assert.equal(result.effort, 'high');
      assert.equal(result.origin, 'baseline_persistent_override_disabled');
      assert.equal(result.qualification, undefined);
    }
  });
});

test('routine browsing inherits Codex Model unless Browse Model is explicit', () => {
  withFixture((paths) => {
    const config = fs.readFileSync(paths.config, 'utf8')
      .replace(/## Browse Model\n[^\n]*\n\n/, '')
      .replace(/## Browse Reasoning\n[^\n]*\n\n/, '');
    fs.writeFileSync(paths.config, config);
    fs.writeFileSync(paths.live, JSON.stringify({ schemaVersion: 1, routes: {} }));
    fs.chmodSync(paths.live, 0o600);

    const browse = resolve(paths);
    assert.equal(browse.model, 'gpt-5.6-sol');
    assert.equal(browse.effort, 'medium');
    assert.equal(browse.origin, 'config');

    const curator = resolve(paths, 'curator');
    assert.equal(curator.model, 'gpt-5.6-sol');
    assert.equal(curator.effort, 'high');
    assert.equal(curator.origin, 'config');
  });
});

test('Terra remains the browse fallback only when no browse or Codex model is configured', () => {
  withFixture((paths) => {
    const config = fs.readFileSync(paths.config, 'utf8')
      .replace(/## Codex Model\n[^\n]*\n\n/, '')
      .replace(/## Browse Model\n[^\n]*\n\n/, '')
      .replace(/## Browse Reasoning\n[^\n]*\n\n/, '');
    fs.writeFileSync(paths.config, config);
    fs.writeFileSync(paths.live, JSON.stringify({ schemaVersion: 1, routes: {} }));
    fs.chmodSync(paths.live, 0o600);

    const browse = resolve(paths);
    assert.equal(browse.model, 'gpt-5.6-terra');
    assert.equal(browse.effort, 'medium');
    assert.equal(browse.origin, 'policy');
  });
});

test('one-run curator model and effort overrides remain independent of qualification', () => {
  withFixture((paths) => {
    const result = resolve(paths, 'curator', {
      modelOverride: 'gpt-5.6-terra',
      effortOverride: 'low',
    });
    assert.equal(result.model, 'gpt-5.6-terra');
    assert.equal(result.effort, 'low');
    assert.equal(result.origin, 'environment');
    assert.equal(result.qualification, undefined);
  });
});

test('one-run browse overrides remain available for supervised screening', () => {
  withFixture((paths) => {
    for (const task of ['browse', 'browse_youtube']) {
      const result = resolve(paths, task, {
        modelOverride: 'gpt-5.6-terra',
        effortOverride: 'low',
      });
      assert.equal(result.model, 'gpt-5.6-terra');
      assert.equal(result.effort, 'low');
      assert.equal(result.origin, 'environment');
      assert.equal(result.qualification, undefined);
    }
  });
});

test('reviewless browse receipts cannot override production even after three paired passes', () => {
  withFixture((paths) => {
    for (let round = 1; round <= 3; round += 1) {
      record(paths, passingReceipt({
        round,
        role: 'baseline',
        model: 'gpt-5.6-sol',
        effort: 'high',
      }));
      record(paths, passingReceipt({
        round,
        role: 'candidate',
        model: 'gpt-5.6-terra',
        effort: 'low',
      }));
    }
    const result = resolve(paths);
    assert.equal(result.model, 'gpt-5.6-sol');
    assert.equal(result.effort, 'high');
    assert.equal(result.origin, 'baseline_persistent_override_disabled');
    assert.equal(result.qualification, undefined);

    const dormant = inspectDormantBrowseReceiptValidator(paths);
    assert.equal(dormant.qualification.pairedPasses, 3);
    assert.equal(dormant.qualification.qualified, true);
  });
});

test('mutable-feed YouTube smoke evidence cannot qualify any persistent route', () => {
  withFixture((paths) => {
    for (let round = 1; round <= 3; round += 1) {
      record(paths, passingReceipt({
        round,
        role: 'baseline',
        model: 'gpt-5.6-sol',
        effort: 'high',
        task: 'browse_youtube_smoke_v1',
        benchmarkKind: 'full_browse_youtube_smoke',
      }));
      record(paths, passingReceipt({
        round,
        role: 'candidate',
        model: 'gpt-5.6-terra',
        effort: 'low',
        task: 'browse_youtube_smoke_v1',
        benchmarkKind: 'full_browse_youtube_smoke',
      }));
    }

    const youtube = resolve(paths, 'browse_youtube');
    assert.equal(youtube.model, 'gpt-5.6-sol');
    assert.equal(youtube.effort, 'high');
    assert.equal(youtube.origin, 'baseline_persistent_override_disabled');
    assert.equal(youtube.qualification, undefined);

    const global = resolve(paths);
    assert.equal(global.model, 'gpt-5.6-sol');
    assert.equal(global.effort, 'high');
    assert.equal(global.origin, 'baseline_persistent_override_disabled');
    assert.equal(global.qualification, undefined);
  });
});

test('declared receipt roles must agree with their model and effort side', () => {
  withFixture((paths) => {
    for (let round = 1; round <= 3; round += 1) {
      record(paths, passingReceipt({
        round,
        role: 'baseline',
        model: 'gpt-5.6-sol',
        effort: 'high',
      }));
      record(paths, passingReceipt({
        round,
        role: 'candidate',
        model: 'gpt-5.6-terra',
        effort: 'low',
      }));
    }
    // The writer can validate the label vocabulary, but only qualification
    // knows which model/effort is the configured baseline or candidate.
    record(paths, passingReceipt({
      round: 4,
      role: 'baseline',
      model: 'gpt-5.6-terra',
      effort: 'low',
    }));

    const result = inspectDormantBrowseReceiptValidator(paths);
    assert.equal(result.model, 'gpt-5.6-sol');
    assert.equal(result.qualification.qualified, false);
    assert.equal(result.qualification.reason, 'ledger_integrity_failure');
    assert.equal(result.qualification.pairedPasses, 3);
    assert.equal(result.qualification.roleIntegrityFailedPairs, 1);
    assert.equal(result.qualification.mechanicsFailedPairs, 1);
  });
});

test('direct qualification calls clamp nonpositive paired-pass minimums', () => {
  const source = String.raw`
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("model_routing", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print(json.dumps(module.qualification_decision(
    [],
    task="browse",
    suite_id="suite-1",
    candidate_model="gpt-5.6-terra",
    candidate_effort="low",
    baseline_model="gpt-5.6-sol",
    baseline_effort="high",
    minimum_paired_passes=0,
    max_age_hours=720,
)))
`;
  const result = JSON.parse(execFileSync('python3', ['-c', source, tool], {
    encoding: 'utf8',
  }));
  assert.equal(result.qualified, false);
  assert.equal(result.pairedPasses, 0);
  assert.equal(result.minimumPairedPasses, 3);
});

test('grounded micro receipts remain invisible to production and task-only legacy routers', () => {
  withFixture((paths) => {
    for (let round = 1; round <= 3; round += 1) {
      record(paths, passingReceipt({
        round,
        role: 'baseline',
        model: 'gpt-5.6-sol',
        effort: 'high',
        task: 'browse_micro',
        benchmarkKind: 'grounded_micro',
      }));
      record(paths, passingReceipt({
        round,
        role: 'candidate',
        model: 'gpt-5.6-terra',
        effort: 'low',
        task: 'browse_micro',
        benchmarkKind: 'grounded_micro',
      }));
    }
    const rows = fs.readFileSync(paths.receipts, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(rows.length, 6);
    assert.ok(rows.every((row) => row.task === 'browse_micro'));
    assert.equal(
      rows.filter((row) => row.schemaVersion === 1 && row.task === 'browse').length,
      0,
    );

    const result = inspectDormantBrowseReceiptValidator(paths);
    assert.equal(result.model, 'gpt-5.6-sol');
    assert.equal(result.effort, 'high');
    assert.equal(result.origin, 'baseline_insufficient_paired_quality_passes');
    assert.equal(result.qualification.qualified, false);
    assert.equal(result.qualification.requiredBenchmarkKind, 'full_browse_mixed');
    assert.equal(result.qualification.requiredBenchmarkTask, 'browse_mixed_full_v3');
  });
});

test('benchmark receipt writer rejects mismatched task and kind pairs', () => {
  withFixture((paths) => {
    assert.throws(() => record(paths, passingReceipt({
      round: 1,
      role: 'candidate',
      model: 'gpt-5.6-terra',
      effort: 'low',
      task: 'browse_mixed_full_v3',
      benchmarkKind: 'grounded_micro',
    })));
    assert.throws(() => record(paths, passingReceipt({
      round: 1,
      role: 'candidate',
      model: 'gpt-5.6-terra',
      effort: 'low',
      task: 'browse_micro',
      benchmarkKind: 'full_browse_mixed',
    })));
    assert.throws(() => record(paths, passingReceipt({
      round: 1,
      role: 'candidate',
      model: 'gpt-5.6-terra',
      effort: 'low',
      task: 'browse',
      benchmarkKind: 'full_browse_mixed',
    })));
    assert.throws(() => record(paths, passingReceipt({
      round: 1,
      role: 'candidate',
      model: 'gpt-5.6-terra',
      effort: 'low',
      task: 'unknown_benchmark',
      benchmarkKind: 'full_browse_mixed',
    })));
    assert.equal(fs.existsSync(paths.receipts), false);
  });
});

test('dormant browse validator rejects schema-v1 receipts with an ineligible kind', () => {
  withFixture((paths) => {
    const rows = [];
    for (let round = 1; round <= 3; round += 1) {
      rows.push(
        passingReceipt({
          round,
          role: 'baseline',
          model: 'gpt-5.6-sol',
          effort: 'high',
          benchmarkKind: 'grounded_micro',
        }),
        passingReceipt({
          round,
          role: 'candidate',
          model: 'gpt-5.6-terra',
          effort: 'low',
          benchmarkKind: 'grounded_micro',
        }),
      );
    }
    fs.writeFileSync(
      paths.receipts,
      `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
      { mode: 0o600 },
    );

    const result = inspectDormantBrowseReceiptValidator(paths);
    assert.equal(result.model, 'gpt-5.6-sol');
    assert.equal(result.origin, 'baseline_ineligible_benchmark_kind');
    assert.equal(result.qualification.qualified, false);
    assert.equal(result.qualification.requiredBenchmarkKind, 'full_browse_mixed');
  });
});

test('dormant browse validator rejects legacy task-name full browse receipts', () => {
  withFixture((paths) => {
    const rows = [];
    for (let round = 1; round <= 3; round += 1) {
      rows.push(
        passingReceipt({
          round,
          role: 'baseline',
          model: 'gpt-5.6-sol',
          effort: 'high',
          task: 'browse',
        }),
        passingReceipt({
          round,
          role: 'candidate',
          model: 'gpt-5.6-terra',
          effort: 'low',
          task: 'browse',
        }),
      );
    }
    fs.writeFileSync(
      paths.receipts,
      `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
      { mode: 0o600 },
    );

    const result = inspectDormantBrowseReceiptValidator(paths);
    assert.equal(result.model, 'gpt-5.6-sol');
    assert.equal(result.origin, 'baseline_ineligible_benchmark_task');
    assert.equal(result.qualification.qualified, false);
    assert.equal(result.qualification.requiredBenchmarkTask, 'browse_mixed_full_v3');
  });
});

test('dormant browse validator requires exact terminal proof for every pair', () => {
  withFixture((paths) => {
    for (let round = 1; round <= 3; round += 1) {
      const baseline = passingReceipt({
        round,
        role: 'baseline',
        model: 'gpt-5.6-sol',
        effort: 'high',
      });
      const candidate = passingReceipt({
        round,
        role: 'candidate',
        model: 'gpt-5.6-terra',
        effort: 'low',
      });
      if (round === 2) {
        delete candidate.metrics.terminalProof;
      }
      record(paths, baseline);
      record(paths, candidate);
    }

    const result = inspectDormantBrowseReceiptValidator(paths);
    assert.equal(result.model, 'gpt-5.6-sol');
    assert.equal(result.qualification.qualified, false);
    assert.equal(result.qualification.reason, 'mechanics_failure');
    assert.equal(result.qualification.terminalProofFailedPairs, 1);
  });
});

test('dormant browse validator rejects an unpaired mechanics failure', () => {
  withFixture((paths) => {
    for (let round = 1; round <= 3; round += 1) {
      record(paths, passingReceipt({
        round,
        role: 'baseline',
        model: 'gpt-5.6-sol',
        effort: 'high',
      }));
      record(paths, passingReceipt({
        round,
        role: 'candidate',
        model: 'gpt-5.6-terra',
        effort: 'low',
      }));
    }
    const failed = passingReceipt({
      round: 4,
      role: 'baseline',
      model: 'gpt-5.6-sol',
      effort: 'high',
    });
    failed.mechanicsStatus = 'terminal_proof_failed';
    failed.qualityStatus = 'not_scored';
    failed.metrics.terminalProof = false;
    record(paths, failed);

    const result = inspectDormantBrowseReceiptValidator(paths);
    assert.equal(result.model, 'gpt-5.6-sol');
    assert.equal(result.qualification.qualified, false);
    assert.equal(result.qualification.reason, 'mechanics_failure');
    assert.equal(result.qualification.mechanicsFailedPairs, 1);
  });
});

test('dormant browse validator rejects less than eighty percent paired fresh yield', () => {
  withFixture((paths) => {
    for (let round = 1; round <= 3; round += 1) {
      const baseline = passingReceipt({
        round,
        role: 'baseline',
        model: 'gpt-5.6-sol',
        effort: 'high',
      });
      const candidate = passingReceipt({
        round,
        role: 'candidate',
        model: 'gpt-5.6-terra',
        effort: 'low',
      });
      Object.assign(baseline.metrics, {
        terminalItems: 20,
        freshRows: 20,
        completeRows: 20,
      });
      Object.assign(candidate.metrics, {
        terminalItems: 1,
        freshRows: 1,
        completeRows: 1,
      });
      record(paths, baseline);
      record(paths, candidate);
    }

    const result = inspectDormantBrowseReceiptValidator(paths);
    assert.equal(result.model, 'gpt-5.6-sol');
    assert.equal(result.qualification.qualified, false);
    assert.equal(result.qualification.reason, 'outcome_equivalence_failure');
    assert.equal(result.qualification.outcomeEquivalenceFailedPairs, 3);
    assert.ok(Math.abs(result.qualification.meanOutcomeRatio - 0.05) < 1e-9);
    assert.equal(
      legacyTaskOnlyBrowsePairedPasses(readReceiptRows(paths)),
      0,
      'a task-only schema-v1 router must ignore v2 outcome-gate receipts',
    );
  });
});

test('dormant browse validator rejects a pair above one hundred twenty percent latency', () => {
  withFixture((paths) => {
    for (let round = 1; round <= 3; round += 1) {
      const baseline = passingReceipt({
        round,
        role: 'baseline',
        model: 'gpt-5.6-sol',
        effort: 'high',
      });
      const candidate = passingReceipt({
        round,
        role: 'candidate',
        model: 'gpt-5.6-terra',
        effort: 'low',
      });
      baseline.metrics.elapsedMs = 1000;
      candidate.metrics.elapsedMs = 10_000;
      record(paths, baseline);
      record(paths, candidate);
    }

    const result = inspectDormantBrowseReceiptValidator(paths);
    assert.equal(result.model, 'gpt-5.6-sol');
    assert.equal(result.qualification.qualified, false);
    assert.equal(result.qualification.reason, 'latency_equivalence_failure');
    assert.equal(result.qualification.latencyEquivalenceFailedPairs, 3);
    assert.equal(result.qualification.meanElapsedRatio, 10);
    assert.equal(
      legacyTaskOnlyBrowsePairedPasses(readReceiptRows(paths)),
      0,
      'a task-only schema-v1 router must ignore v2 latency-gate receipts',
    );
  });
});

test('dormant browse validator rejects token use above the bounded ratio', () => {
  withFixture((paths) => {
    for (let round = 1; round <= 3; round += 1) {
      const baseline = passingReceipt({
        round,
        role: 'baseline',
        model: 'gpt-5.6-sol',
        effort: 'high',
      });
      const candidate = passingReceipt({
        round,
        role: 'candidate',
        model: 'gpt-5.6-terra',
        effort: 'low',
      });
      if (round === 2) {
        candidate.metrics.inputTokens = 1400;
        candidate.metrics.outputTokens = 200;
        candidate.metrics.totalTokens = 1600;
      }
      record(paths, baseline);
      record(paths, candidate);
    }
    const result = inspectDormantBrowseReceiptValidator(paths);
    assert.equal(result.model, 'gpt-5.6-sol');
    assert.equal(result.qualification.reason, 'token_equivalence_failure');
    assert.equal(result.qualification.tokenEquivalenceFailedPairs, 1);
    assert.equal(result.qualification.maximumTotalTokenRatio, 1.5);
  });
});

test('dormant curator validator requires three paired reviewed full-snapshot rounds', () => {
  withFixture((paths) => {
    for (let round = 1; round <= 2; round += 1) {
      record(paths, curatorReceipt({
        round,
        role: 'baseline',
        model: 'gpt-5.6-sol',
        effort: 'high',
      }));
      record(paths, curatorReceipt({
        round,
        role: 'candidate',
        model: 'gpt-5.6-terra',
        effort: 'low',
      }));
    }
    let result = inspectDormantCuratorReceiptValidator(paths);
    assert.equal(result.model, 'gpt-5.6-sol');
    assert.equal(result.qualification.pairedPasses, 2);
    assert.equal(result.qualification.minimumPairedPasses, 3);
    assert.equal(result.qualification.requiredBenchmarkKind, 'full_curation_snapshot');
    assert.equal(result.qualification.requiredBenchmarkTask, 'curator_full_v2');

    record(paths, curatorReceipt({
      round: 3,
      role: 'baseline',
      model: 'gpt-5.6-sol',
      effort: 'high',
    }));
    record(paths, curatorReceipt({
      round: 3,
      role: 'candidate',
      model: 'gpt-5.6-terra',
      effort: 'low',
    }));
    result = inspectDormantCuratorReceiptValidator(paths);
    assert.equal(result.model, 'gpt-5.6-terra');
    assert.equal(result.effort, 'low');
    assert.equal(result.origin, 'benchmark_qualified_live');
    assert.equal(result.qualification.pairedPasses, 3);

    const production = resolve(paths, 'curator');
    assert.equal(production.model, 'gpt-5.6-sol');
    assert.equal(production.effort, 'high');
    assert.equal(production.origin, 'baseline_persistent_override_disabled');
    assert.equal(production.qualification, undefined);
    assert.equal(
      legacyTaskOnlyCuratorPairedPasses(readReceiptRows(paths)),
      0,
      'a task-only schema-v1 router must ignore v2 curator proof',
    );
  });
});

test('dormant curator validator rejects expired artifact reviews', () => {
  withFixture((paths) => {
    const expiredAtMs = Date.now() - (31 * 24 * 60 * 60 * 1000);
    for (let round = 1; round <= 3; round += 1) {
      record(paths, curatorReceipt({
        round,
        role: 'baseline',
        model: 'gpt-5.6-sol',
        effort: 'high',
        recordedAtMs: expiredAtMs,
      }));
      record(paths, curatorReceipt({
        round,
        role: 'candidate',
        model: 'gpt-5.6-terra',
        effort: 'low',
        recordedAtMs: expiredAtMs,
      }));
    }
    const result = inspectDormantCuratorReceiptValidator(paths);
    assert.equal(result.model, 'gpt-5.6-sol');
    assert.equal(result.origin, 'baseline_insufficient_paired_quality_passes');
    assert.equal(result.qualification.pairedPasses, 0);
  });
});

test('curator receipt writer refuses inferred quality and mismatched benchmark kinds', () => {
  withFixture((paths) => {
    const incompleteSnapshot = curatorReceipt({
      round: 1,
      role: 'baseline',
      model: 'gpt-5.6-sol',
      effort: 'high',
    });
    delete incompleteSnapshot.metrics.fullSnapshotProof;
    assert.throws(() => record(paths, incompleteSnapshot));
    assert.throws(() => record(paths, curatorReceipt({
      round: 1,
      role: 'baseline',
      model: 'gpt-5.6-sol',
      effort: 'high',
      reviewed: false,
    })));
    assert.throws(() => record(paths, curatorReceipt({
      round: 1,
      role: 'baseline',
      model: 'gpt-5.6-sol',
      effort: 'high',
      benchmarkKind: 'full_browse',
    })));
    assert.throws(() => record(paths, curatorReceipt({
      round: 1,
      role: 'baseline',
      model: 'gpt-5.6-sol',
      effort: 'high',
      task: 'curator',
    })));
    assert.throws(() => record(paths, curatorReceipt({
      round: 1,
      role: 'baseline',
      model: 'gpt-5.6-sol',
      effort: 'high',
      mechanicsStatus: 'timeout',
      qualityStatus: 'failed',
    })));
    assert.throws(() => record(paths, curatorReceipt({
      round: 1,
      role: 'baseline',
      model: 'gpt-5.6-sol',
      effort: 'high',
      mechanicsStatus: 'private failure detail',
      qualityStatus: 'not_scored',
      reviewed: false,
    })));
    assert.throws(() => record(paths, curatorReceipt({
      round: 1,
      role: 'typo',
      model: 'gpt-5.6-terra',
      effort: 'low',
    })));

    const pending = curatorReceipt({
      round: 1,
      role: 'baseline',
      model: 'gpt-5.6-sol',
      effort: 'high',
      reviewed: false,
      qualityStatus: 'not_scored',
    });
    pending.metrics.sourceText = 'private artifact content must not persist';
    record(paths, pending);
    const content = fs.readFileSync(paths.receipts, 'utf8');
    assert.doesNotMatch(content, /private artifact content|sourceText/);
    assert.equal(JSON.parse(content.trim()).qualityStatus, 'not_scored');
  });
});

test('dormant curator validator rejects legacy task-name receipts', () => {
  withFixture((paths) => {
    const rows = [];
    for (let round = 1; round <= 3; round += 1) {
      rows.push(
        curatorReceipt({
          round,
          role: 'baseline',
          model: 'gpt-5.6-sol',
          effort: 'high',
          task: 'curator',
        }),
        curatorReceipt({
          round,
          role: 'candidate',
          model: 'gpt-5.6-terra',
          effort: 'low',
          task: 'curator',
        }),
      );
    }
    fs.writeFileSync(
      paths.receipts,
      `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
      { mode: 0o600 },
    );

    const result = inspectDormantCuratorReceiptValidator(paths);
    assert.equal(result.model, 'gpt-5.6-sol');
    assert.equal(result.origin, 'baseline_ineligible_benchmark_task');
    assert.equal(result.qualification.qualified, false);
    assert.equal(result.qualification.requiredBenchmarkTask, 'curator_full_v2');
    assert.equal(
      legacyTaskOnlyCuratorPairedPasses(rows),
      3,
      'the legacy labels demonstrate why current curator receipts need a v2 task',
    );
  });
});

test('reviewed curator receipts retain proof metrics but no private artifact content', () => {
  withFixture((paths) => {
    const receipt = curatorReceipt({
      round: 1,
      role: 'candidate',
      model: 'gpt-5.6-terra',
      effort: 'low',
    });
    receipt.sourceText = 'private candidate content';
    receipt.metrics.reviewNote = 'private editorial judgment';
    record(paths, receipt);

    const content = fs.readFileSync(paths.receipts, 'utf8');
    const row = JSON.parse(content.trim());
    assert.doesNotMatch(content, /private candidate|private editorial|sourceText|reviewNote/);
    assert.equal(row.metrics.artifactReviewed, true);
    assert.equal(row.metrics.fullSnapshotProof, true);
    assert.match(row.metrics.artifactDigest, /^[a-f0-9]{64}$/);
    assert.match(row.metrics.runDigest, /^[a-f0-9]{64}$/);
  });
});

test('dormant curator validator rejects unreviewed or ambiguous rows', () => {
  withFixture((paths) => {
    const rows = [];
    for (let round = 1; round <= 3; round += 1) {
      for (const [role, model, effort] of [
        ['baseline', 'gpt-5.6-sol', 'high'],
        ['candidate', 'gpt-5.6-terra', 'low'],
      ]) {
        rows.push(curatorReceipt({
          round,
          role,
          model,
          effort,
          reviewed: false,
          benchmarkKind: 'full_browse',
        }));
      }
    }
    fs.writeFileSync(
      paths.receipts,
      `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
      { mode: 0o600 },
    );
    const result = inspectDormantCuratorReceiptValidator(paths);
    assert.equal(result.model, 'gpt-5.6-sol');
    assert.equal(result.origin, 'baseline_ineligible_benchmark_kind');
    assert.equal(result.qualification.qualified, false);
  });
});

test('legacy curator quality labels without artifact-review proof stay on baseline', () => {
  withFixture((paths) => {
    const rows = [];
    for (let round = 1; round <= 3; round += 1) {
      rows.push(
        curatorReceipt({
          round,
          role: 'baseline',
          model: 'gpt-5.6-sol',
          effort: 'high',
          reviewed: false,
        }),
        curatorReceipt({
          round,
          role: 'candidate',
          model: 'gpt-5.6-terra',
          effort: 'low',
          reviewed: false,
        }),
      );
    }
    fs.writeFileSync(
      paths.receipts,
      `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
      { mode: 0o600 },
    );

    const result = inspectDormantCuratorReceiptValidator(paths);
    assert.equal(result.model, 'gpt-5.6-sol');
    assert.equal(result.qualification.reason, 'quality_review_proof_failure');
    assert.equal(result.qualification.qualityReviewProofFailedPairs, 3);
  });
});

test('any curator mechanics failure invalidates the suite even without a peer', () => {
  withFixture((paths) => {
    for (let round = 1; round <= 3; round += 1) {
      record(paths, curatorReceipt({
        round,
        role: 'baseline',
        model: 'gpt-5.6-sol',
        effort: 'high',
      }));
      record(paths, curatorReceipt({
        round,
        role: 'candidate',
        model: 'gpt-5.6-terra',
        effort: 'low',
      }));
    }
    record(paths, curatorReceipt({
      round: 4,
      role: 'candidate',
      model: 'gpt-5.6-terra',
      effort: 'low',
      mechanicsStatus: 'restore_failed',
      qualityStatus: 'not_scored',
      reviewed: false,
    }));

    const result = inspectDormantCuratorReceiptValidator(paths);
    assert.equal(result.model, 'gpt-5.6-sol');
    assert.equal(result.qualification.reason, 'mechanics_failure');
    assert.equal(result.qualification.pairedPasses, 3);
    assert.equal(result.qualification.mechanicsFailedPairs, 1);
  });
});

test('dormant browse validator separates mechanics failures from model-quality failures', () => {
  withFixture((paths) => {
    for (let round = 1; round <= 4; round += 1) {
      const baseline = passingReceipt({
        round,
        role: 'baseline',
        model: 'gpt-5.6-sol',
        effort: 'high',
      });
      const candidate = passingReceipt({
        round,
        role: 'candidate',
        model: 'gpt-5.6-terra',
        effort: 'low',
      });
      if (round === 4) {
        candidate.mechanicsStatus = 'timeout';
        candidate.qualityStatus = 'not_scored';
      }
      record(paths, baseline);
      record(paths, candidate);
    }
    const result = inspectDormantBrowseReceiptValidator(paths);
    assert.equal(result.model, 'gpt-5.6-sol');
    assert.equal(result.qualification.reason, 'mechanics_failure');
    assert.equal(result.qualification.pairedPasses, 3);
    assert.equal(result.qualification.mechanicsFailedPairs, 1);
  });
});

test('grounded micro benchmark checks outputs against the captured accessibility tree', () => {
  withFixture((paths) => {
    const response = path.join(paths.directory, 'response.txt');
    const tree = path.join(paths.directory, 'tree.txt');
    fs.writeFileSync(response, [
      'diagnostic text',
      '{"titles":["First useful title","Second useful title","Third useful title","Fourth useful title","Fifth useful title"]}',
    ].join('\n'));
    fs.writeFileSync(tree, [
      'First useful title',
      'Second useful title',
      'Third useful title',
      'Fourth useful title',
      'Fifth useful title',
      'Subscriptions and navigation metadata long enough to prove a real tree.',
    ].join('\n'));
    const result = JSON.parse(execFileSync('python3', [
      tool,
      'grounded-titles',
      '--response', response,
      '--tree', tree,
    ], { encoding: 'utf8' }));
    assert.equal(result.mechanicsStatus, 'passed');
    assert.equal(result.qualityStatus, 'passed');
    assert.equal(result.metrics.distinctTitles, 5);
    assert.equal(result.metrics.groundedTitles, 5);
    assert.match(result.metrics.caseDigest, /^[a-f0-9]{64}$/);
  });
});

test('grounded micro benchmark rejects duplicate titles after normalization', () => {
  withFixture((paths) => {
    const response = path.join(paths.directory, 'response.txt');
    const tree = path.join(paths.directory, 'tree.txt');
    fs.writeFileSync(response, JSON.stringify({
      titles: [
        'One Real Video',
        'one-real-video',
        'ONE REAL VIDEO!',
        'One   Real   Video',
        'One Real Video.',
      ],
    }));
    fs.writeFileSync(tree, [
      'One Real Video',
      'Subscriptions and navigation metadata long enough to prove a real tree.',
    ].join('\n'));
    const result = JSON.parse(execFileSync('python3', [
      tool,
      'grounded-titles',
      '--response', response,
      '--tree', tree,
    ], { encoding: 'utf8' }));
    assert.equal(result.mechanicsStatus, 'passed');
    assert.equal(result.qualityStatus, 'failed');
    assert.equal(result.metrics.reportedTitles, 5);
    assert.equal(result.metrics.distinctTitles, 1);
    assert.equal(result.metrics.groundedTitles, 1);
  });
});

test('codex JSON usage extraction emits only bounded numeric metrics', () => {
  withFixture((paths) => {
    const events = path.join(paths.directory, 'codex-events.jsonl');
    fs.writeFileSync(events, [
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'private source content' },
      }),
      JSON.stringify({
        type: 'turn.completed',
        usage: {
          input_tokens: 1200,
          cached_input_tokens: 700,
          output_tokens: 300,
        },
      }),
    ].join('\n'), { mode: 0o600 });

    const output = execFileSync('python3', [
      tool,
      'codex-usage',
      '--events', events,
    ], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(output), {
      inputTokens: 1200,
      cachedInputTokens: 700,
      outputTokens: 300,
      totalTokens: 1500,
    });
    assert.doesNotMatch(output, /private source content|agent_message/);
  });
});

test('durable benchmark receipts contain only safe metrics and no source text', () => {
  withFixture((paths) => {
    record(paths, passingReceipt({
      round: 1,
      role: 'candidate',
      model: 'gpt-5.6-terra',
      effort: 'low',
    }));
    const content = fs.readFileSync(paths.receipts, 'utf8');
    assert.doesNotMatch(content, /useful title|response|sourceText|rawOutput/);
    assert.equal(fs.statSync(paths.receipts).mode & 0o777, 0o600);
    const row = JSON.parse(content.trim());
    assert.equal(row.task, 'browse_mixed_full_v3');
    assert.equal(row.benchmarkKind, 'full_browse_mixed');

    const contentBearingStatus = passingReceipt({
      round: 2,
      role: 'candidate',
      model: 'gpt-5.6-terra',
      effort: 'low',
    });
    contentBearingStatus.mechanicsStatus = 'private title fragment';
    assert.throws(() => record(paths, contentBearingStatus));

    const ambiguousRole = passingReceipt({
      round: 2,
      role: 'typo',
      model: 'gpt-5.6-terra',
      effort: 'low',
    });
    assert.throws(() => record(paths, ambiguousRole));
    assert.equal(fs.readFileSync(paths.receipts, 'utf8'), content);
  });
});

test('notification routing is explicitly model-free', () => {
  withFixture((paths) => {
    const result = resolve(paths, 'notification');
    assert.equal(result.execution, 'deterministic');
    assert.equal(result.model, '');
  });
});

test('overseer falls back to Sol high and Max or Ultra require explicit config or env', () => {
  withFixture((paths) => {
    fs.writeFileSync(paths.live, JSON.stringify({
      schemaVersion: 1,
      routes: {
        overseer: {
          model: 'gpt-5.6-sol',
          effort: 'ultra',
        },
      },
    }));
    fs.chmodSync(paths.live, 0o600);
    let result = resolve(paths, 'overseer');
    assert.equal(result.model, 'gpt-5.6-sol');
    assert.equal(result.effort, 'high');
    assert.equal(result.origin, 'baseline_persistent_override_disabled');

    fs.appendFileSync(paths.config, [
      '',
      '## Overseer Model',
      'gpt-5.6-sol',
      '',
      '## Overseer Reasoning',
      'ultra',
    ].join('\n'));
    result = resolve(paths, 'overseer');
    assert.equal(result.model, 'gpt-5.6-sol');
    assert.equal(result.effort, 'ultra');
  });
});

test('private route artifact validator is mode-bounded and permits first-run absence', () => {
  withFixture((paths) => {
    assert.doesNotThrow(() => execFileSync('python3', [
      tool,
      'validate-live',
      '--live', paths.live,
      '--policy', policy,
    ]));
    fs.chmodSync(paths.live, 0o644);
    assert.throws(() => execFileSync('python3', [
      tool,
      'validate-live',
      '--live', paths.live,
      '--policy', policy,
    ]));
    fs.rmSync(paths.live);
    assert.doesNotThrow(() => execFileSync('python3', [
      tool,
      'validate-live',
      '--live', paths.live,
      '--policy', policy,
      '--allow-missing',
    ]));
  });
});

test('phone cycle routes browse and curator independently and passes the curator model per task', () => {
  const cycle = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/phone-tools/evogent-cycle.sh'),
    'utf8',
  );
  assert.match(cycle, /model_routing\.py/);
  assert.match(cycle, /resolve_model_route browse/);
  assert.match(cycle, /resolve_model_route browse_youtube/);
  assert.match(cycle, /resolve_model_route curator/);
  assert.match(cycle, /model_reasoning_effort="\$BROWSE_EFFORT"/);
  assert.match(cycle, /"codexModel":sys\.argv\[5\]/);
  assert.match(cycle, /EVOGENT_BACKGROUND_SOURCE_BROWSING/);
  assert.doesNotMatch(cycle, /model_reasoning_effort=medium[\s\\]*--dangerously-bypass[\s\S]{0,120}"\$prompt"/);
});

test('computer-use benchmarks persist downgrade-safe content-free receipts', () => {
  for (const name of [
    'benchmark-cu-micro.sh',
    'benchmark-browse-models.sh',
    'benchmark-curation.sh',
  ]) {
    const benchmarkPath = path.join(
      root,
      'phone-paradigm/device/phone-tools',
      name,
    );
    assert.notEqual(
      fs.statSync(benchmarkPath).mode & 0o111,
      0,
      `${name} must remain directly executable after release packaging`,
    );
  }
  for (const name of ['benchmark-cu-micro.sh', 'benchmark-browse-models.sh']) {
    const script = fs.readFileSync(
      path.join(root, 'phone-paradigm/device/phone-tools', name),
      'utf8',
    );
    assert.match(script, /model-benchmark-results\.jsonl/);
    assert.match(script, /MECHANICS=timeout/);
    assert.match(script, /QUALITY=not_scored/);
    assert.match(script, /model_routing\.py/);
    assert.doesNotMatch(script, /say\s+"\$MODEL:[^"]*\$RESP/);
  }
  const micro = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/phone-tools/benchmark-cu-micro.sh'),
    'utf8',
  );
  assert.match(micro, /"task":"browse_micro"/);
  assert.match(micro, /"benchmarkKind":"grounded_micro"/);
  const fullBrowse = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/phone-tools/benchmark-browse-models.sh'),
    'utf8',
  );
  assert.match(fullBrowse, /"task":"browse_youtube_smoke_v1"/);
  assert.match(fullBrowse, /"benchmarkKind":"full_browse_youtube_smoke"/);
  assert.match(fullBrowse, /cannot qualify any persistent route/);
  assert.doesNotMatch(fullBrowse, /QUALITY=passed/);
  assert.doesNotMatch(fullBrowse, /using a suite to change routing/);
  assert.match(fullBrowse, /RUN_ID="full-browse-/);
  assert.match(fullBrowse, /benchmark-browse-finalize\.py finalize --run-id/);
  assert.match(fullBrowse, /benchmark-browse-finalize\.py"|FINALIZER=/);
  assert.match(fullBrowse, /MECHANICS=terminal_proof_failed/);
  assert.doesNotMatch(fullBrowse, /print\("passed" if n>0/);
  const curation = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/phone-tools/benchmark-curation.sh'),
    'utf8',
  );
  assert.match(curation, /unavailable: refusing to mutate the production phone/);
  assert.match(curation, /isolated SQLite, JSONL\/audit, preference, config, and session state/);
  assert.match(curation, /exact cycle-bound candidate, selection, reason, and terminal-receipt deltas/);
  assert.match(curation, /No\s+benchmark artifact or qualification receipt was written/);
  assert.match(curation, /exit 75/);
  assert.doesNotMatch(curation, /evogent-cycle\.sh[" ]/);
  assert.doesNotMatch(curation, /model_routing\.py\s+record/);
});

test('daily overseer is one bounded review and cannot become a phone-side developer', () => {
  const policyValue = JSON.parse(fs.readFileSync(policy, 'utf8'));
  const instruction = fs.readFileSync(
    path.join(root, '.claude/commands/oversee.md'),
    'utf8',
  );
  assert.equal(policyValue.routes.overseer.maximumRunsPerServiceDay, 1);
  assert.equal(policyValue.routes.overseer.persistentOverrideAllowed, false);
  assert.deepEqual(policyValue.routes.overseer.modelSections, ['Overseer Model']);
  assert.deepEqual(
    policyValue.routes.browse.modelSections,
    ['Browse Model', 'Codex Model'],
  );
  assert.equal(policyValue.routes.browse.persistentOverrideAllowed, false);
  assert.deepEqual(
    policyValue.routes.browse_youtube.modelSections,
    ['YouTube Browse Model', 'Browse Model', 'Codex Model'],
  );
  assert.equal(policyValue.routes.browse_youtube.persistentOverrideAllowed, false);
  assert.equal(policyValue.routes.curator.persistentOverrideAllowed, false);
  assert.match(instruction, /Do not edit product code/);
  assert.match(instruction, /Do not change the `overseer` route/);
  assert.match(instruction, /Do not launch a\s+development agent on the phone/);
  assert.match(instruction, /OVERSEER_RESULT completed/);
  assert.match(instruction, /replaces\s+the former overlapping daily reflection\/dream passes/);
});
