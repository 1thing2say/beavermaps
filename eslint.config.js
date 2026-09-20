// What a linter is for on this project, and what it is not for.
//
// NOT STYLE. This codebase has a voice — long explanatory comments, section
// rules, sentences in capitals where something is load-bearing — and a
// formatter would flatten some of that and start arguments about the rest. No
// rule here has an opinion about where a brace goes.
//
// WHAT IT IS FOR is the class of mistake that is invisible in review and
// obvious at runtime: a name that does not exist, a variable used before its
// declaration is reached, a `catch` that swallows a symbol nobody defined, a
// promise nobody awaited. The bugs found in the scan this config was added
// alongside were all of that shape — an `endMarker.remove()` on a null, a
// `maxBounds` three comments relied on and nothing set. A linter would not have
// caught either. It would have caught the next one down.
//
// Every rule below is an ERROR. A warning in a project with no CI is a warning
// nobody reads, and this project now has CI.

import js from '@eslint/js';
import globals from 'globals';

/** Rules shared by everything, wherever it runs. */
const shared = {
  // TDZ is a real hazard in src/main.js — see the comment above `litPalette`,
  // which says in prose that declaring two constants lower down "is not a
  // warning, it is a blank page". But `variables: true` cannot tell that case
  // from the ordinary one: a `const` arrow function referenced inside another
  // function that runs later is safe, correct and used about thirty times in
  // this codebase. Flagging all thirty to catch the one would mean this rule
  // gets switched off within a week, which is worth less than a narrower rule
  // that stays on. Classes stay checked because those really are TDZ.
  'no-use-before-define': ['error', { functions: false, classes: true, variables: false }],

  // An unused import is usually a refactor that did not finish. `_`-prefixed
  // arguments are exempt because Express's error handlers need four parameters
  // to be recognised as error handlers and the fourth is genuinely unused.
  'no-unused-vars': ['error', {
    argsIgnorePattern: '^_',
    varsIgnorePattern: '^_',
    caughtErrors: 'none',
  }],

  // `if (x = 1)` and `if (a => b)`. Both parse; neither was meant.
  'no-cond-assign': ['error', 'always'],
  eqeqeq: ['error', 'always', { null: 'ignore' }],

  // A floating promise in an event handler is how an async failure becomes an
  // unhandled rejection with no stack worth reading — which is exactly how the
  // placeEnd bug surfaced.
  'no-async-promise-executor': 'error',
  'require-atomic-updates': 'error',

  // Left in by accident, every time.
  'no-debugger': 'error',
  'no-alert': 'error',
};

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'campus-data/**'],
  },

  // The browser half.
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2025,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: {
      ...js.configs.recommended.rules,
      ...shared,
      // The one console rule that earns itself. This app deliberately logs
      // failures it has decided to survive — a missing overlay is one layer,
      // not a dead load — so console.error and console.warn are part of how it
      // reports. A bare console.log is debugging somebody forgot to remove.
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },

  // The server and the build scripts: node, and noisier on purpose. Both print
  // progress that somebody reads.
  {
    files: ['server/**/*.js', 'scripts/**/*.mjs', 'vite.config.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2025,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      ...shared,
    },
  },

  // Tests. Node globals plus the test runner's, and free to be noisy.
  {
    files: ['test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2025,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      ...shared,
    },
  },
];
