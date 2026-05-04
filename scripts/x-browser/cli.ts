#!/usr/bin/env tsx
import {
  scrapeHome,
  scrapeRead,
  scrapeReplies,
  scrapeSearch,
  scrapeUserReplies,
  scrapeUserTweets,
  withBrowserSession,
} from './core';

function getFlagValue(flag: string) {
  const index = process.argv.indexOf(flag);
  if (index < 0) {
    return null;
  }

  const value = process.argv[index + 1];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function getCount() {
  const raw = getFlagValue('-n');
  if (!raw) return undefined;

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

async function run() {
  const [, , command, ...args] = process.argv;
  if (!command) {
    throw new Error('x-browser CLI requires a command.');
  }

  const count = getCount();

  const result = await withBrowserSession(async (session) => {
    switch (command) {
      case 'home':
        return scrapeHome({
          count,
          following: args.includes('--following'),
          session,
        });
      case 'user-tweets':
        if (!args[0]) {
          throw new Error('user-tweets requires a handle');
        }
        return scrapeUserTweets({
          count,
          handle: args[0],
          session,
        });
      case 'user-replies':
        if (!args[0]) {
          throw new Error('user-replies requires a handle');
        }
        return scrapeUserReplies({
          count,
          handle: args[0],
          session,
        });
      case 'search':
        if (!args[0]) {
          throw new Error('search requires a query');
        }
        return scrapeSearch({
          count,
          query: args[0],
          session,
        });
      case 'read':
        if (!args[0]) {
          throw new Error('read requires a tweet id or URL');
        }
        return scrapeRead({
          target: args[0],
          session,
        });
      case 'replies':
        if (!args[0]) {
          throw new Error('replies requires a tweet id or URL');
        }
        return scrapeReplies({
          target: args[0],
          count,
          session,
        });
      case 'thread':
        if (!args[0]) {
          throw new Error('thread requires a tweet id or URL');
        }
        return scrapeRead({
          target: args[0],
          session,
        });
      default:
        throw new Error(`Unsupported x-browser command: ${command}`);
    }
  });

  process.stdout.write(JSON.stringify(result));
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
