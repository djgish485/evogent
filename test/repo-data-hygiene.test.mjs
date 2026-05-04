import assert from 'node:assert';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { ESLint } from 'eslint';

const require = createRequire(import.meta.url);
const {
  getGitCredentialEnv,
  getGitCredentialEnvForLaunch,
} = require('../lib/git-credential-env.js');

const allowedDataFiles = new Set([
  'data/agent-logs/.gitkeep',
  'data/curation-prompt.default.md',
  'data/hackernews-cache-policy.json',
  'data/substack-cache-policy.json',
  'data/tmp/.gitkeep',
  'data/tweet-cache-policy.json',
  'data/youtube-cache-policy.json',
]);

const generatedDataPathPatterns = [
  /^data\/task-logs\//,
  /^data\/backups\//,
  /^data\/(?:.*\.)?evogent\.db(?:$|[.-])/,
  /^data\/.*\.db(?:$|[.-])/,
  /^data\/.*\.db-.*/,
  /^data\/.*\.sqlite(?:$|[.-])/,
  /^data\/.*\.sqlite3(?:$|[.-])/,
  /^data\/push-notifications\.json$/,
  /^data\/restart-state\.json$/,
  /^data\/pending-restart\.json$/,
  /^data\/orchestrator-chat-session\.json$/,
  /^data\/agent-receipts\.jsonl$/,
  /^data\/\.chat-task-suggestion\.json$/,
  /^data\/chat-output.*\.jsonl$/,
  /^data\/chat-output-append\.tmp$/,
  /^data\/feed-output.*\.jsonl$/,
  /^data\/curation-candidates\.jsonl$/,
  /^data\/cache-hints\.json$/,
  /^data\/config\.md$/,
  /^data\/curation-prompt\.md$/,
  /^data\/preference-insights\.md$/,
  /^data\/preferences-context\.md$/,
  /^data\/tracked-events\.json$/,
  /^data\/user-techniques\.md$/,
  /^data\/tmp\/(?!\.gitkeep$).+/,
];

