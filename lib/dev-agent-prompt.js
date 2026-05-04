'use strict';

const path = require('node:path');
const { renderPromptAddonBody } = require('./prompt-addons');

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function shellDoubleQuote(value) {
  return `"${String(value).replace(/(["\\$`])/g, '\\$1')}"`;
}

function shellAssign(name, value) {
  return `${name}=${shellQuote(value)}`;
}

function summarizePrompt(title, proposedValue) {
  return [title, proposedValue]
    .filter((value) => typeof value === 'string' && value.trim())
    .join(': ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function buildAgentPrompt({
  taskId,
  branchName,
  worktreePath,
  repoDir,
  internalBaseUrl,
  suggestion,
  repoConfig = {},
}) {
  const title = suggestion.title || '(no title)';
  const proposedValue = suggestion.proposedValue || suggestion.text || '';
  const suggestionId = suggestion.suggestionId || suggestion.feedItemId || suggestion.id || '';
  const workingPath = worktreePath || repoDir || process.cwd();
  const sourceRepoDir = repoDir || workingPath;
  const validationCommands = Array.isArray(repoConfig.validationCommands) ? repoConfig.validationCommands : [];
  const addonBody = renderPromptAddonBody(repoConfig.addon?.body || '', {
    taskId,
    branchName,
    repoDir,
    worktreePath: workingPath,
  });
  const postMergeHookPath = repoConfig.postMergeHook ? path.resolve(sourceRepoDir, repoConfig.postMergeHook) : '';
  const validationText = validationCommands.length
    ? validationCommands.map((command) => `\`${command}\``).join(', then ')
    : 'the smallest relevant validation available in this repo; if none exists, explain that in the final report';
  const gitCommitStep = repoConfig.insideGitWorkTree
    ? '4. Once validation passes, commit your changes with a clear message describing what changed and why.'
    : '4. This is not a git work tree; do not create commits. Keep edits in place and report exactly what changed.';
  const mergeTarget = repoConfig.mergeTarget || 'main';
  const shouldPushAfterMerge = repoConfig.pushAfterMerge !== false;
  const receiptAwareMergeScript = repoConfig.receiptAwareMergeScript
    ? path.resolve(sourceRepoDir, repoConfig.receiptAwareMergeScript)
    : '';
  const canReceiptMerge = Boolean(repoConfig.mergeAfterGates && receiptAwareMergeScript);
  const mergeRequestedWithoutReceipt = Boolean(repoConfig.mergeAfterGates && !receiptAwareMergeScript);
  const preMergeCommands = [
    `cd ${shellQuote(sourceRepoDir)}`,
    shouldPushAfterMerge ? 'git fetch origin' : '',
    `git checkout ${shellQuote(mergeTarget)}`,
  ].filter(Boolean);
  const receiptMergeEnv = [
    shellAssign('REPO_DIR', sourceRepoDir),
    shellAssign('MERGE_BRANCH', branchName),
    shellAssign('MERGE_TARGET', mergeTarget),
    shellAssign('PUSH_AFTER_MERGE', shouldPushAfterMerge ? '1' : '0'),
    shellAssign('ENQUEUE_POST_MERGE_REVIEW', '0'),
    shellAssign('RECEIPT_REQUIRED', '1'),
    shellAssign('CODE_FIX_BRANCH', branchName),
    shellAssign('CODE_FIX_SUGGESTION_ID', suggestionId),
    shellAssign('CODE_FIX_ORIGIN_SESSION_ID', suggestion.originSessionId || ''),
    shellAssign('CODE_FIX_PROMPT_SUMMARY', summarizePrompt(title, proposedValue)),
    shellAssign('MEDIA_AGENT_INTERNAL_BASE_URL', internalBaseUrl),
    postMergeHookPath ? shellAssign('POST_MERGE_HOOK', postMergeHookPath) : '',
  ].filter(Boolean).join(' ');
  const mergeCommand = canReceiptMerge
    ? [
        ...preMergeCommands,
        `${receiptMergeEnv} bash ${shellQuote(receiptAwareMergeScript)} ${shellQuote(taskId)} pass`,
      ].join(' && ')
    : '';
  const mergeStep = canReceiptMerge
    ? [
        '5. Acquire the repo-specific merge lock and run the receipt-aware merge. Run this exact bash sequence:',
        `   flock -w 600 ${shellQuote(repoConfig.mergeLockPath)} bash -c ${shellDoubleQuote(mergeCommand)}`,
        '   - This writes structured merge trailers and appends exactly one `data/agent-receipts.jsonl` row for a new merge commit.',
        '   - The self-report endpoint will enqueue the success chat audit callback after you report the merge; do not enqueue another one manually.',
        '   - If the merge hits a real conflict you cannot resolve, report failed.',
      ]
    : mergeRequestedWithoutReceipt
      ? [
          '5. Automatic merge was requested, but this repo does not expose a receipt-aware merge script. Do not run a bare git merge or push.',
          '   Report failed after validation with a clear reason that receipt-aware auto-merge is not configured.',
        ]
      : ['5. Do not merge or push automatically. Leave the completed branch/workspace intact; this is a no-receipt/no-merge path.'];
  const shaStep = canReceiptMerge
    ? `6. Capture the resulting merge commit SHA with \`git -C ${shellQuote(sourceRepoDir)} rev-parse HEAD\`.`
    : repoConfig.insideGitWorkTree
      ? `6. You may inspect the branch commit with \`git -C ${shellQuote(workingPath)} rev-parse HEAD\`, but do not report it as a merge commit.`
      : '6. There is no git commit SHA for a non-git directory; use an empty commitSha in the final report.';
  const postMergeStep = canReceiptMerge
    ? ['7. The receipt-aware merge script handles the configured post-merge hook, if one exists.']
    : ['7. No post-merge hook is configured for this repo.'];
  const cleanupStep = canReceiptMerge && repoConfig.useWorktree
    ? [
        '9. Clean up after yourself after reporting success, best-effort only:',
        `   - git -C ${shellQuote(sourceRepoDir)} worktree remove --force ${shellQuote(workingPath)} || true`,
        `   - git -C ${shellQuote(sourceRepoDir)} branch -D ${shellQuote(branchName)} || true`,
        '   On the failure path, do not remove the worktree or branch; the user may want to inspect them.',
      ]
    : ['9. Do not remove the working directory or branch; it is the artifact the user needs to inspect.'];
  const reportStep = canReceiptMerge
    ? '8. Report success (see Reporting).'
    : '8. Do not report this task as merged. If you need to close the task after validation, report failed with a clear no-receipt/no-merge reason.';
  const successReportingLine = canReceiptMerge
    ? '- For success: { phase: "merged", status: "done", commitSha: "<sha>" }'
    : '- Do not send status=done on this no-receipt/no-merge path; status=done is reserved for receipt-aware merges with a real merge SHA.';

  return [
    `You are a code-fix dev agent. Task ID: ${taskId}.`,
    '',
    `The user approved this code-fix suggestion (id: ${suggestionId}):`,
    `TITLE: ${title}`,
    '',
    'GOAL (full proposedValue from the suggestion):',
    proposedValue,
    '',
    'Environment:',
    repoConfig.useWorktree
      ? `- You are in a fresh git worktree at ${workingPath}, on branch "${branchName}", based on ${repoConfig.baseRef || 'HEAD'}.`
      : `- You are working in place at ${workingPath}; no git worktree was created for this task.`,
    repoDir && repoConfig.useWorktree ? `- The source repo is at ${repoDir}. Do not modify it directly unless the workflow explicitly tells you to merge there.` : '',
    repoConfig.installCommand ? `- The platform already ran \`${repoConfig.installCommand}\` in ${workingPath} before launch.` : '- No dependency install command was auto-detected.',
    '- You have full Bash, Edit, Read, Write, Grep, Glob, WebFetch, WebSearch access.',
    `- INTERNAL_BASE_URL=${internalBaseUrl}`,
    '- Time budget: roughly 1 hour wall clock. The systemd unit will kill you after that.',
    '',
    'Workflow:',
    '1. Read the goal carefully. Investigate the codebase. Make the change in the assigned working directory.',
    `2. Run gates IN ORDER inside ${workingPath}: ${validationText}.`,
    '3. If any gate fails:',
    '   a. Investigate. Is the failure caused by your change, or pre-existing on main?',
    '   b. If your change caused it, fix it.',
    '   c. If pre-existing AND small AND clearly fixable within the spirit of the suggestion: fix it as part of this work, with a brief note in the commit message about the dependency.',
    '   d. If pre-existing AND large or out of scope: report failed (see Reporting) with a specific reason naming the test/build error and why fixing it is out of scope. Then exit.',
    gitCommitStep,
    ...mergeStep,
    shaStep,
    ...postMergeStep,
    reportStep,
    ...cleanupStep,
    '',
    'Reporting:',
    `- Send a progress report at each phase to ${internalBaseUrl}/api/internal/code-fix/report. status=progress for every intermediate report. status=done ONLY on the final phase=merged report when you have a real commitSha. status=failed only on terminal failure.`,
    `- Body shape: { "taskId": "${taskId}", "suggestionId": "${suggestionId}", "phase": "<phase>", "status": "progress" | "done" | "failed", "reason": "<text or empty>", "commitSha": "<merge sha or empty>" }`,
    '- Phases to use: implementation_start, lint_pass, build_pass, test_pass, commit_done, merge_started, merged. Use any descriptive phase name as needed.',
    '- Reporting status=done at any phase other than merged, or without commitSha, will terminate this task as failed even if your code is fine.',
    '- For intermediate progress: { phase: "lint_pass", status: "progress" }',
    successReportingLine,
    '- For failure: { phase: "<which-phase>", status: "failed", reason: "<specific text>" }',
    '- Use curl from your Bash tool. Don\'t skip reports - the user sees these as status updates in the UI.',
    '- IMPORTANT: when you report status=done or status=failed, the report endpoint automatically posts a chat message to the chat session that originated this code-fix suggestion. So your `reason` field on failure should be specific and human-readable.',
    '',
    'Hard constraints:',
    '- Do NOT skip hooks (--no-verify) or bypass commit signing.',
    '- Do NOT delete or `it.skip()` tests to make a build pass; investigate the failure.',
    '- Do NOT force-push or modify .env.local or .git config.',
    `- Do NOT modify files outside ${workingPath}${repoConfig.mergeAfterGates ? ' until the merge step' : ''}.`,
    '- Do NOT loop indefinitely. If you are stuck on one issue for >15 minutes, report failed and exit.',
    '- Treat repeated external effects as a loop signal. Do not retry without new information.',
    addonBody ? '' : null,
    addonBody ? 'Repo-specific instructions:' : null,
    addonBody || null,
    '',
    'Begin now. Send your first progress report (phase=implementation_start, status=progress) before doing other work.',
  ].filter((line) => line !== null && line !== undefined).join('\n');
}

module.exports = {
  buildAgentPrompt,
};
