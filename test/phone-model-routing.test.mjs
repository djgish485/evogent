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
    },
  }));
  fs.chmodSync(paths.live, 0o600);
  try {
    run(paths);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function resolve(paths, task = 'browse') {
  return JSON.parse(execFileSync('python3', [
    tool,
    'resolve',
    '--task', task,
    '--config', paths.config,
    '--policy', policy,
    '--live', paths.live,
    '--receipts', paths.receipts,
    '--json',
  ], { encoding: 'utf8' }));
}

function record(paths, receipt) {
  execFileSync('python3', [
    tool,
    'record',
    '--ledger', paths.receipts,
    '--receipt-json', JSON.stringify(receipt),
  ]);
}

function passingReceipt({ round, role, model, effort, recordedAtMs = Date.now() }) {
  return {
    schemaVersion: 1,
    recordedAtMs,
    suiteId: 'suite-1',
    round,
    task: 'browse',
    role,
    model,
    effort,
    mechanicsStatus: 'passed',
    qualityStatus: 'passed',
    metrics: {
      elapsedMs: role === 'baseline' ? 1000 : 600,
      reportedTitles: 5,
      groundedTitles: 5,
      requiredTitles: 5,
    },
  };
}

test('routine route stays on its configured baseline without paired quality proof', () => {
  withFixture((paths) => {
    const result = resolve(paths);
    assert.equal(result.model, 'gpt-5.6-sol');
    assert.equal(result.effort, 'high');
    assert.match(result.origin, /^baseline_/);
    assert.equal(result.qualification.qualified, false);
  });
});

test('routine route accepts a cheaper candidate only after three paired passes', () => {
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
    assert.equal(result.model, 'gpt-5.6-terra');
    assert.equal(result.effort, 'low');
    assert.equal(result.origin, 'benchmark_qualified_live');
    assert.equal(result.qualification.pairedPasses, 3);
    assert.ok(result.qualification.meanElapsedRatio < 1);
  });
});

test('mechanics failures invalidate a suite without becoming model-quality failures', () => {
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
    const result = resolve(paths);
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
    assert.equal(result.metrics.groundedTitles, 5);
    assert.match(result.metrics.caseDigest, /^[a-f0-9]{64}$/);
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
    assert.doesNotThrow(() => JSON.parse(content.trim()));
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
  assert.match(cycle, /resolve_model_route curator/);
  assert.match(cycle, /model_reasoning_effort="\$BROWSE_EFFORT"/);
  assert.match(cycle, /"codexModel":sys\.argv\[5\]/);
  assert.match(cycle, /EVOGENT_BACKGROUND_SOURCE_BROWSING/);
  assert.doesNotMatch(cycle, /model_reasoning_effort=medium[\s\\]*--dangerously-bypass[\s\S]{0,120}"\$prompt"/);
});

test('computer-use benchmarks persist content-free statuses and never score timeouts as quality', () => {
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
  const curation = fs.readFileSync(
    path.join(root, 'phone-paradigm/device/phone-tools/benchmark-curation.sh'),
    'utf8',
  );
  assert.match(curation, /EVOGENT_CODEX_MODEL="\$model"/);
  assert.match(curation, /EVOGENT_CURATOR_REASONING="\$effort"/);
  assert.match(curation, /EVOGENT_BACKGROUND_SOURCE_BROWSING=Off/);
  assert.match(curation, /never qualifies a cheaper route by itself/);
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
  assert.match(instruction, /Do not edit product code/);
  assert.match(instruction, /Do not change the `overseer` route/);
  assert.match(instruction, /Do not launch a\s+development agent on the phone/);
  assert.match(instruction, /OVERSEER_RESULT completed/);
  assert.match(instruction, /replaces\s+the former overlapping daily reflection\/dream passes/);
});
