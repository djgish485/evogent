import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import {
  getActionsForSkill,
  getSkillAction,
  invalidateSkillActionRegistryForTests,
} from './skill-action-registry';

const originalSkillsDir = process.env.MEDIA_AGENT_SKILLS_DIR;

async function writeSkill(skillsRoot: string, slug: string, markdown: string) {
  const skillDir = path.join(skillsRoot, slug);
  await fs.promises.mkdir(skillDir, { recursive: true });
  await fs.promises.writeFile(path.join(skillDir, 'SKILL.md'), markdown, 'utf8');
}

describe('skill action registry', () => {
  afterEach(() => {
    if (originalSkillsDir === undefined) {
      delete process.env.MEDIA_AGENT_SKILLS_DIR;
    } else {
      process.env.MEDIA_AGENT_SKILLS_DIR = originalSkillsDir;
    }
    invalidateSkillActionRegistryForTests();
  });

  test('loads feed actions from installed SKILL.md frontmatter', async () => {
    const skillsRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-feed-actions-'));
    process.env.MEDIA_AGENT_SKILLS_DIR = skillsRoot;
    invalidateSkillActionRegistryForTests();

    try {
      await writeSkill(skillsRoot, 'email-triage', `---
name: email-triage
description: Triage important inbox updates
metadata:
  evogent:
    feed-actions:
      - id: triage-all
        label: Triage all
        confirms: false
      - id: skip-sender
        label: Skip sender
        confirms: Will skip future emails from this sender?
        requiresSelection: senderDomain
---
# Email Triage
`);

      assert.deepEqual(getActionsForSkill('email-triage'), [
        {
          id: 'triage-all',
          label: 'Triage all',
          confirms: false,
          externalLink: false,
          requiresSelection: null,
        },
        {
          id: 'skip-sender',
          label: 'Skip sender',
          confirms: 'Will skip future emails from this sender?',
          externalLink: false,
          requiresSelection: 'senderDomain',
        },
      ]);

      const action = getSkillAction('email-triage.triage-all');
      assert.equal(action?.skill, 'email-triage');
      assert.equal(action?.action.label, 'Triage all');
      assert.equal(action?.skillPath, path.join(skillsRoot, 'email-triage', 'SKILL.md'));
    } finally {
      await fs.promises.rm(skillsRoot, { recursive: true, force: true });
    }
  });
});
