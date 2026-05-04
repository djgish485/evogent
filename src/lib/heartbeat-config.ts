import fs from 'node:fs';
import { getDataPath } from '@/lib/data-dir';
import { getUsageLevelConfig, parseUsageLevel } from '@/lib/usage-level';
import {
  DEFAULT_AUTOMATIC_CURATION_ENABLED,
  parseAutomaticCurationEnabled,
} from '../../lib/brain-config.js';

export interface CurationScheduleConfig {
  minIntervalMinutes: number;
  maxIntervalMinutes: number;
}

export interface HeartbeatConfig extends CurationScheduleConfig {
  automaticCurationEnabled: boolean;
}

function getUsageLevelScheduleDefaults(content: string): CurationScheduleConfig {
  const usageLevelConfig = parseUsageLevel(content);
  return {
    minIntervalMinutes: usageLevelConfig.defaultMinInterval,
    maxIntervalMinutes: usageLevelConfig.defaultMaxInterval,
  };
}

function parseIntervalMinutes(rawValue: string): number | null {
  const match = rawValue
    .trim()
    .toLowerCase()
    .match(/(-?\d+(?:\.\d+)?)\s*(hours?|hrs?|hr|h|minutes?|mins?|min|m)\b/);

  if (!match) return null;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const unit = match[2];
  const multiplier = unit.startsWith('h') ? 60 : 1;
  return Math.max(1, Math.floor(amount * multiplier));
}

function extractCurationScheduleSection(content: string): string | null {
  const lines = content.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => /^##\s+Curation Schedule\s*$/i.test(line.trim()));
  if (startIndex === -1) return null;

  const sectionLines: string[] = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^##\s+/.test(line.trim())) {
      break;
    }
    sectionLines.push(line);
  }

  return sectionLines.join('\n');
}

function readNamedValue(section: string, label: 'Minimum interval' | 'Maximum interval'): string | null {
  const pattern = new RegExp(`(?:^|\\n)\\s*(?:[-*]\\s*)?${label}\\s*:\\s*([^\\n]+)`, 'i');
  const match = section.match(pattern);
  return match ? match[1].trim() : null;
}

export function parseCurationSchedule(content: string): CurationScheduleConfig {
  const usageLevelDefaults = getUsageLevelScheduleDefaults(content);
  const section = extractCurationScheduleSection(content);
  if (!section) {
    return { ...usageLevelDefaults };
  }

  const minIntervalMinutes = parseIntervalMinutes(readNamedValue(section, 'Minimum interval') ?? '')
    ?? usageLevelDefaults.minIntervalMinutes;
  const parsedMaxIntervalMinutes = parseIntervalMinutes(readNamedValue(section, 'Maximum interval') ?? '')
    ?? usageLevelDefaults.maxIntervalMinutes;

  return {
    minIntervalMinutes,
    maxIntervalMinutes: Math.max(minIntervalMinutes, parsedMaxIntervalMinutes),
  };
}

export function parseHeartbeatConfig(content: string): HeartbeatConfig {
  const schedule = parseCurationSchedule(content);
  return {
    ...schedule,
    automaticCurationEnabled: parseAutomaticCurationEnabled(content),
  };
}

export function readHeartbeatConfig(configPath = getDataPath('config.md')): HeartbeatConfig {
  try {
    const content = fs.readFileSync(configPath, 'utf8');
    return parseHeartbeatConfig(content);
  } catch {
    const defaults = getUsageLevelConfig('medium');
    return {
      automaticCurationEnabled: DEFAULT_AUTOMATIC_CURATION_ENABLED,
      minIntervalMinutes: defaults.defaultMinInterval,
      maxIntervalMinutes: defaults.defaultMaxInterval,
    };
  }
}

export function readCurationScheduleConfig(configPath = getDataPath('config.md')): CurationScheduleConfig {
  const { minIntervalMinutes, maxIntervalMinutes } = readHeartbeatConfig(configPath);
  return {
    minIntervalMinutes,
    maxIntervalMinutes,
  };
}

export function readAutomaticCurationConfig(configPath = getDataPath('config.md')): boolean {
  return readHeartbeatConfig(configPath).automaticCurationEnabled;
}
