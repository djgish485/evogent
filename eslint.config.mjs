import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const runtimeDataIgnores = [
  'data/agent-state/**',
  'data/backups/**',
  'data/chat-attachments/**',
  'data/chrome-browse-profile/**',
  'data/config-history/**',
  'data/curation-prompt-history/**',
  'data/logs/**',
  'data/task-logs/**',
  'data/tmp/**',
  'data/validation-dispatch-test/**',
];

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ['**/*.{js,cjs}'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  globalIgnores([
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    ...runtimeDataIgnores,
    'x-*.js',
  ]),
]);
