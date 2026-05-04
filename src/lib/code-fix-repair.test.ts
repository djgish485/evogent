import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { classifyCodeFixFailure } from './code-fix-repair';

describe('code-fix repair classification', () => {
  test('classifies missing provider binaries into stable repair incidents', () => {
    const classification = classifyCodeFixFailure({
      phase: 'agent_execution',
      error: 'codex: command not found',
      logTail: 'bash: line 1: codex: command not found',
    });

    assert.equal(classification.category, 'provider_binary_missing');
    assert.equal(classification.incidentKey, 'dev-agent:provider-binary-missing:codex');
    assert.equal(classification.autoRepairEligible, true);
    assert.match(classification.summary, /codex cli is missing or unavailable/i);
  });

  test('suppresses auto-repair for transient validation failures', () => {
    const classification = classifyCodeFixFailure({
      phase: 'pipeline',
      error: 'FAIL: Tests failed',
      logTail: 'npm run test\nFAIL: Tests failed',
    });

    assert.equal(classification.category, 'transient_validation_failure');
    assert.equal(classification.incidentKey, null);
    assert.equal(classification.autoRepairEligible, false);
  });

  test('preserves terminalReason for stable terminal diagnostics', () => {
    const classification = classifyCodeFixFailure({
      phase: 'agent_execution',
      terminalReason: 'startup_wedge_no_repo_work',
      error: 'Agent did not create .agent-done after 3/3 attempts.',
    });

    assert.equal(classification.terminalReason, 'startup_wedge_no_repo_work');
  });
});
