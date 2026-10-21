import { builtinModules } from 'node:module'
import js from '@eslint/js'
import tseslint from '@typescript-eslint/eslint-plugin'
import tsparser from '@typescript-eslint/parser'
import globals from 'globals'

// Session and adapter layers must stay host-agnostic: no Node API, no MCP SDK
const HOST_AGNOSTIC_PATTERNS = [
  { group: ['node:*'], message: 'Use the host interface (src/host/host.ts) instead of Node APIs.' },
  { group: [...builtinModules, ...builtinModules.map(m => `${m}/*`)], message: 'Use the host interface (src/host/host.ts) instead of Node APIs.' },
  { group: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*'], message: 'Only the MCP layer may import the MCP SDK.' },
]

// Session and adapter layers know nothing about the webui
const NO_WEBUI_PATTERN = { regex: '^(\\.{1,2}/)+(.*/)?webui(/.*)?$', message: 'The session and adapter layers must not depend on webui.' }

// Modules outside src/webui that webui code must not reach; src/types.ts stays allowed
// Relative imports at any depth (./, ../, ../../../ ...). no-restricted-imports matches the import
// string as written, without resolving it, so the patterns cover every directory level of app/
const NON_WEBUI_MODULES = [
  { regex: '^(\\.{1,2}/)+(.*/)?(session|adapter|host|bridge)(/.*)?$', message: 'webui code only shares src/types.ts with the MCP server.' },
  { regex: '^(\\.{1,2}/)+(.*/)?(config|cli)$', message: 'webui code only shares src/types.ts with the MCP server.' },
  { regex: '^(\\.\\./)+server$', message: 'webui code must not import the MCP server.' },
]
// link.ts and server.ts (webui or MCP), off limits to shared and browser code
const WEBUI_PROCESS_MODULES = [{ regex: '^(\\.{1,2}/)+(.*/)?(link|server)$', message: 'Shared and browser code must not import link.ts or server.ts.' }]

export default [
  js.configs.recommended,
  {
    files: ['**/*.{js,cjs,mjs,ts,tsx}'],
    plugins: {
      '@typescript-eslint': tseslint,
    },
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      globals: {
        ...globals.es2022,
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', {
        'args': 'all',
        'argsIgnorePattern': '^_',
        'caughtErrors': 'all',
        'caughtErrorsIgnorePattern': '^_',
        'destructuredArrayIgnorePattern': '^_',
        'varsIgnorePattern': '^_',
        'ignoreRestSiblings': true,
      }],
      'no-redeclare': 'off',
      'quotes': ['error', 'single'],
      'semi': ['error', 'never'],
    },
  },
  {
    files: ['src/session/**', 'src/config.ts', 'src/host/host.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [...HOST_AGNOSTIC_PATTERNS, NO_WEBUI_PATTERN] }],
    },
  },
  {
    files: ['src/adapter/**'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          ...HOST_AGNOSTIC_PATTERNS,
          { group: ['**/session', '**/session/*'], message: 'The adapter layer must not depend on the session layer.' },
          NO_WEBUI_PATTERN,
        ],
      }],
    },
  },
  {
    files: ['src/webui/protocol.ts', 'src/webui/transcript.ts', 'src/webui/parsers/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [...HOST_AGNOSTIC_PATTERNS, ...NON_WEBUI_MODULES, ...WEBUI_PROCESS_MODULES] }],
    },
  },
  {
    files: ['src/webui/app/**'],
    languageOptions: { globals: globals.browser },
    rules: {
      'no-restricted-imports': ['error', { patterns: [...HOST_AGNOSTIC_PATTERNS, ...NON_WEBUI_MODULES, ...WEBUI_PROCESS_MODULES] }],
    },
  },
  {
    files: ['src/webui/server.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [...NON_WEBUI_MODULES, { regex: '^\\./link$', message: 'The webui process does not run the MCP-side link.' }],
      }],
    },
  },
  {
    ignores: ['dist/', 'node_modules/', 'test/', 'webpack.config.js'],
  },
]
