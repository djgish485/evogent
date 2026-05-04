import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { buildChatInstruction } from '../src/lib/chat-instruction';
import { listUserFacingCommands } from '../src/lib/commands';
import {
  SETUP_BANNER_DISMISSED_STORAGE_KEY,
  SetupBanner,
} from '../src/components/setup-banner';
import {
  resolveGeneralChatSessionId,
  resolveSetupWizardSessionId,
  resolveSourceHealthSessionId,
  SETUP_WIZARD_COMMAND,
  SETUP_WIZARD_ORIGIN_VIEW,
  SOURCE_HEALTH_ORIGIN_VIEW,
  SOURCE_HEALTH_TRIGGER_SOURCE,
  SOURCE_STATUS_COMMAND,
} from '../src/lib/setup-chat-routing';
import type { ConversationSessionSummary } from '../src/types/conversation';

function session(
  sessionId: string,
  sessionType: ConversationSessionSummary['sessionType'],
  lastMaterialActivityAt = new Date(0).toISOString(),
): ConversationSessionSummary {
  return {
    sessionId,
    provider: 'claude',
    claudeReasoningEffort: 'high',
    codexReasoningEffort: 'high',
    codexFastMode: false,
    latestContextTokens: null,
    latestContextWindow: null,
    latestContextModel: null,
    latestContextUpdatedAt: null,
    title: sessionId,
    color: null,
    sessionType,
    workingDirectory: process.cwd(),
    lastMaterialActivityAt,
    conversationCount: 0,
    messageCount: 0,
    feedItemCount: 0,
    previewText: null,
    previewMessages: [],
    lastActor: null,
    contextKind: 'global',
    contextRefId: null,
  };
}

async function pathExists(relativePath: string): Promise<boolean> {
  try {
    await fs.access(path.join(process.cwd(), relativePath));
    return true;
  } catch {
    return false;
  }
}

test('setup card routing chooses a non-curator session', () => {
  const normalA = session('normal-a', null);
  const normalB = session('normal-b', null);
  const curator = session('curator', 'curator');

  assert.equal(resolveSetupWizardSessionId([curator, normalA, normalB], 'normal-b'), 'normal-b');
  assert.equal(resolveSetupWizardSessionId([curator, normalA, normalB], 'curator'), 'normal-a');
  assert.equal(resolveSetupWizardSessionId([curator], 'curator'), null);
  assert.equal(SETUP_WIZARD_COMMAND, '/setup-wizard');
  assert.equal(SETUP_WIZARD_ORIGIN_VIEW, 'feed/setup_card');
});

test('source health routing chooses selected or latest non-curator session', () => {
  const normalA = session('normal-a', null, '2026-01-01T00:00:00.000Z');
  const normalB = session('normal-b', null, '2026-01-02T00:00:00.000Z');
  const curator = session('curator', 'curator', '2026-01-03T00:00:00.000Z');

  assert.equal(resolveGeneralChatSessionId([curator, normalA, normalB], 'normal-a'), 'normal-a');
  assert.equal(resolveSourceHealthSessionId([curator, normalA, normalB], 'curator'), 'normal-b');
  assert.equal(resolveSourceHealthSessionId([curator], 'curator'), null);
  assert.equal(SOURCE_STATUS_COMMAND, '/source-status');
  assert.equal(SOURCE_HEALTH_ORIGIN_VIEW, 'feed/source_health_button');
  assert.equal(SOURCE_HEALTH_TRIGGER_SOURCE, 'source_health_button');
});

