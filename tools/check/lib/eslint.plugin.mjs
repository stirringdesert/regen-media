// Correctness-only ESLint config for Figma plugin sources (kit-owned; plugins need no config of their own).
// main = sandbox code (code.js): figma/__html__ globals. ui = scripts extracted from ui.html (browser): only rules that don't need globals.
const err = ['no-dupe-keys', 'no-dupe-args', 'no-dupe-else-if', 'no-unreachable', 'no-const-assign', 'no-func-assign', 'no-self-assign', 'no-unsafe-negation', 'use-isnan', 'valid-typeof', 'no-cond-assign', 'no-redeclare', 'no-import-assign', 'no-invalid-regexp', 'no-sparse-arrays', 'no-unsafe-finally', 'no-dupe-class-members', 'no-this-before-super', 'getter-return', 'no-setter-return', 'no-loss-of-precision', 'no-unused-private-class-members'];
const rules = Object.fromEntries(err.map(r => [r, 'error']));
const warn = { 'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }], 'no-empty': ['warn', { allowEmptyCatch: true }], 'no-useless-escape': 'warn', 'no-prototype-builtins': 'warn' };
const mainGlobals = Object.fromEntries(['figma', '__html__', '__uiFiles__', 'console', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'atob', 'btoa', 'TextEncoder', 'TextDecoder', 'URL', 'fetch', 'structuredClone', 'Uint8Array'].map(g => [g, 'readonly']));
export default [
  { files: ['**/*.main.js', '**/code*.js'], languageOptions: { ecmaVersion: 'latest', sourceType: 'script', globals: mainGlobals }, rules: { ...rules, ...warn, 'no-undef': 'error' } },
  { files: ['**/*.ui.js'], languageOptions: { ecmaVersion: 'latest', sourceType: 'script' }, rules: { ...rules, ...warn } },
];
