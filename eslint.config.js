import js from '@eslint/js'
import globals from 'globals'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

export default [
  // agents/content-scout is a Python tool — its virtualenv (when present locally)
  // vendors third-party JS that ESLint would otherwise lint and fail CI on.
  { ignores: ['dist', 'node_modules', 'agents/content-scout'] },
  js.configs.recommended,
  {
    // Plain Node scripts (agent/CI tooling) — no browser globals, no React.
    files: ['agents/**/*.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['**/*.{js,jsx}'],
    ignores: ['agents/**'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    settings: { react: { version: 'detect' } },
    plugins: {
      react,
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...react.configs.recommended.rules,
      ...react.configs['jsx-runtime'].rules,
      // Only the classic hooks rules — eslint-plugin-react-hooks v7's
      // "recommended" bundles React Compiler rules (set-state-in-effect,
      // refs, purity, etc.) that flag long-standing, working patterns in
      // this codebase as errors. Not relevant since this app doesn't use
      // the Compiler.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'react/prop-types': 'off',
    },
  },
]
