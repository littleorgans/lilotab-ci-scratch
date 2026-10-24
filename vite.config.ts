import { crx, type CrxPlugin } from '@crxjs/vite-plugin';
import { readFileSync } from 'node:fs';
import { defineConfig, lazyPlugins, type Plugin } from 'vite-plus';
import manifest from './manifest.config.ts';
import { POPUP_PAGE, WELCOME_PAGE } from './src/worker/names.ts';

// C-SEC-05: the release manifest exposes no web accessible resources. CRXJS lists the injected overlay there, but
// Chrome injects a packaged file without exposure, so this build only hook, after CRXJS, removes the entry
// (03-components 6). Development builds keep CRXJS's exposure for its dev server; their output is never shipped.
const noExposure = (): CrxPlugin => ({
  name: 'no-exposure',
  apply: 'build',
  enforce: 'post',
  renderCrxManifest(m) {
    delete m.web_accessible_resources;
    return m;
  },
});

const releaseNotices = (): Plugin => ({
  name: 'release-notices',
  apply: 'build',
  generateBundle() {
    for (const fileName of ['LICENSE', 'NOTICE', 'TRADEMARKS.md']) {
      this.emitFile({ type: 'asset', fileName, source: readFileSync(new URL(fileName, import.meta.url)) });
    }
  },
});

// The pure core holds every rule and performs no I/O: no browser, DOM, timers, clock or randomness,
// and no imports from the worker or hosts (03-components 3.1). tsconfig.core.json backs this with types.
const coreGlobals = [
  'chrome',
  'browser',
  'window',
  'document',
  'navigator',
  'performance',
  'Date',
  'setTimeout',
  'setInterval',
  'clearTimeout',
  'clearInterval',
  'queueMicrotask',
  'requestAnimationFrame',
  'fetch',
  'crypto',
];

