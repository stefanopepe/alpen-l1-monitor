import tseslint from 'typescript-eslint';
export default tseslint.config(
  { ignores: ['node_modules/**', '.local/**', '.vercel/**', 'dist/**', 'coverage/**'] },
  ...tseslint.configs.recommended,
  { files: ['**/*.ts'], rules: { '@typescript-eslint/no-explicit-any': 'error', '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }] } },
  { files: ['src/model/**/*.ts', 'src/pipeline/snapshot.ts'], rules: { 'no-restricted-globals': ['error', 'fetch', 'Date'] } }
);
