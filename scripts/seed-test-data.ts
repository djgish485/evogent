import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { getDb } from '../src/lib/db/client';
import { insertOrIgnoreFeedItem, type FeedInsertInput } from '../src/lib/db/feed';

const RECENT_RESOLVED_SUGGESTION_COUNT = 10;
const PENDING_SUGGESTION_COUNT = 3;

function createSuggestionSeedItem(
  referenceTime: number,
  index: number,
  status: 'pending' | 'accepted' | 'merged',
  title: string,
  text: string,
  configField: string,
  configFile: 'data/config.md' | 'data/curation-prompt.md',
  proposedValue: string,
): FeedInsertInput {
  return {
    id: randomUUID(),
    type: 'suggestion',
    source: 'claude',
    sourceId: `seed-suggestion-${status}-${index}-${randomUUID()}`,
    title,
    text,
    reason: 'Seed suggestion for recent-history grouping and batch-action verification.',
    tags: ['suggestion', 'seed', status],
    mediaUrls: [],
    metadata: {
      suggestionType: 'config_change',
      suggestionStatus: status,
      configField,
      configFile,
      proposedValue,
    },
    publishedAt: new Date(referenceTime - (40 - index) * 60 * 1000).toISOString(),
  };
}

export function buildSeedFeedItems(referenceTime = Date.now()): FeedInsertInput[] {
  const sampleItems: FeedInsertInput[] = [
    {
      id: randomUUID(),
      type: 'tweet',
      source: 'twitter',
      sourceId: '1001',
      text: 'NVIDIA just announced a compact open model optimized for local inference on consumer GPUs.',
      url: 'https://x.com/example/status/1001',
      authorUsername: 'chipwatcher',
      authorDisplayName: 'Chip Watcher',
      reason: 'High relevance to AI tooling and inference trends.',
      tags: ['ai', 'hardware'],
      mediaUrls: [],
      publishedAt: new Date(referenceTime - 8 * 60 * 1000).toISOString(),
    },
    {
      id: randomUUID(),
      type: 'article',
      source: 'bbc',
      sourceId: 'https://bbc.com/news/ai-data-center-water',
      title: 'Data centers and water usage: what changed in 2026',
      text: 'A deep dive into how cooling infrastructure changed after new environmental constraints.',
      excerpt: 'Cooling infrastructure changes are starting to reduce consumption in high-load zones.',
      url: 'https://bbc.com/news/ai-data-center-water',
      reason: 'Policy plus infrastructure impact on AI scaling.',
      tags: ['infrastructure', 'policy'],
      mediaUrls: [],
      publishedAt: new Date(referenceTime - 65 * 60 * 1000).toISOString(),
    },
    {
      id: randomUUID(),
      type: 'article',
      source: 'internal',
      sourceId: 'analysis-1',
      title: 'Why small model routing keeps winning',
      text: `Small model routing wins because the latency floor keeps shrinking while quality loss stays bounded for classification and extraction tasks.

For broad agents, the right tradeoff is: default to fast model, escalate to stronger model only on uncertainty signals.

This creates a compounding effect on cost and UX.`,
      reason: 'Summarizes repeated feed pattern across sources.',
      tags: ['analysis', 'models'],
      mediaUrls: [],
      publishedAt: new Date(referenceTime - 2 * 60 * 60 * 1000).toISOString(),
    },
  ];

  for (let index = 0; index < 17; index += 1) {
    const type = index % 2 === 0 ? 'tweet' : 'article';

    sampleItems.push({
      id: randomUUID(),
      type,
      source: type === 'tweet' ? 'twitter' : 'aljazeera',
      sourceId: `seed-${type}-${index}`,
      title: type === 'article' ? `Sample article ${index + 1}` : null,
      text: `Sample ${type} item ${index + 1} for feed testing and infinite scroll behavior.`,
      excerpt: type === 'article' ? 'Short excerpt for visual testing in card layout.' : null,
      url: type === 'tweet' ? `https://x.com/example/status/${1100 + index}` : `https://example.com/article/${index}`,
      authorUsername: type === 'tweet' ? `user${index}` : null,
      authorDisplayName: type === 'tweet' ? `User ${index}` : null,
      reason: 'Seed data for local verification.',
      tags: [type, 'seed'],
      mediaUrls: [],
      publishedAt: new Date(referenceTime - (index + 3) * 3_600_000).toISOString(),
    });
  }

  const resolvedSuggestionConfigs = [
    ['analysis style', 'data/curation-prompt.md', 'Emphasize concise analysis and direct tradeoff framing.'],
    ['interests', 'data/curation-prompt.md', 'Prioritize AI infrastructure, local inference, and developer tooling.'],
    ['tweet selection', 'data/curation-prompt.md', 'Prefer posts with concrete product, benchmark, or policy details.'],
    ['content to avoid', 'data/curation-prompt.md', 'Reduce repetitive fundraising threads without new technical substance.'],
    ['usage level', 'data/config.md', 'Medium'],
    ['agent name', 'data/config.md', 'Evogent'],
    ['schedule', 'data/config.md', 'Prefer denser curation around active local morning and evening windows.'],
    ['search strategies', 'data/curation-prompt.md', 'Add more cross-checking across direct sources before analysis.'],
    ['engaged accounts', 'data/curation-prompt.md', 'Increase weight on chip tooling, inference, and systems accounts.'],
    ['topics', 'data/curation-prompt.md', 'Keep policy stories only when they materially affect model deployment.'],
  ] as const;

  resolvedSuggestionConfigs.forEach(([configField, configFile, proposedValue], index) => {
    const status = index % 2 === 0 ? 'merged' : 'accepted';
    sampleItems.push(createSuggestionSeedItem(
      referenceTime,
      index,
      status,
      `Resolved suggestion ${index + 1}`,
      `Recent resolved suggestion ${index + 1} keeps the grouped card populated with bounded history for verification.`,
      configField,
      configFile,
      proposedValue,
    ));
  });

  const pendingSuggestionConfigs = [
    ['interests', 'data/curation-prompt.md', 'Raise the weight of AI chips, local inference, and developer ergonomics.'],
    ['analysis style', 'data/curation-prompt.md', 'Prefer shorter synthesis with explicit tradeoffs and implications.'],
    ['schedule', 'data/config.md', 'Slow curation slightly overnight and bias toward active hours.'],
  ] as const;

  pendingSuggestionConfigs.forEach(([configField, configFile, proposedValue], index) => {
    sampleItems.push(createSuggestionSeedItem(
      referenceTime,
      RECENT_RESOLVED_SUGGESTION_COUNT + index,
      'pending',
      `Pending suggestion ${index + 1}`,
      `Pending suggestion ${index + 1} is ready for Accept All and Dismiss All verification in the suggestion group UI.`,
      configField,
      configFile,
      proposedValue,
    ));
  });

  return sampleItems;
}

export function seedTestData(referenceTime = Date.now()): number {
  const db = getDb();
  const sampleItems = buildSeedFeedItems(referenceTime);

  db.exec('DELETE FROM feed');

  let inserted = 0;
  for (const item of sampleItems) {
    if (insertOrIgnoreFeedItem(item)) inserted += 1;
  }

  return inserted;
}

function main() {
  const inserted = seedTestData();
  console.log(
    `Seeded ${inserted} feed items including ${PENDING_SUGGESTION_COUNT} pending suggestions and ${RECENT_RESOLVED_SUGGESTION_COUNT} recent resolved suggestions.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
