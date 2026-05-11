import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readTimeZoneConfig } from '../../lib/time-zone.js';

export const OPENCLAW_DAILY_TIMER_UNIT = 'openclaw-skills-daily.timer';
export const DEFAULT_OPENCLAW_DAILY_BRIEF_LOCAL_TIME = '07:00';

export type OpenClawDailyTimerState =
  | 'not_installed'
  | 'aligned'
  | 'misaligned'
  | 'unsupported';

export interface OpenClawDailyTimerStatus {
  installed: boolean;
  state: OpenClawDailyTimerState;
  unitName: string;
  timeZone: string;
  desiredLocalTime: string;
  desiredOnCalendar: string;
  currentOnCalendar: string[];
  repairAvailable: boolean;
  warning: string | null;
  dropInPath: string | null;
}

interface CommandRunner {
  execFileSync: typeof execFileSync;
}

interface AnalyzeOpenClawDailyTimerInput {
  unitContent: string | null;
  timeZone: string;
  desiredLocalTime?: string;
  supportsCalendarTimeZone: boolean;
  unitName?: string;
  dropInPath?: string | null;
}

function normalizeLocalTime(value: string | null | undefined): string {
  const match = typeof value === 'string'
    ? value.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/)
    : null;
  if (!match) return DEFAULT_OPENCLAW_DAILY_BRIEF_LOCAL_TIME;

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return DEFAULT_OPENCLAW_DAILY_BRIEF_LOCAL_TIME;
  }

  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function buildOpenClawDailyOnCalendar(timeZone: string, desiredLocalTime = DEFAULT_OPENCLAW_DAILY_BRIEF_LOCAL_TIME): string {
  const localTime = normalizeLocalTime(desiredLocalTime);
  return `*-*-* ${localTime}:00 ${timeZone}`;
}

function normalizeCalendarExpression(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, ' ');
  const match = trimmed.match(/^\*-\*-\*\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s+(.+))?$/);
  if (!match) return trimmed;

  const hour = String(Number(match[1])).padStart(2, '0');
  const minute = match[2];
  const second = match[3] ?? '00';
  const zone = match[4]?.trim();
  return `*-*-* ${hour}:${minute}:${second}${zone ? ` ${zone}` : ''}`;
}

