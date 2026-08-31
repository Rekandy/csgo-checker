const js = require("@eslint/js");
const globals = require("globals");

/**
 * ESLint flat config (eslint@9).
 *
 * Pragmatic setup: the recommended rule set with a few relaxations so it passes
 * on the existing large source files without forcing a stylistic rewrite.
 * `console` is allowed everywhere (this is an Electron app that logs freely).
 */
module.exports = [
  // Files/directories that should never be linted.
  {
    ignores: [
      "node_modules/**",
      "build/**",
      "dist/**",
      "out/**",
      "html/css/bootstrap*",
      "html/js/bootstrap*"
    ]
  },

  // Base recommended rules for everything we lint.
  js.configs.recommended,

  // Node/CommonJS context: main process, preload, storage, helpers, tests.
  {
    files: [
      "main.js",
      "preload.js",
      "EncryptedStorage.js",
      "eslint.config.js",
      ".ncurc.js",
      "helpers/**/*.js",
      "test/**/*.js"
    ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        ...globals.node
      }
    }
  },

  // Browser/renderer context: html/js/** runs in the Electron renderer with a
  // handful of extra globals exposed through preload.js contextBridge.
  {
    files: ["html/js/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        ...globals.browser,
        bootstrap: "readonly",
        ipcRenderer: "readonly",
        fastEqual: "readonly",
        friendCode: "readonly",
        clipboard: "readonly",
        shell: "readonly",
        md_converter: "readonly"
      }
    }
  },

  // Pragmatic relaxations applied across all linted files. These keep the
  // existing code green while still catching real problems.
  {
    rules: {
      "no-console": "off",
      "no-unused-vars": ["warn", { args: "none", caughtErrors: "none" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      // The existing code reassigns caught exception params to normalize error
      // messages; this is an intentional pattern here, not a bug.
      "no-ex-assign": "off",
      // Existing storage code uses obj.hasOwnProperty and a defensive try/catch
      // wrapper; relaxing these avoids rewriting working code for style alone.
      "no-prototype-builtins": "off",
      "no-useless-catch": "off"
    }
  }
];
