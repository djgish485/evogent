import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getDurableChatRequestMetadata,
  getFreshChatSessionTitle,
  SCREEN_CHAT_SESSION_TITLE,
} from '@/lib/screen-chat-privacy';

test('screen chat keeps only the fixed overlay routing bit and uses a generic durable title', () => {
  const packageName = 'com.private.example.reader';
  const metadataCanary = 'PRIVATE_SCREEN_METADATA_CANARY_6118';

  const durableMetadata = getDurableChatRequestMetadata('screen', {
    overlay: true,
    screenApp: packageName,
    arbitrary: metadataCanary,
    nested: { value: metadataCanary },
  });
  const title = getFreshChatSessionTitle('screen');

  assert.deepStrictEqual(durableMetadata, { overlay: true });
  assert.strictEqual(title, SCREEN_CHAT_SESSION_TITLE);
  assert.doesNotMatch(JSON.stringify({ durableMetadata, title }), new RegExp(`${packageName}|${metadataCanary}`));
});

test('ordinary chat metadata and default title behavior remain unchanged', () => {
  const metadata = { trigger: 'phone_scheduler', curationCycleId: 'cycle-safe-1234' };

  assert.strictEqual(getDurableChatRequestMetadata('global', metadata), metadata);
  assert.strictEqual(getFreshChatSessionTitle('global'), null);
  assert.strictEqual(getFreshChatSessionTitle('post'), null);
});
