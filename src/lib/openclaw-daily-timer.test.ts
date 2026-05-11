import assert from 'node:assert';
import { describe, test } from 'node:test';
import { analyzeOpenClawDailyTimer, buildOpenClawDailyOnCalendar } from './openclaw-daily-timer';

describe('OpenClaw daily timer sync', () => {
  test('builds a DST-safe systemd calendar expression with an IANA time zone', () => {
    assert.strictEqual(
      buildOpenClawDailyOnCalendar('America/Denver', '7:00'),
      '*-*-* 07:00:00 America/Denver',
    );
  });

  test('detects the legacy 06:00 UTC-style timer as misaligned for Denver', () => {
    const status = analyzeOpenClawDailyTimer({
      timeZone: 'America/Denver',
      supportsCalendarTimeZone: true,
      unitContent: [
        '# /home/user/.config/systemd/user/openclaw-skills-daily.timer',
        '[Timer]',
        'OnCalendar=*-*-* 06:00:00',
        '',
      ].join('\n'),
    });

    assert.strictEqual(status.installed, true);
    assert.strictEqual(status.state, 'misaligned');
    assert.strictEqual(status.repairAvailable, true);
    assert.match(String(status.warning), /06:00/);
    assert.strictEqual(status.desiredOnCalendar, '*-*-* 07:00:00 America/Denver');
  });

  test('accepts an existing timezone-aware local morning timer as aligned', () => {
    const status = analyzeOpenClawDailyTimer({
      timeZone: 'America/Denver',
      supportsCalendarTimeZone: true,
      unitContent: [
        '[Timer]',
        'OnCalendar=*-*-* 07:00:00 America/Denver',
        '',
      ].join('\n'),
    });

    assert.strictEqual(status.state, 'aligned');
    assert.strictEqual(status.repairAvailable, false);
    assert.strictEqual(status.warning, null);
  });

  test('surfaces unsupported systemd timezone handling instead of fixed UTC fallback', () => {
    const status = analyzeOpenClawDailyTimer({
      timeZone: 'America/Denver',
      supportsCalendarTimeZone: false,
      unitContent: [
        '[Timer]',
        'OnCalendar=*-*-* 06:00:00',
        '',
      ].join('\n'),
    });

    assert.strictEqual(status.state, 'unsupported');
    assert.strictEqual(status.repairAvailable, false);
    assert.match(String(status.warning), /fixed UTC hour/);
  });

  test('returns no warning when OpenClaw timer is not installed', () => {
    const status = analyzeOpenClawDailyTimer({
      timeZone: 'America/Denver',
      supportsCalendarTimeZone: true,
      unitContent: null,
    });

    assert.strictEqual(status.installed, false);
    assert.strictEqual(status.state, 'not_installed');
    assert.strictEqual(status.warning, null);
  });
});
