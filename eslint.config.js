import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['dist/', 'vendor/'] },
  js.configs.recommended,
  {
    // Main process, its modules, tests and tooling: Node ES modules.
    files: ['main.js', 'activity.js', 'disk-monitor.js', 'disk-parsers.js', 'eslint.config.js', 'test/**/*.js'],
    languageOptions: { sourceType: 'module', globals: globals.node }
  },
  {
    // Sandboxed preload: CommonJS with a restricted require.
    files: ['preload.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: globals.commonjs }
  },
  {
    // Renderer: plain browser ES modules, no Node.
    files: ['renderer.js', 'audio.js'],
    languageOptions: { sourceType: 'module', globals: globals.browser }
  }
];
