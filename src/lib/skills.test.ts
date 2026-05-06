import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import {
  getSkillsRegistry,
  installSkill,
  listInstalledSkills,
  listInstalledSkillsWithWarnings,
  parseSkillMarkdown,
} from './skills';

async function preserveSkillDir(skillDir: string): Promise<() => Promise<void>> {
  if (!fs.existsSync(skillDir)) {
    return async () => {
      await fs.promises.rm(skillDir, { recursive: true, force: true });
    };
  }

  const backupRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-skill-test-'));
  const backupDir = path.join(backupRoot, 'backup');
  await fs.promises.cp(skillDir, backupDir, { recursive: true });

  return async () => {
    await fs.promises.rm(skillDir, { recursive: true, force: true });
    await fs.promises.mkdir(path.dirname(skillDir), { recursive: true });
    await fs.promises.cp(backupDir, skillDir, { recursive: true });
    await fs.promises.rm(backupRoot, { recursive: true, force: true });
  };
}

describe('skills helpers', () => {
  test('parseSkillMarkdown parses required frontmatter fields', () => {
    const parsed = parseSkillMarkdown(`---
name: account-mirror
description: Mirror tweets from configured accounts
user-invocable: true
metadata:
  evogent:
    heartbeat-task: true
    requires:
      env:
        - AUTH_TOKEN
        - CT0
---
# Skill Body

Run a sync task.
`);

    assert.strictEqual(parsed.frontmatter.name, 'account-mirror');
    assert.strictEqual(parsed.frontmatter.description, 'Mirror tweets from configured accounts');
    assert.strictEqual(parsed.frontmatter['user-invocable'], true);
    assert.strictEqual(parsed.frontmatter.metadata?.['evogent']?.['heartbeat-task'], true);
    assert.deepStrictEqual(parsed.frontmatter.metadata?.['evogent']?.requires?.env, ['AUTH_TOKEN', 'CT0']);
    assert.ok(parsed.body.includes('Run a sync task'));
  });

  test('parseSkillMarkdown extracts heartbeat-task flag from nested metadata', () => {
    const parsed = parseSkillMarkdown(`---
name: heartbeat-helper
description: Runs during heartbeat cycles
metadata:
  evogent:
    heartbeat-task: true
---
Do heartbeat work.
`);

    assert.strictEqual(parsed.frontmatter.metadata?.['evogent']?.['heartbeat-task'], true);
  });

  test('parseSkillMarkdown extracts feed-source metadata from nested evogent frontmatter', () => {
    const parsed = parseSkillMarkdown(`---
name: source-cache
description: Exposes a dynamic source filter
metadata:
  evogent:
    feed-source: youtube
    feed-source-label: YouTube
---
Source cache body.
`);

    assert.strictEqual(parsed.frontmatter.metadata?.['evogent']?.['feed-source'], 'youtube');
    assert.strictEqual(parsed.frontmatter.metadata?.['evogent']?.['feed-source-label'], 'YouTube');
  });

  test('listInstalledSkills migrates legacy media-agent metadata to evogent', async () => {
    const originalSkillsDir = process.env.MEDIA_AGENT_SKILLS_DIR;
    const skillsRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-legacy-skill-test-'));
    const skillDir = path.join(skillsRoot, 'tweet-cache');

    process.env.MEDIA_AGENT_SKILLS_DIR = skillsRoot;

    try {
      await fs.promises.mkdir(skillDir, { recursive: true });
      await fs.promises.writeFile(path.join(skillDir, 'SKILL.md'), `---
name: tweet-cache
description: Direct-browse X/Twitter source guidance
user-invocable: true
metadata:
  media-agent:
    heartbeat-task: false
    feed-source: twitter
    feed-source-label: Twitter
---
Legacy source cache body.
`, 'utf8');

      const result = await listInstalledSkillsWithWarnings();
      const skill = result.items.find((item) => item.slug === 'tweet-cache');

      assert.deepStrictEqual(result.skipped, []);
      assert.ok(skill);
      assert.strictEqual(skill.metadata['evogent']?.['heartbeat-task'], false);
      assert.strictEqual(skill.metadata['evogent']?.['feed-source'], 'twitter');
      assert.strictEqual(skill.metadata['evogent']?.['feed-source-label'], 'Twitter');
      assert.strictEqual(Object.prototype.hasOwnProperty.call(skill.metadata, 'media-agent'), false);
    } finally {
      if (originalSkillsDir === undefined) {
        delete process.env.MEDIA_AGENT_SKILLS_DIR;
      } else {
        process.env.MEDIA_AGENT_SKILLS_DIR = originalSkillsDir;
      }
      await fs.promises.rm(skillsRoot, { recursive: true, force: true });
    }
  });

  test('parseSkillMarkdown rejects missing description', () => {
    assert.throws(() => {
      parseSkillMarkdown(`---
name: invalid-skill
---
body
`);
    });
  });

  test('parseSkillMarkdown throws on missing name', () => {
    assert.throws(() => {
      parseSkillMarkdown(`---
description: Missing name
---
body
`);
    }, /name/i);
  });

  test('listInstalledSkills includes setup-wizard among installed skills', async () => {
    const skills = await listInstalledSkills();
    assert.ok(skills.length >= 1);
    assert.ok(skills.some((skill) => skill.name === 'setup-wizard'));
  });

  test('listInstalledSkills marks all installed skills as active', async () => {
    const skills = await listInstalledSkills();
    assert.ok(skills.length > 0);
    assert.ok(skills.every((skill) => skill.active === true));
  });

  test('listInstalledSkills marks setup-wizard as having no scripts', async () => {
    const skills = await listInstalledSkills();
    const setupWizard = skills.find((skill) => skill.name === 'setup-wizard');

    assert.ok(setupWizard);
    assert.strictEqual(setupWizard?.hasScripts, false);
  });

  test('listInstalledSkills skips malformed installed skills without hiding valid installed skills', async () => {
    const skillDir = path.join(process.cwd(), '.claude', 'skills', 'malformed-source-filter-test');
    await fs.promises.mkdir(skillDir, { recursive: true });
    await fs.promises.writeFile(path.join(skillDir, 'SKILL.md'), '# Missing frontmatter\n', 'utf8');

    try {
      const result = await listInstalledSkillsWithWarnings();
      const installedNames = result.items.map((skill) => skill.name);

      assert.ok(result.skipped.some((skill) => skill.slug === 'malformed-source-filter-test'));
      assert.ok(installedNames.includes('setup-wizard'));
    } finally {
      await fs.promises.rm(skillDir, { recursive: true, force: true });
    }
  });

  test('getSkillsRegistry returns 10 entries', () => {
    const registry = getSkillsRegistry();
    const names = registry.map((entry) => entry.name).sort();

    assert.strictEqual(registry.length, 10);
    assert.deepStrictEqual(names, ['account-mirror', 'archive-import', 'current-event-tracker', 'full-text', 'hackernews-cache', 'setup-wizard', 'substack-cache', 'tweet-cache', 'tweet-cache-bird', 'youtube-cache']);
    assert.ok(registry.every((entry) => typeof entry.installed === 'boolean'));
  });

  test('getSkillsRegistry marks setup-wizard as installed and others as not installed', () => {
    const registry = getSkillsRegistry(new Set(['setup-wizard']));
    const setupWizard = registry.find((entry) => entry.name === 'setup-wizard');
    const others = registry.filter((entry) => entry.name !== 'setup-wizard');

    assert.ok(setupWizard);
    assert.strictEqual(setupWizard?.installed, true);
    assert.ok(others.every((entry) => entry.installed === false));
  });

  test('installSkill installs from registry', async () => {
    const skillDir = path.join(process.cwd(), '.claude', 'skills', 'full-text');
    const restoreSkillDir = await preserveSkillDir(skillDir);

    try {
      const result = await installSkill({ registry: 'full-text' });

      assert.strictEqual(result.source.type, 'registry');
      assert.strictEqual(result.source.value, 'full-text');
      assert.strictEqual(result.skill.name, 'full-text');
      assert.strictEqual(result.skill.active, true);
    } finally {
      await restoreSkillDir();
    }
  });

  test('installSkill from registry copies scripts directory when present', async () => {
    const skillDir = path.join(process.cwd(), '.claude', 'skills', 'account-mirror');
    const scriptPath = path.join(skillDir, 'scripts', 'sync.sh');
    const restoreSkillDir = await preserveSkillDir(skillDir);

    try {
      const result = await installSkill({ registry: 'account-mirror' });

      assert.strictEqual(result.source.type, 'registry');
      assert.strictEqual(result.source.value, 'account-mirror');
      assert.strictEqual(result.skill.name, 'account-mirror');

      const stat = await fs.promises.stat(scriptPath);
      assert.ok(stat.isFile());
      assert.ok((stat.mode & 0o111) !== 0);
    } finally {
      await restoreSkillDir();
    }
  });

  test('installSkill rejects URL-based installs', async () => {
    await assert.rejects(
      installSkill({ url: 'https://example.com/SKILL.md' }),
      /URL-based skill installation is disabled for security/i
    );
  });

  test('installSkill installs current-event-tracker from registry', async () => {
    const skillDir = path.join(process.cwd(), '.claude', 'skills', 'current-event-tracker');
    const restoreSkillDir = await preserveSkillDir(skillDir);

    try {
      const result = await installSkill({ registry: 'current-event-tracker' });

      assert.strictEqual(result.source.type, 'registry');
      assert.strictEqual(result.source.value, 'current-event-tracker');
      assert.strictEqual(result.skill.slug, 'current-event-tracker');
      assert.strictEqual(result.skill.name, 'current-event-tracker');
      assert.strictEqual(result.skill.userInvocable, true);
      assert.strictEqual(result.skill.metadata?.['evogent']?.['heartbeat-task'], false);
    } finally {
      await restoreSkillDir();
    }
  });

  test('installSkill installs tweet-cache from registry', async () => {
    const skillDir = path.join(process.cwd(), '.claude', 'skills', 'tweet-cache');
    const restoreSkillDir = await preserveSkillDir(skillDir);

    try {
      const result = await installSkill({ registry: 'tweet-cache' });

      assert.strictEqual(result.source.type, 'registry');
      assert.strictEqual(result.source.value, 'tweet-cache');
      assert.strictEqual(result.skill.slug, 'tweet-cache');
      assert.strictEqual(result.skill.name, 'tweet-cache');
      assert.strictEqual(result.skill.userInvocable, true);
      assert.deepStrictEqual(result.skill.metadata?.['evogent']?.requires?.env, undefined);
    } finally {
      await restoreSkillDir();
    }
  });

  test('installSkill rejects tweet-cache-bird without explicit opt-in', async () => {
    await assert.rejects(
      installSkill({ registry: 'tweet-cache-bird' }),
      /requires explicit user opt-in/i
    );
  });

  test('installSkill installs tweet-cache-bird from registry with explicit opt-in', async () => {
    const skillDir = path.join(process.cwd(), '.claude', 'skills', 'tweet-cache-bird');
    const restoreSkillDir = await preserveSkillDir(skillDir);

    try {
      const result = await installSkill({ registry: 'tweet-cache-bird', confirmExplicit: true });

      assert.strictEqual(result.source.type, 'registry');
      assert.strictEqual(result.source.value, 'tweet-cache-bird');
      assert.strictEqual(result.skill.slug, 'tweet-cache-bird');
      assert.strictEqual(result.skill.name, 'tweet-cache-bird');
      assert.strictEqual(result.skill.userInvocable, true);
      assert.strictEqual(result.skill.metadata?.['evogent']?.installRequiresExplicitOptIn, true);
      assert.deepStrictEqual(result.skill.metadata?.['evogent']?.requires?.env, ['AUTH_TOKEN', 'CT0']);
    } finally {
      await restoreSkillDir();
    }
  });

  test('installSkill installs youtube-cache from registry', async () => {
    const skillDir = path.join(process.cwd(), '.claude', 'skills', 'youtube-cache');
    const restoreSkillDir = await preserveSkillDir(skillDir);

    try {
      const result = await installSkill({ registry: 'youtube-cache' });

      assert.strictEqual(result.source.type, 'registry');
      assert.strictEqual(result.source.value, 'youtube-cache');
      assert.strictEqual(result.skill.slug, 'youtube-cache');
      assert.strictEqual(result.skill.name, 'youtube-cache');
      assert.strictEqual(result.skill.userInvocable, true);
      assert.strictEqual(result.skill.metadata?.['evogent']?.['heartbeat-task'], false);
    } finally {
      await restoreSkillDir();
    }
  });

  test('installSkill installs substack-cache from registry', async () => {
    const skillDir = path.join(process.cwd(), '.claude', 'skills', 'substack-cache');
    const restoreSkillDir = await preserveSkillDir(skillDir);

    try {
      const result = await installSkill({ registry: 'substack-cache' });

      assert.strictEqual(result.source.type, 'registry');
      assert.strictEqual(result.source.value, 'substack-cache');
      assert.strictEqual(result.skill.slug, 'substack-cache');
      assert.strictEqual(result.skill.name, 'substack-cache');
      assert.strictEqual(result.skill.userInvocable, true);
      assert.strictEqual(result.skill.metadata?.['evogent']?.['heartbeat-task'], false);
    } finally {
      await restoreSkillDir();
    }
  });

  test('installSkill installs hackernews-cache from registry', async () => {
    const skillDir = path.join(process.cwd(), '.claude', 'skills', 'hackernews-cache');
    const restoreSkillDir = await preserveSkillDir(skillDir);

    try {
      const result = await installSkill({ registry: 'hackernews-cache' });

      assert.strictEqual(result.source.type, 'registry');
      assert.strictEqual(result.source.value, 'hackernews-cache');
      assert.strictEqual(result.skill.slug, 'hackernews-cache');
      assert.strictEqual(result.skill.name, 'hackernews-cache');
      assert.strictEqual(result.skill.userInvocable, true);
      assert.strictEqual(result.skill.metadata?.['evogent']?.['heartbeat-task'], false);
    } finally {
      await restoreSkillDir();
    }
  });
});
