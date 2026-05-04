import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  getStrongestFeedProminence,
  normalizeFeedProminence,
  validateFeedProminenceInput,
} from './feed-prominence';

describe('feed prominence metadata', () => {
  test('normalizes a supported prominence signal', () => {
    assert.deepEqual(normalizeFeedProminence({
      level: 'Lead',
      label: 'Lead story',
      source: 'homepage',
      evidence: 'Top headline on the source homepage',
      homepageUrl: 'https://example.com/',
    }), {
      level: 'lead',
      label: 'Lead story',
      source: 'homepage',
      evidence: 'Top headline on the source homepage',
      homepageUrl: 'https://example.com/',
    });
  });

  test('rejects unsupported prominence levels', () => {
    assert.equal(
      validateFeedProminenceInput({ level: 'homepage-ish' }),
      'metadata.prominence.level must be one of: prominent, lead',
    );
  });

  test('uses custom validation paths for nested prominence metadata', () => {
    assert.equal(
      validateFeedProminenceInput({ level: 'homepage-ish' }, 'metadata.thread.prominence'),
      'metadata.thread.prominence.level must be one of: prominent, lead',
    );
  });

  test('requires homepage source when requested', () => {
    assert.equal(
      validateFeedProminenceInput(
        { level: 'lead', source: 'front-page' },
        'metadata.thread.prominence',
        { requiredSource: 'homepage' },
      ),
      'metadata.thread.prominence.source must be "homepage"',
    );
  });

  test('selects lead as the strongest prominence signal', () => {
    assert.deepEqual(getStrongestFeedProminence([
      { level: 'prominent', source: 'homepage' },
      null,
      { level: 'lead', source: 'homepage', evidence: 'Top story' },
    ]), {
      level: 'lead',
      source: 'homepage',
      evidence: 'Top story',
    });
  });
});