export default defineConfig({
  lint: {
    plugins: ['oxc', 'typescript', 'unicorn', 'import'],
    categories: {
      correctness: 'warn',
    },
    options: {
      typeAware: true,
      typeCheck: true,
      denyWarnings: true, // the correctness category warns; any finding fails just check, as under ESLint
    },
    env: {
      builtin: true,
    },
    ignorePatterns: ['dist', 'dist-timing', 'release', 'node_modules'],
    rules: {
      'constructor-super': 'error',
      'for-direction': 'error',
      'getter-return': 'error',
      'no-async-promise-executor': 'error',
      'no-case-declarations': 'error',
      'no-class-assign': 'error',
      'no-compare-neg-zero': 'error',
      'no-cond-assign': 'error',
      'no-const-assign': 'error',
      'no-constant-binary-expression': 'error',
      'no-constant-condition': 'error',
      'no-control-regex': 'error',
      'no-debugger': 'error',
      'no-delete-var': 'error',
      'no-dupe-class-members': 'error',
      'no-dupe-else-if': 'error',
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'no-empty': 'error',
      'no-empty-character-class': 'error',
      'no-empty-pattern': 'error',
      'no-empty-static-block': 'error',
      'no-ex-assign': 'error',
      'no-extra-boolean-cast': 'error',
      'no-fallthrough': 'error',
      'no-func-assign': 'error',
      'no-global-assign': 'error',
      'no-import-assign': 'error',
      'no-invalid-regexp': 'error',
      'no-irregular-whitespace': 'error',
      'no-loss-of-precision': 'error',
      'no-misleading-character-class': 'error',
      'no-new-native-nonconstructor': 'error',
      'no-nonoctal-decimal-escape': 'error',
      'no-obj-calls': 'error',
      'no-prototype-builtins': 'error',
      'no-redeclare': 'error',
      'no-regex-spaces': 'error',
      'no-self-assign': 'error',
      'no-setter-return': 'error',
      'no-shadow-restricted-names': 'error',
      'no-sparse-arrays': 'error',
      'no-this-before-super': 'error',
      'no-unassigned-vars': 'error',
      'no-undef': 'error',
      'no-unexpected-multiline': 'error',
      'no-unreachable': 'error',
      'no-unsafe-finally': 'error',
      'no-unsafe-negation': 'error',
      'no-unsafe-optional-chaining': 'error',
      'no-unused-labels': 'error',
      'no-unused-private-class-members': 'error',
      'no-unused-vars': 'error',
      'no-useless-assignment': 'error',
      'no-useless-backreference': 'error',
      'no-useless-catch': 'error',
      'no-useless-escape': 'error',
      'no-with': 'error',
      'preserve-caught-error': 'error',
      'require-yield': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      'no-array-constructor': 'error',
      'no-unused-expressions': 'error',
      'no-useless-constructor': 'error',
      'typescript/await-thenable': 'error',
      'typescript/ban-ts-comment': [
        'error',
        {
          minimumDescriptionLength: 10,
        },
      ],
      'typescript/no-array-delete': 'error',
      'typescript/no-base-to-string': 'error',
      'typescript/no-confusing-void-expression': 'error',
      'typescript/no-deprecated': 'error',
      'typescript/no-duplicate-enum-values': 'error',
      'typescript/no-duplicate-type-constituents': 'error',
      'typescript/no-dynamic-delete': 'error',
      'typescript/no-empty-object-type': 'error',
      'typescript/no-explicit-any': 'error',
      'typescript/no-extra-non-null-assertion': 'error',
      'typescript/no-extraneous-class': 'error',
      'typescript/no-floating-promises': 'error',
      'typescript/no-for-in-array': 'error',
      'typescript/no-generated-empty-object-type': 'error',
      'typescript/no-implied-eval': 'error',
      'typescript/no-invalid-void-type': 'error',
      'typescript/no-meaningless-void-operator': 'error',
      'typescript/no-misused-new': 'error',
      'typescript/no-misused-promises': 'error',
      'typescript/no-misused-spread': 'error',
      'typescript/no-mixed-enums': 'error',
      'typescript/no-namespace': 'error',
      'typescript/no-non-null-asserted-nullish-coalescing': 'error',
      'typescript/no-non-null-asserted-optional-chain': 'error',
      'typescript/no-non-null-assertion': 'error',
      'typescript/no-redundant-type-constituents': 'error',
      'typescript/no-require-imports': 'error',
      'typescript/no-this-alias': 'error',
      'typescript/no-unnecessary-boolean-literal-compare': 'error',
      'typescript/no-unnecessary-condition': 'error',
      'typescript/no-unnecessary-template-expression': 'error',
      'typescript/no-unnecessary-type-arguments': 'error',
      'typescript/no-unnecessary-type-assertion': 'error',
      'typescript/no-unnecessary-type-constraint': 'error',
      'typescript/no-unnecessary-type-conversion': 'error',
      'typescript/no-unnecessary-type-parameters': 'error',
      'typescript/no-unsafe-argument': 'error',
      'typescript/no-unsafe-assignment': 'error',
      'typescript/no-unsafe-call': 'error',
      'typescript/no-unsafe-declaration-merging': 'error',
      'typescript/no-unsafe-enum-comparison': 'error',
      'typescript/no-unsafe-function-type': 'error',
      'typescript/no-unsafe-member-access': 'error',
      'typescript/no-unsafe-return': 'error',
      'typescript/no-unsafe-unary-minus': 'error',
      'typescript/no-useless-default-assignment': 'error',
      'typescript/no-wrapper-object-types': 'error',
      'typescript/only-throw-error': 'error',
      'typescript/prefer-as-const': 'error',
      'typescript/prefer-literal-enum-member': 'error',
      'typescript/prefer-namespace-keyword': 'error',
      'typescript/prefer-promise-reject-errors': 'error',
      'typescript/prefer-reduce-type-parameter': 'error',
      'typescript/prefer-return-this-type': 'error',
      'typescript/related-getter-setter-pairs': 'error',
      'typescript/require-await': 'error',
      'typescript/restrict-plus-operands': [
        'error',
        {
          allowAny: false,
          allowBoolean: false,
          allowNullish: false,
          allowNumberAndString: false,
          allowRegExp: false,
        },
      ],
      'typescript/restrict-template-expressions': [
        'error',
        {
          allowAny: false,
          allowBoolean: false,
          allowNever: false,
          allowNullish: false,
          allowNumber: false,
          allowRegExp: false,
        },
      ],
      'typescript/return-await': ['error', 'error-handling-correctness-only'],
      'typescript/triple-slash-reference': 'error',
      'typescript/unbound-method': 'error',
      'typescript/unified-signatures': 'error',
      'typescript/use-unknown-in-catch-callback-variable': 'error',
      'vite-plus/prefer-vite-plus-imports': 'error',
      // Relative imports spell out the TS file, index.ts included: the one form plain Node also loads.
      // js: 'never' rejects the .js spelling that bundler resolution maps to a .ts file.
      'import/extensions': ['error', 'always', { ignorePackages: true, checkTypeImports: true, js: 'never' }],
      'import/default': 'off', // the type check covers it; this rule misreads the overlay's ?script&iife import
    },
    overrides: [
      {
        files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
        rules: {
          'constructor-super': 'off',
          'getter-return': 'off',
          'no-class-assign': 'off',
          'no-const-assign': 'off',
          'no-dupe-class-members': 'off',
          'no-dupe-keys': 'off',
          'no-func-assign': 'off',
          'no-import-assign': 'off',
          'no-new-native-nonconstructor': 'off',
          'no-obj-calls': 'off',
          'no-redeclare': 'off',
          'no-setter-return': 'off',
          'no-this-before-super': 'off',
          'no-undef': 'off',
          'no-unreachable': 'off',
          'no-unsafe-negation': 'off',
          'no-var': 'error',
          'no-with': 'off',
          'prefer-const': 'error',
          'prefer-rest-params': 'error',
          'prefer-spread': 'error',
        },
      },
      {
        // The headless Chrome harness is plain JS run by Node that also ships functions into browser worlds over CDP.
        // These rules need type annotations, or forbid the probe's wrapping of native prototype methods.
        files: ['test/chrome/**'],
        env: { node: true, browser: true },
        rules: {
          'typescript/no-unsafe-argument': 'off',
          'typescript/no-unsafe-assignment': 'off',
          'typescript/no-unsafe-call': 'off',
          'typescript/no-unsafe-member-access': 'off',
          'typescript/no-unsafe-return': 'off',
          'typescript/no-unsafe-enum-comparison': 'off',
          'typescript/restrict-plus-operands': 'off',
          'typescript/restrict-template-expressions': 'off',
          'typescript/use-unknown-in-catch-callback-variable': 'off',
          'typescript/unbound-method': 'off',
        },
      },
      {
        files: ['src/core/**'],
        excludeFiles: ['src/**/*.test.ts'],
        rules: {
          'no-restricted-globals': [
            'error',
            ...coreGlobals.map((name) => ({ name, message: 'The core is pure; use an adapter.' })),
          ],
          'no-restricted-properties': [
            'error',
            {
              object: 'Math',
              property: 'random',
              message: 'The core is pure; ids come from the model.',
            },
          ],
          'no-restricted-imports': [
            'error',
            {
              patterns: [
                {
                  group: ['**/worker', '**/worker/**', '**/hosts', '**/hosts/**'],
                  message: 'The core never imports adapters or hosts.',
                },
                {
                  group: ['chrome', 'webextension-polyfill', 'node:*'],
                  message: 'The core never imports platform APIs.',
                },
              ],
            },
          ],
        },
      },
    ],
    jsPlugins: [
      {
        name: 'vite-plus',
        specifier: 'vite-plus/oxlint-plugin',
      },
    ],
  },
  fmt: {
    singleQuote: true,
    printWidth: 120,
    sortPackageJson: false,
    ignorePatterns: ['dist', 'dist-timing', 'release', 'package-lock.json', 'docs/design', '.lilo'],
  },
  // lazyPlugins skips the plugins while vp check, lint and fmt read this config; under exactOptionalPropertyTypes
  // its undefined return needs a fallback.
  plugins: lazyPlugins(() => [crx({ manifest }), noExposure(), releaseNotices()]) ?? [],
  build: {
    target: 'chrome148', // the manifest's minimum (C-PERM-04): CSS such as light-dark() and the JS ship unlowered
    rolldownOptions: {
      // Pages the worker opens itself, so the manifest never names them: the per tab action popup and the welcome tab.
      input: { popup: POPUP_PAGE, welcome: WELCOME_PAGE },
    },
  },
});
