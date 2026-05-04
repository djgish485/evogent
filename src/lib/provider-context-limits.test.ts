import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { getProviderContextMetrics, resolveProviderContextLimit } from './provider-context-limits';

describe('provider-context-limits', () => {
  test('uses the explicit Claude 1M context window thresholds', () => {
    const metrics = getProviderContextMetrics({
      provider: 'claude',
      latestContextTokens: 564_000,
      latestContextWindow: 1_000_000,
      latestContextModel: 'claude-opus-4-7[1m]',
    });

    assert.deepStrictEqual(metrics && {
      limit: metrics.limit,
      warnAt: metrics.warnAt,
      criticalAt: metrics.criticalAt,
      utilizationPercent: metrics.utilizationPercent,
      status: metrics.status,
    }, {
      limit: 1_000_000,
      warnAt: 500_000,
      criticalAt: 800_000,
      utilizationPercent: 56,
      status: 'warn',
    });
  });

  test('falls back to known 200k Claude limits when no explicit window is persisted', () => {
    assert.strictEqual(resolveProviderContextLimit({
      provider: 'claude',
      latestContextWindow: null,
      latestContextModel: 'claude-sonnet-4-6',
    }), 200_000);
  });

  test('uses the explicit Codex window when one is persisted', () => {
    const metrics = getProviderContextMetrics({
      provider: 'codex',
      latestContextTokens: 177_111,
      latestContextWindow: 258_400,
      latestContextModel: 'gpt-5.5',
    });

    assert.deepStrictEqual(metrics && {
      limit: metrics.limit,
      warnAt: metrics.warnAt,
      criticalAt: metrics.criticalAt,
      utilizationPercent: metrics.utilizationPercent,
      status: metrics.status,
    }, {
      limit: 258_400,
      warnAt: 129_200,
      criticalAt: 206_720,
      utilizationPercent: 69,
      status: 'warn',
    });
  });

  test('hides impossible Codex cumulative totals instead of rendering false context usage', () => {
    assert.strictEqual(getProviderContextMetrics({
      provider: 'codex',
      latestContextTokens: 3_531_600,
      latestContextWindow: 1_000_000,
      latestContextModel: 'gpt-5.5',
    }), null);
  });

  test('uses explicit windows for any provider that persists valid metrics', () => {
    const metrics = getProviderContextMetrics({
      provider: 'future-provider',
      latestContextTokens: 75,
      latestContextWindow: 100,
      latestContextModel: 'future-model',
    });

    assert.deepStrictEqual(metrics && {
      limit: metrics.limit,
      utilizationPercent: metrics.utilizationPercent,
      status: metrics.status,
    }, {
      limit: 100,
      utilizationPercent: 75,
      status: 'warn',
    });
  });
});
