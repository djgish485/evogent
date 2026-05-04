import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ThreadGroupHeader } from './thread-group-header';

const threadTint = {
  name: 'blue',
  bg: 'rgba(59,130,246,0.08)',
  border: 'rgba(59,130,246,0.45)',
  itemBorder: 'rgba(59,130,246,0.22)',
  swatch: 'rgb(59 130 246)',
  text: '#93c5fd',
};

describe('ThreadGroupHeader', () => {
  test('renders lead thread prominence with stronger title typography', () => {
    const markup = renderToStaticMarkup(createElement(ThreadGroupHeader, {
      threadId: 'thread-1',
      cycleId: 'cycle-1',
      threadTitle: 'Major homepage event',
      threadRationale: null,
      threadProminence: {
        level: 'lead',
        source: 'homepage',
        evidence: 'Largest headline on the homepage.',
      },
      continuing: false,
      threadTint,
      onSubmitFeedback: async () => {},
    }));

    assert.match(markup, /data-prominence="lead"/);
    assert.match(markup, /text-\[22px\] font-semibold leading-tight text-zinc-50 sm:text-\[28px\]/);
    assert.match(markup, /linear-gradient\(to bottom, rgba\(59,130,246,0.08\), transparent\) padding-box/);
    assert.match(markup, /linear-gradient\(to bottom, rgba\(59,130,246,0.45\), transparent\) border-box/);
  });

  test('keeps ordinary thread titles at the normal size', () => {
    const markup = renderToStaticMarkup(createElement(ThreadGroupHeader, {
      threadId: 'thread-1',
      cycleId: 'cycle-1',
      threadTitle: 'Ordinary thread',
      threadRationale: null,
      threadProminence: null,
      continuing: false,
      threadTint,
      onSubmitFeedback: async () => {},
    }));

    assert.doesNotMatch(markup, /data-prominence=/);
    assert.match(markup, /text-base font-semibold text-zinc-100 sm:text-lg/);
    assert.doesNotMatch(markup, /Optional reason/);
    assert.doesNotMatch(markup, /More like this/);
    assert.doesNotMatch(markup, /Tune this lane/);
  });

  test('renders large A/B controls for feedback probe threads', () => {
    const markup = renderToStaticMarkup(createElement(ThreadGroupHeader, {
      threadId: 'thread-1',
      cycleId: 'cycle-1',
      threadTitle: 'Borderline but good thread',
      threadRationale: null,
      threadProminence: null,
      feedbackProbe: {
        reason: 'High quality but uncertain lane fit.',
        uncertainty: 'source fatigue',
        options: {
          moreLabel: 'Keep pushing',
          lessLabel: 'Stop pushing',
        },
      },
      sourceItemIds: ['item-1', 'item-2'],
      continuing: false,
      threadTint,
      onSubmitFeedback: async () => {},
    }));

    assert.match(markup, /Tune this lane/);
    assert.match(markup, /Keep pushing/);
    assert.match(markup, /Stop pushing/);
    assert.match(markup, /min-h-12/);
    assert.doesNotMatch(markup, /Optional reason/);
  });
});
