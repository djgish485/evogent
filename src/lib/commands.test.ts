import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { listUserFacingCommands } from './commands';

const tempRoots: string[] = [];

async function createTempRoot(): Promise<string> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-commands-'));
  tempRoots.push(root);
  return root;
}

after(async () => {
  await Promise.all(tempRoots.map((root) => fs.promises.rm(root, { recursive: true, force: true })));
});
test('listUserFacingCommands prefers project commands and filters hidden/internal files', async () => {
  const cwd = await createTempRoot();
  const homeDir = await createTempRoot();
  const linkedCommandSource = await createTempRoot();

  await fs.promises.mkdir(path.join(cwd, '.claude', 'commands'), { recursive: true });
  await fs.promises.mkdir(path.join(homeDir, '.claude', 'commands'), { recursive: true });
  await fs.promises.mkdir(linkedCommandSource, { recursive: true });

  await fs.promises.writeFile(
    path.join(cwd, '.claude', 'commands', 'research.md'),
    'Project research command.\n\nUsage: /research <topic>\n',
    'utf8',
  );
  await fs.promises.writeFile(
    path.join(homeDir, '.claude', 'commands', 'research.md'),
    'Global research command.\n\nUsage: /research <topic>\n',
    'utf8',
  );
  const linkedStatusPath = path.join(linkedCommandSource, 'status.md');
  await fs.promises.writeFile(
    linkedStatusPath,
    'Check running work.\n\nSteps:\n1. Do the thing.\n',
    'utf8',
  );
  await fs.promises.symlink(linkedStatusPath, path.join(homeDir, '.claude', 'commands', 'status.md'));
  await fs.promises.writeFile(
    path.join(cwd, '.claude', 'commands', 'intake-enrich.md'),
    'Internal maintenance command.\n',
    'utf8',
  );
  await fs.promises.writeFile(
    path.join(homeDir, '.claude', 'commands', 'hidden.md'),
    [
      '---',
      'metadata:',
      '  evogent:',
      '    user-facing: false',
      '---',
      '',
      'Should not appear.',
    ].join('\n'),
    'utf8',
  );

  const commands = await listUserFacingCommands({ cwd, homeDir });

  assert.deepStrictEqual(commands, [
    {
      name: 'research',
      description: 'Project research command.',
      source: 'project',
    },
    {
      name: 'status',
      description: 'Check running work.',
      source: 'global',
    },
  ]);
});

test('listUserFacingCommands limits Codex installs to supported slash commands', async () => {
  const cwd = await createTempRoot();

  await fs.promises.mkdir(path.join(cwd, '.claude', 'commands'), { recursive: true });
  await fs.promises.writeFile(
    path.join(cwd, '.claude', 'commands', 'new-chat-session.md'),
    '---\nmetadata:\n  evogent:\n    user-facing: true\n---\n\nCreate app chat sessions.\n',
    'utf8',
  );
  await fs.promises.writeFile(
    path.join(cwd, '.claude', 'commands', 'reflect.md'),
    'Run reflection.\n',
    'utf8',
  );
  await fs.promises.writeFile(
    path.join(cwd, '.claude', 'commands', 'research.md'),
    'Run research.\n',
    'utf8',
  );
  await fs.promises.writeFile(
    path.join(cwd, '.claude', 'commands', 'status.md'),
    'Check running work.\n',
    'utf8',
  );
  await fs.promises.writeFile(
    path.join(cwd, '.claude', 'commands', 'source-status.md'),
    '---\nmetadata:\n  evogent:\n    user-facing: true\n---\n\nReport source cache health.\n',
    'utf8',
  );
  const commands = await listUserFacingCommands({ cwd, provider: 'codex' });
  assert.deepStrictEqual(commands.map((command) => command.name), ['new-chat-session', 'reflect', 'research', 'source-status']);
});
