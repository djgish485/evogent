import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const contracts = fs
  .readFileSync('.intent/contracts.jsonl', 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));
const backlog = fs
  .readFileSync('.intent/backlog.jsonl', 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));
const failureModes = fs
  .readFileSync('.intent/failure-modes.jsonl', 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));
const architecture = fs.readFileSync(
  'docs/phone-installation-and-provisioning.md',
  'utf8',
);
const architectureProse = architecture.replace(/\s+/g, ' ');

function contractByKey(key) {
  return contracts.find((entry) => entry.key === key);
}

test('technical-user installation is agent-assisted, resumable, and security preserving', () => {
  const contract = contractByKey('phone-install-agent-assisted-resumable');
  assert.ok(contract);
  assert.equal(contract.status, 'law');
  assert.match(contract.statement, /technical user aided by a local coding agent/);
  assert.match(contract.statement, /typed nonterminal user_action_required state/);
  assert.match(contract.statement, /resume idempotently/);
  assert.match(contract.statement, /never disables, bypasses, or falsely reports/);

  assert.match(architectureProse, /Play Protect may recommend a scan/);
  assert.match(architectureProse, /inspect a fresh display-0 image before input/);
  assert.match(architectureProse, /An accepted scan is not proof that installation finished/);
  assert.match(architectureProse, /explicit refusal, harmful-app verdict, signature conflict, or unresolvable security block fails closed/);
});

test('nontechnical bulk installation is a supported managed channel, not a sideload loop', () => {
  const contract = contractByKey('phone-install-managed-fleet');
  assert.ok(contract);
  assert.equal(contract.status, 'law');
  assert.match(contract.statement, /supported managed provisioning/);
  assert.match(contract.statement, /separate private state per device/);
  assert.match(contract.statement, /Android security boundaries remain explicit/);

  assert.match(architectureProse, /verified private or public managed app/);
  assert.match(architectureProse, /A personally owned device must not be silently converted into a fully managed device/);
  assert.match(architectureProse, /must fit its current permissible-use rules/);
  assert.match(architectureProse, /Repeating ADB sideloads|installed with ADB/);
  assert.match(architectureProse, /roadmap/i);
});

test('public intent remembers the two channels and foreground scan failure class', () => {
  const pivot = backlog.find(
    (entry) => entry.key === 'phone-installation-two-channel-product',
  );
  assert.ok(pivot);
  assert.equal(pivot.privacy_scope, 'product-wide');
  assert.equal(pivot.status, 'active');

  const foregroundGate = failureModes.find(
    (entry) => entry.class === 'user-action-required',
  );
  assert.ok(foregroundGate);
  assert.equal(foregroundGate.phoneRelevant, true);
  assert.match(foregroundGate.mode, /Android or Play Protect/);
  assert.match(foregroundGate.selfHeal, /continue idempotently/);
  assert.match(foregroundGate.selfHeal, /fails closed/);
});
