import fs from 'node:fs';
import { getDataPath } from '@/lib/data-dir';

export type UsageLevel = 'low' | 'medium' | 'high';
export type ReflectionFrequency = 'daily' | 'weekly';

export interface UsageLevelConfig {
  level: UsageLevel;
  subAgentModel: string;
  curatorModel: string;
  enrichmentModel: string;
  reflectionModel: string;
  defaultMinInterval: number;
  defaultMaxInterval: number;
  reflectionFrequency: ReflectionFrequency;
}

const USAGE_LEVEL_DEFAULT: UsageLevel = 'medium';

const USAGE_LEVEL_MAP: Record<UsageLevel, Omit<UsageLevelConfig, 'level'>> = {
  low: {
    subAgentModel: 'claude-opus-4-7',
    curatorModel: 'claude-opus-4-7',
    enrichmentModel: 'claude-opus-4-7',
    reflectionModel: 'claude-opus-4-7',
    defaultMinInterval: 4 * 60,
    defaultMaxInterval: 8 * 60,
    reflectionFrequency: 'weekly',
  },
  medium: {
    subAgentModel: 'claude-opus-4-7',
    curatorModel: 'claude-opus-4-7',
    enrichmentModel: 'claude-opus-4-7',
    reflectionModel: 'claude-opus-4-7',
    defaultMinInterval: 90,
    defaultMaxInterval: 4 * 60,
    reflectionFrequency: 'daily',
  },
  high: {
    subAgentModel: 'opus',
    curatorModel: 'claude-opus-4-7[1m]',
    enrichmentModel: 'opus',
    reflectionModel: 'opus',
    defaultMinInterval: 45,
    defaultMaxInterval: 2 * 60,
    reflectionFrequency: 'daily',
  },
};

function extractUsageLevelSection(content: string): string | null {
  const lines = content.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => /^##\s+Usage Level\s*$/i.test(line.trim()));
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

function normalizeUsageLevel(value: string): UsageLevel | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high') {
    return normalized;
  }
  return null;
}

export function getUsageLevelConfig(level: UsageLevel): UsageLevelConfig {
  return {
    level,
    ...USAGE_LEVEL_MAP[level],
  };
}

export function parseUsageLevel(content: string): UsageLevelConfig {
  const section = extractUsageLevelSection(content);
  const sectionValue = section?.match(/\b(low|medium|high)\b/i)?.[1] ?? '';
  const normalizedLevel = normalizeUsageLevel(sectionValue) ?? USAGE_LEVEL_DEFAULT;
  return getUsageLevelConfig(normalizedLevel);
}

export function readUsageLevelConfig(configPath = getDataPath('config.md')): UsageLevelConfig {
  try {
    const content = fs.readFileSync(configPath, 'utf8');
    return parseUsageLevel(content);
  } catch {
    return getUsageLevelConfig(USAGE_LEVEL_DEFAULT);
  }
}