function gitLsFiles() {
  return execFileSync('git', ['ls-files'], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

test('repository does not track generated data artifacts', () => {
  const tracked = gitLsFiles();
  const trackedData = tracked.filter((file) => file.startsWith('data/'));
  const unexpectedData = trackedData.filter((file) => !allowedDataFiles.has(file));
  const generatedArtifacts = trackedData.filter((file) =>
    generatedDataPathPatterns.some((pattern) => pattern.test(file)),
  );

  assert.deepStrictEqual(unexpectedData, [], 'Only safe data templates and policy files should be tracked');
  assert.deepStrictEqual(generatedArtifacts, [], 'Generated runtime data must not be tracked');
});

test('tweet cache policy and skill require visible parent capture and URL-matched main tweets', () => {
  const policy = JSON.parse(fs.readFileSync('data/tweet-cache-policy.json', 'utf8'));
  const commonPrompt = policy.browserPrompt.common.join('\n');
  const registrySkill = fs.readFileSync('skills-library/tweet-cache/SKILL.md', 'utf8');
  const installedSkillPath = '.claude/skills/tweet-cache/SKILL.md';
  const installedSkill = fs.existsSync(installedSkillPath)
    ? fs.readFileSync(installedSkillPath, 'utf8')
    : null;
  const expectedMainTweetBlock = [
    'MAIN-TWEET IDENTIFICATION:',
    '1. On x.com/<user>/status/<sourceId> pages, articles[0] is often the parent tweet, not the main tweet. Never use array index alone to identify the main article.',
    '2. Identify the main article as the article whose self-link href matches the current page URL: it contains an a[href] ending with /status/<sourceId> for the current item sourceId. Equivalent: the only article whose own permalink anchor points to its own /status/<id>.',
    '3. Articles before the matched main article are upstream context. Persist the article immediately preceding main as relationship="parent"; persist older ancestors as relationship="thread", oldest first. Articles after the matched main article are reply candidates, so any reply picker must use articles after the matched main index.',
    '4. PATCH text, media_urls, metrics, and linkCard for the main feed row only from the matched main article, never from articles[0] blindly.',
    '5. Before PATCHing text, compare the curator-submitted feed-row text with the freshly extracted candidate text. If they are plainly about different topics, different framings, or different tweet authors, STOP, re-check the URL match, and do not PATCH. Use agent judgment, not a JS text comparator.',
    '6. Do not PATCH text merely because a candidate is longer. Text replacement requires the URL-matched main article plus the sanity judgment above.',
  ].join('\n');

  for (const content of [commonPrompt, registrySkill, installedSkill].filter(Boolean)) {
    assert.match(content, /visible parent tweet above a reply card|visible-parent layout/);
    assert.match(content, /separate cache item with its own authorUsername, authorDisplayName, text, authorAvatarUrl, and media/);
    assert.match(content, /Do not only store the reply's inReplyToStatusId|above a reply card as its own complete article/);
    assert.ok(content.includes(expectedMainTweetBlock), 'main tweet identification block should be mirrored exactly');
    assert.doesNotMatch(content, /full\.length\s*>\s*current\.text\.length\s*\+\s*20/);
  }
});

test('repository does not track live ntfy push notification config', () => {
  const tracked = gitLsFiles();
  const trackedPushConfigs = tracked.filter((file) => file === 'data/push-notifications.json');
  const trackedDataWithLiveNtfy = tracked
    .filter((file) => file.startsWith('data/') && fs.existsSync(file) && fs.statSync(file).isFile())
    .filter((file) => {
      const content = fs.readFileSync(file, 'utf8');
      return /"provider"\s*:\s*"ntfy"/.test(content)
        || /"chat_reply"\s*:\s*\{[\s\S]*?"enabled"\s*:\s*true/.test(content);
    });

  assert.deepStrictEqual(trackedPushConfigs, [], 'data/push-notifications.json must be local-only');
  assert.deepStrictEqual(trackedDataWithLiveNtfy, [], 'Tracked data files must not contain live ntfy settings');
});

test('lint ignores runtime scratch data while still checking source files', async () => {
  const eslint = new ESLint({ cwd: process.cwd() });

  assert.strictEqual(
    await eslint.isPathIgnored('data/tmp/cache-refresh-twitter-run.ts'),
    true,
    'Runtime scratch files under data/tmp must not affect lint validation',
  );
  assert.strictEqual(
    await eslint.isPathIgnored('src/__lint-fixture.ts'),
    false,
    'Tracked source paths must remain linted',
  );

  const [result] = await eslint.lintText('export const lintFixture = (value: any) => value;\n', {
    filePath: 'src/__lint-fixture.ts',
  });
  assert.ok(
    result.messages.some((message) => message.ruleId === '@typescript-eslint/no-explicit-any'),
    'A TypeScript lint error in source should still be reported',
  );
});

test('git credential env is noninteractive and does not depend on inherited HOME', () => {
  const env = getGitCredentialEnv({});

  assert.ok(env.HOME, 'service git environment should provide HOME');
  assert.strictEqual(env.XDG_CONFIG_HOME, `${env.HOME}/.config`);
  assert.strictEqual(env.GH_CONFIG_DIR, `${env.HOME}/.config/gh`);
  assert.strictEqual(env.GIT_TERMINAL_PROMPT, '0');

  const launchEnv = getGitCredentialEnvForLaunch({}, { MEDIA_AGENT_SPAWN_DEPTH: '1' });
  assert.strictEqual(launchEnv.MEDIA_AGENT_SPAWN_DEPTH, '1');
  assert.ok(launchEnv.HOME, 'runner launch environment should provide HOME');
  assert.strictEqual(launchEnv.GIT_TERMINAL_PROMPT, '0');
});

test('systemd service templates provide git credential environment', () => {
  for (const servicePath of ['scripts/evogent.service', 'scripts/evogent-worker.service']) {
    const content = fs.readFileSync(servicePath, 'utf8');

    assert.match(content, /^Environment=HOME=\/root$/m, `${servicePath} should set HOME`);
    assert.match(content, /^Environment=XDG_CONFIG_HOME=\/root\/\.config$/m, `${servicePath} should set XDG_CONFIG_HOME`);
    assert.match(content, /^Environment=GH_CONFIG_DIR=\/root\/\.config\/gh$/m, `${servicePath} should set GH_CONFIG_DIR`);
    assert.match(content, /^Environment=GIT_TERMINAL_PROMPT=0$/m, `${servicePath} should disable git prompts`);
  }
});
