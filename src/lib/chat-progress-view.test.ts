import assert from 'node:assert';
import { describe, test } from 'node:test';
import {
  CHAT_AUTO_SCROLL_THRESHOLD_PX,
  isScrollNearBottom,
} from './chat-progress-view';

describe('chat progress view helpers', () => {
  test('treats the bottom threshold as sticky within 50px', () => {
    assert.strictEqual(isScrollNearBottom({
      scrollHeight: 1000,
      scrollTop: 370,
      clientHeight: 580,
    }), true);

    assert.strictEqual(isScrollNearBottom({
      scrollHeight: 1000,
      scrollTop: 360,
      clientHeight: 580,
    }), false);

    assert.strictEqual(CHAT_AUTO_SCROLL_THRESHOLD_PX, 50);
  });
});
