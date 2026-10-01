import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['dist/', 'src/renderer/vendor/'] },
  js.configs.recommended,
  {
    // Main process, its modules, tests and tooling: Node ES modules.
    files: ['src/main/**/*.js', 'scripts/**/*.{js,mjs}', 'eslint.config.js', 'test/**/*.js'],
    languageOptions: { sourceType: 'module', globals: globals.node }
  },
  {
    // Sandboxed preload: CommonJS with a restricted require.
    files: ['src/preload.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: globals.commonjs }
  },
  {
    // Renderer: plain browser ES modules, no Node.
    files: ['src/renderer/**/*.js'],
    languageOptions: { sourceType: 'module', globals: globals.browser }
  }
];