function parseTimerTimeZoneDirective(unitContent: string): string | null {
  const match = unitContent.match(/^\s*TimeZone\s*=\s*([^\n#]+)/im);
  return match?.[1]?.trim() || null;
}

function parseOnCalendarLines(unitContent: string): string[] {
  return unitContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .flatMap((line) => {
      const match = line.match(/^OnCalendar\s*=\s*(.*)$/i);
      return match ? [match[1].trim()] : [];
    })
    .filter(Boolean);
}

function hasLegacySixUtcCalendar(currentOnCalendar: string[]): boolean {
  return currentOnCalendar
    .map(normalizeCalendarExpression)
    .some((line) => /^\*-\*-\*\s+06:00:00(?:\s+UTC)?$/i.test(line));
}

export function analyzeOpenClawDailyTimer(input: AnalyzeOpenClawDailyTimerInput): OpenClawDailyTimerStatus {
  const unitName = input.unitName ?? OPENCLAW_DAILY_TIMER_UNIT;
  const desiredLocalTime = normalizeLocalTime(input.desiredLocalTime);
  const desiredOnCalendar = buildOpenClawDailyOnCalendar(input.timeZone, desiredLocalTime);

  if (!input.unitContent) {
    return {
      installed: false,
      state: 'not_installed',
      unitName,
      timeZone: input.timeZone,
      desiredLocalTime,
      desiredOnCalendar,
      currentOnCalendar: [],
      repairAvailable: false,
      warning: null,
      dropInPath: input.dropInPath ?? null,
    };
  }

  const currentOnCalendar = parseOnCalendarLines(input.unitContent);
  const normalizedDesired = normalizeCalendarExpression(desiredOnCalendar);
  const timerTimeZone = parseTimerTimeZoneDirective(input.unitContent);
  const desiredWithoutZone = normalizeCalendarExpression(`*-*-* ${desiredLocalTime}:00`);
  const aligned = currentOnCalendar.some((line) => {
    const normalizedLine = normalizeCalendarExpression(line);
    return normalizedLine === normalizedDesired
      || (timerTimeZone === input.timeZone && normalizedLine === desiredWithoutZone);
  });

  if (aligned) {
    return {
      installed: true,
      state: 'aligned',
      unitName,
      timeZone: input.timeZone,
      desiredLocalTime,
      desiredOnCalendar,
      currentOnCalendar,
      repairAvailable: false,
      warning: null,
      dropInPath: input.dropInPath ?? null,
    };
  }

  const legacySixUtc = hasLegacySixUtcCalendar(currentOnCalendar);
  if (!input.supportsCalendarTimeZone) {
    return {
      installed: true,
      state: 'unsupported',
      unitName,
      timeZone: input.timeZone,
      desiredLocalTime,
      desiredOnCalendar,
      currentOnCalendar,
      repairAvailable: false,
      warning: `OpenClaw daily timer is not synced to ${desiredLocalTime} ${input.timeZone}, and this host does not support time zones in systemd calendar expressions. Evogent will not silently replace it with a fixed UTC hour because that would drift across DST.`,
      dropInPath: input.dropInPath ?? null,
    };
  }

  return {
    installed: true,
    state: 'misaligned',
    unitName,
    timeZone: input.timeZone,
    desiredLocalTime,
    desiredOnCalendar,
    currentOnCalendar,
    repairAvailable: true,
    warning: legacySixUtc
      ? `OpenClaw daily timer currently uses 06:00 without a configured time zone. In ${input.timeZone}, that is not a stable local-morning schedule across DST.`
      : `OpenClaw daily timer is not synced to ${desiredLocalTime} ${input.timeZone}.`,
    dropInPath: input.dropInPath ?? null,
  };
}

function runCommand(runner: CommandRunner, command: string, args: string[]): string {
  return runner.execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5000,
  }).toString();
}

function getDropInPath(unitName: string): string {
  const configHome = process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config');
  return path.join(configHome, 'systemd', 'user', `${unitName}.d`, 'evogent-timezone.conf');
}

function systemdSupportsCalendarTimeZone(runner: CommandRunner, timeZone: string, desiredLocalTime: string): boolean {
  try {
    runCommand(runner, 'systemd-analyze', ['calendar', buildOpenClawDailyOnCalendar(timeZone, desiredLocalTime)]);
    return true;
  } catch {
    return false;
  }
}

function readTimerUnitContent(runner: CommandRunner, unitName: string): string | null {
  try {
    return runCommand(runner, 'systemctl', ['--user', 'cat', unitName]);
  } catch {
    return null;
  }
}

export function getOpenClawDailyTimerStatus(
  options: { unitName?: string; desiredLocalTime?: string; runner?: CommandRunner } = {},
): OpenClawDailyTimerStatus {
  const runner = options.runner ?? { execFileSync };
  const unitName = options.unitName ?? OPENCLAW_DAILY_TIMER_UNIT;
  const timeZone = readTimeZoneConfig(path.join(process.cwd(), 'data', 'config.md')).timeZone;
  const desiredLocalTime = normalizeLocalTime(options.desiredLocalTime);
  const unitContent = readTimerUnitContent(runner, unitName);
  const supportsCalendarTimeZone = unitContent
    ? systemdSupportsCalendarTimeZone(runner, timeZone, desiredLocalTime)
    : false;

  return analyzeOpenClawDailyTimer({
    unitContent,
    timeZone,
    desiredLocalTime,
    supportsCalendarTimeZone,
    unitName,
    dropInPath: getDropInPath(unitName),
  });
}

export function repairOpenClawDailyTimer(
  options: { unitName?: string; desiredLocalTime?: string; runner?: CommandRunner } = {},
): OpenClawDailyTimerStatus {
  const runner = options.runner ?? { execFileSync };
  const currentStatus = getOpenClawDailyTimerStatus({ ...options, runner });
  if (!currentStatus.installed || currentStatus.state === 'aligned') {
    return currentStatus;
  }

  if (!currentStatus.repairAvailable) {
    throw new Error(currentStatus.warning || 'OpenClaw daily timer cannot be repaired on this host.');
  }

  const dropInPath = currentStatus.dropInPath ?? getDropInPath(currentStatus.unitName);
  const dropInContent = [
    '[Timer]',
    'OnCalendar=',
    `OnCalendar=${currentStatus.desiredOnCalendar}`,
    '',
  ].join('\n');

  fs.mkdirSync(path.dirname(dropInPath), { recursive: true });
  fs.writeFileSync(dropInPath, dropInContent, 'utf8');
  runCommand(runner, 'systemctl', ['--user', 'daemon-reload']);
  runCommand(runner, 'systemctl', ['--user', 'restart', currentStatus.unitName]);

  return {
    ...currentStatus,
    state: 'aligned',
    currentOnCalendar: [currentStatus.desiredOnCalendar],
    repairAvailable: false,
    warning: null,
    dropInPath,
  };
}