test('setup banner renders without setup status polling or progress copy', async () => {
  const markup = renderToStaticMarkup(React.createElement(SetupBanner, {
    onStartSetup: () => {},
  }));
  const bannerSource = await fs.readFile(path.join(process.cwd(), 'src/components/setup-banner.tsx'), 'utf8');

  assert.match(markup, /data-testid="setup-banner"/);
  assert.match(markup, /Welcome/);
  assert.match(markup, /Add sources for the Curator Agent to work with\./);
  assert.match(markup, /Finish Setup/);
  assert.doesNotMatch(markup, /Continue first-run setup|Continue in chat|>Setup</);
  assert.doesNotMatch(markup, /\d+ of \d+ steps complete|checklist/i);
  assert.doesNotMatch(bannerSource, /\/api\/setup\/status|setup\/status|setInterval|clearInterval|SetupSummary|summary\.complete|summary\.total/);
});

test('setup banner hides when setup readiness has no required blockers', () => {
  const markup = renderToStaticMarkup(React.createElement(SetupBanner, {
    isSetupReady: true,
    onStartSetup: () => {},
  }));

  assert.equal(markup, '');
});

test('setup banner dismissal key is bumped so old test-pass dismissals reset', async () => {
  const bannerSource = await fs.readFile(path.join(process.cwd(), 'src/components/setup-banner.tsx'), 'utf8');

  assert.equal(SETUP_BANNER_DISMISSED_STORAGE_KEY, 'evogent.setup-banner.dismissed.v2');
  assert.doesNotMatch(bannerSource, /evogent\.setup-banner\.dismissed\.v1/);
});

test('setup banner click path submits /setup-wizard and dismisses the banner', async () => {
  const pageSource = await fs.readFile(path.join(process.cwd(), 'src/app/page.tsx'), 'utf8');
  const bannerSource = await fs.readFile(path.join(process.cwd(), 'src/components/setup-banner.tsx'), 'utf8');

  assert.match(bannerSource, /function handleStartSetup\(\) \{[\s\S]*setClickedDismissed\(true\);[\s\S]*writeSetupBannerDismissed\(\);[\s\S]*void onStartSetup\(\);[\s\S]*\}/);
  assert.match(pageSource, /command:\s*SETUP_WIZARD_COMMAND/);
  assert.match(pageSource, /message:\s*command/);
  assert.match(pageSource, /originView:\s*SETUP_WIZARD_ORIGIN_VIEW/);
  assert.match(pageSource, /triggerSource:\s*'setup_card'/);
  assert.match(pageSource, /resolveSetupWizardSessionId/);
  assert.match(pageSource, /\/api\/setup-readiness/);
  assert.match(pageSource, /isSetupReady={isSetupReady}/);
  assert.match(pageSource, /Ready for curation/);
  assert.match(pageSource, /Start a Curator Agent run, or check Source Health/);
});

test('internal orchestrator proxy rejects hidden curate handoff', async () => {
  const routeSource = await fs.readFile(path.join(process.cwd(), 'src/app/api/internal/orchestrator/enqueue/route.ts'), 'utf8');

  assert.match(routeSource, /isHiddenCurateRequest/);
  assert.match(routeSource, /Route curation through Curator Agent chat with POST \/api\/chat/);
  assert.match(routeSource, /normalized === '\/curate'/);
});

test('source health sidebar path submits /source-status to a general session', async () => {
  const pageSource = await fs.readFile(path.join(process.cwd(), 'src/app/page.tsx'), 'utf8');
  const sidebarSource = await fs.readFile(path.join(process.cwd(), 'src/components/chat/chat-control-panels.tsx'), 'utf8');

  assert.match(sidebarSource, /function SidebarAutomationControls/);
  assert.match(sidebarSource, /data-testid="source-health-button"/);
  assert.match(pageSource, /submitSourceHealthFromSidebar/);
  assert.match(pageSource, /resolveSourceHealthSessionId/);
  assert.match(pageSource, /command:\s*SOURCE_STATUS_COMMAND/);
  assert.match(pageSource, /message:\s*command/);
  assert.match(pageSource, /originView:\s*SOURCE_HEALTH_ORIGIN_VIEW/);
  assert.match(pageSource, /triggerSource:\s*SOURCE_HEALTH_TRIGGER_SOURCE/);
  assert.match(pageSource, /sessionType:\s*null/);
  assert.match(pageSource, /openConversationDetail\(data\.sessionId,\s*null,\s*\{[\s\S]*replaceTop:\s*true/);
  assert.match(pageSource, /setIsMobileMenuOpen\(false\)/);
});

test('setup progress APIs and setup_steps product code are removed', async () => {
  const deletedPaths = [
    'src/lib/db/setup.ts',
    'src/app/api/setup/route.ts',
    'src/app/api/setup/status/route.ts',
    'src/app/api/setup/reset/route.ts',
    'src/app/api/setup/[stepKey]/route.ts',
  ];
  for (const deletedPath of deletedPaths) {
    assert.equal(await pathExists(deletedPath), false, deletedPath);
  }

  const schemaSource = await fs.readFile(path.join(process.cwd(), 'src/lib/db/schema.ts'), 'utf8');
  const setupWizardCommand = await fs.readFile(path.join(process.cwd(), '.claude/commands/setup-wizard.md'), 'utf8');

  assert.doesNotMatch(schemaSource, /CREATE TABLE IF NOT EXISTS setup_steps|CREATE INDEX IF NOT EXISTS setup_steps/);
  assert.match(schemaSource, /DROP TABLE IF EXISTS setup_steps/);
  assert.doesNotMatch(setupWizardCommand, /\/api\/setup|PATCH \$API_BASE\/api\/setup/);
});

test('setup card no longer renders the deleted setup panel path', async () => {
  const pageSource = await fs.readFile(path.join(process.cwd(), 'src/app/page.tsx'), 'utf8');
  const bannerSource = await fs.readFile(path.join(process.cwd(), 'src/components/setup-banner.tsx'), 'utf8');

  assert.doesNotMatch(pageSource, /SetupPanel|showSetupPanel|setShowSetupPanel|setup-panel/);
  assert.doesNotMatch(bannerSource, /Open setup|Hide setup|onOpenPanel|onClosePanel/);
  assert.match(pageSource, /SETUP_WIZARD_COMMAND/);
  assert.match(pageSource, /SETUP_WIZARD_ORIGIN_VIEW/);
});

test('current setup docs point users to chat instead of the deleted setup panel', async () => {
  const files = [
    'README.md',
    'docs/setup-for-coding-agents.md',
    'docs/architecture-v2.md',
    'docs/evolving-curation-research.md',
    'skills-library/archive-import/SKILL.md',
    '.claude/commands/setup-wizard.md',
    '.claude/skills/setup-wizard/SKILL.md',
  ];
  const staleUiPattern = /SetupPanel|setup-panel|showSetupPanel|setShowSetupPanel|Open setup|Hide setup|setup panel|setup wizard will guide|wizard will guide/i;

  for (const file of files) {
    const source = await fs.readFile(path.join(process.cwd(), file), 'utf8');
    assert.doesNotMatch(source, staleUiPattern, file);
  }

  const readme = await fs.readFile(path.join(process.cwd(), 'README.md'), 'utf8');
  assert.match(readme, /setup card's \*\*Finish Setup\*\* button/);
  assert.match(readme, /starts `\/setup-wizard` in chat/);
});

test('/setup-wizard guidance keeps optional setup bundled after required choices', async () => {
  const files = [
    '.claude/commands/setup-wizard.md',
    '.claude/skills/setup-wizard/SKILL.md',
  ];
  const requiredPatterns = [
    /Optional agent name and manual Interests/i,
    /gitignored personal runtime config/i,
    /explicit concrete setup value/i,
    /Agent Name.*Bob/i,
    /default `Evogent`|default Evogent/i,
    /manual Interests.*optional backup|Manual Interests are optional backup/i,
    /interest inference.*ready/i,
    /Source evidence/i,
    /Preference evidence/i,
    /Curation evidence/i,
    /archive signals|imported archive/i,
    /app feedback/i,
    /true cold start|cold-start fallback/i,
    /no usable source\/preference evidence|no usable source, preference/i,
    /Optional Twitter\/X archive request/i,
    /Import Twitter\/X archive/i,
    /Brain configuration/i,
    /Codex Reasoning Effort/i,
    /Usage Level/i,
    /Source skills and source health/i,
    /setup-source.*smoke/i,
    /earliest missing required item.*Brain Provider.*Usage Level.*source/i,
    /combined optional (etc )?question/i,
    /skip-all/i,
    /do not ask.*agent name.*manual interests.*archive.*separate/i,
    /First curation/i,
    /curation_log/i,
    /feed-output\.jsonl/i,
  ];

  for (const file of files) {
    const source = await fs.readFile(path.join(process.cwd(), file), 'utf8');
    for (const pattern of requiredPatterns) {
      assert.match(source, pattern, `${file} should include ${pattern}`);
    }
    assert.doesNotMatch(source, /\/api\/setup|setup_steps|progress counts/i);
    assert.doesNotMatch(source, /any empty or placeholder Interests section as `missing`/i);
    assert.doesNotMatch(source, /Interests` is missing when absent, empty, or placeholder-like/i);
    assert.doesNotMatch(source, /Start with Agent Name and Interests whenever/i);
    assert.doesNotMatch(source, /ask what the agent should be called before other prompts/i);
    assert.doesNotMatch(source, /If interests are missing, ask what topics/i);
    assert.doesNotMatch(source, /Do you want to request or provide a Twitter\/X archive/i);
    assert.doesNotMatch(source, /For Codex, do you want high reasoning or medium reasoning/i);
    assert.doesNotMatch(source, /Codex is selected but reasoning effort is missing, ask/i);
  }
});

test('install docs use three required questions plus one optional etc step', async () => {
  const setupGuide = await fs.readFile(path.join(process.cwd(), 'docs/setup-for-coding-agents.md'), 'utf8');
  const setupScript = await fs.readFile(path.join(process.cwd(), 'scripts/setup.sh'), 'utf8');

  assert.match(setupGuide, /exactly three REQUIRED questions/i);
  assert.match(setupGuide, /Required: Brain Provider/i);
  assert.match(setupGuide, /Required: Usage Level/i);
  assert.match(setupGuide, /Required: Content source or sources to configure now/i);
  assert.match(setupGuide, /Optional: name your agent \(otherwise I'll pick one\), add custom curation interests, or import a Twitter\/X archive/i);
  assert.match(setupGuide, /skip-all.*default agent name/i);
  assert.match(setupGuide, /partial answer.*persist only the items/i);
  assert.match(setupGuide, /Content sources, imported archives, and thumbs up\/down feedback are the primary way Evogent learns interests/i);
  assert.match(setupGuide, /Do not block setup just because `data\/config\.md` has an empty `## Interests` section/i);
  assert.match(setupGuide, /Content Sources \(required: configure at least one\)/i);
  assert.match(setupScript, /Optional: edit data\/curation-prompt\.md for explicit steering/i);
});

test('/setup-wizard is discoverable and injected as a chat instruction', async () => {
  const commands = await listUserFacingCommands({
    cwd: process.cwd(),
    provider: 'codex',
  });

  assert.ok(commands.some((command) => command.name === 'setup-wizard'));

  const instruction = buildChatInstruction({
    message: '/setup-wizard',
    context: null,
    inReplyTo: null,
    messageId: 'msg-setup',
    sessionId: '77777777-7777-4777-8777-777777777777',
    cwd: process.cwd(),
  });

  assert.match(instruction, /The user invoked \/setup-wizard/i);
  assert.match(instruction, /CommandDocumentPath: \.claude\/commands\/setup-wizard\.md/);
  assert.match(instruction, /## Slash Command Document: \/setup-wizard/);
  assert.match(instruction, /Diagnose Evogent setup state/);
  assert.match(instruction, /not a React wizard/);
});
