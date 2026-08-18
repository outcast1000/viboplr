import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

// Enforces the parts of `.claude/rules/conventions.md` a linter can actually
// check. Before this the conventions existed only as prose, so the same findings
// (empty catches, refs written during render) kept coming back.
//
// `npm run lint` gates on ERRORS only. Warnings are a declared, counted backlog —
// see "Warning backlog" at the bottom. Don't promote one to error without fixing
// the whole class first, and don't add a blanket `--max-warnings` until the
// backlog is actually zero; a permanently-red lint is a lint nobody runs.

/** Component or custom-hook function, however it's declared or wrapped. */
const COMPONENT_OR_HOOK = [
  "FunctionDeclaration[id.name=/^(use[A-Z]|[A-Z])/]",
  "FunctionExpression[id.name=/^(use[A-Z]|[A-Z])/]",
  "VariableDeclarator[id.name=/^(use[A-Z]|[A-Z])/] > ArrowFunctionExpression",
  "VariableDeclarator[id.name=/^(use[A-Z]|[A-Z])/] > FunctionExpression",
].join(", ");

/**
 * `someRef.current = value` as a direct statement of a component/hook body.
 *
 * This is the regression guard for the render-body ref-write refactor: 100 of
 * these were replaced by `useAssignRef` / `useLatestRef` (see
 * `src/hooks/useLatestRef.ts` for why a render-phase ref write is wrong).
 *
 * It exists as its own rule because `react-hooks/refs` — which finds the same
 * thing — cannot be an error here: it also reports every `playback.foo` access
 * (the compiler treats any property of a hook-return object that *contains* a
 * ref as a ref access) and every ref passed into a hook, which is this app's
 * core architecture. Those are ~113 unavoidable reports. This selector has no
 * false positives: requiring a DIRECT child of the function's block excludes
 * writes inside effects, callbacks, conditionals and loops, which are all legal.
 */
const NO_REF_WRITE_IN_RENDER = {
  selector: `:matches(${COMPONENT_OR_HOOK}) > BlockStatement > ExpressionStatement > AssignmentExpression[left.property.name="current"]`,
  message:
    "Ref written during render. Use `useAssignRef(ref, value)` or `useLatestRef(value)` from hooks/useLatestRef.ts — a render-phase write is discarded work under StrictMode/concurrent rendering.",
};

/** Empty `.catch(() => {})` — conventions.md "Error Logging". */
const NO_SILENT_CATCH = {
  selector:
    'CallExpression[callee.property.name="catch"] > ArrowFunctionExpression[body.type="BlockStatement"][body.body.length=0]',
  message:
    "Empty .catch() handler. Log with console.error, or add an eslint-disable with a comment explaining why failure is safe to ignore (conventions.md > Error Logging).",
};

export default tseslint.config(
  {
    ignores: [
      "dist/",
      "docs/",
      "public/",
      "src-tauri/",
      "benchmarks/",
      "node_modules/",
      "**/*.d.ts",
    ],
  },

  // ---- Frontend: src/** ----------------------------------------------------
  {
    files: ["src/**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat["recommended-latest"],
    ],
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser },
    },
    rules: {
      "no-restricted-syntax": ["error", NO_REF_WRITE_IN_RENDER, NO_SILENT_CATCH],
      "no-empty": ["error", { allowEmptyCatch: false }],

      // The codebase logs deliberately (conventions.md requires console.error in
      // every catch), so console is allowed — but a bare console.log in a
      // production path is the smell the code-health report flagged.
      "no-console": ["warn", { allow: ["error", "warn", "debug", "info"] }],

      // `_`-prefixed names are the established opt-out for unused bindings.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],

      // `let x: T;` assigned once but read earlier in source order (inside a
      // closure defined above the assignment) cannot become `const`.
      "prefer-const": ["error", { ignoreReadBeforeAssign: true }],

      // Off deliberately. Every hit in this codebase was a defensive initializer
      // (`let ok = false;` before a try, `let info = null;` before an invoke)
      // whose value is provably unread only because the throwing path exits
      // early. Worse, it fires inside `scripts/lib/loc.mjs`, which CLAUDE.md
      // documents as a bug-for-bug port that must NOT be "fixed" — obeying the
      // rule there would silently break every historical LOC delta.
      "no-useless-assignment": "off",

      // ---- Off: React Compiler *migration* advisories -----------------------
      // These two don't report defects. They report that the React Compiler
      // could not take over memoization it found — useful only while adopting
      // the compiler, which this project has not started. Every hit was checked:
      // `use-memo`'s 5 were all one dependency list in TrackList.tsx ("expected
      // an array of simple expressions"), and `preserve-manual-memoization`'s 14
      // were manual `useMemo`/`useCallback` the compiler declined to preserve.
      // Nothing user-visible is at stake in either, so they were pure noise
      // against 380-odd other warnings. Turn them back on the day the compiler
      // is switched on — they are the adoption checklist.
      "react-hooks/preserve-manual-memoization": "off",
      "react-hooks/use-memo": "off",

      // ---- Warning backlog -------------------------------------------------
      // Real signal, but each is a class too large to clear in one pass. Counts
      // are post-cleanup; treat them as a ratchet, and don't add to them.
      //
      //   react-hooks/exhaustive-deps  149  Dominated by things that ARE stable
      //                                     but that the rule cannot prove:
      //                                     `restoredRef` (a ref arrives as a
      //                                     parameter), 41 citations of stable
      //                                     setters from usePersistedSetting,
      //                                     and whole hook objects (`playback`,
      //                                     `queueHook`, `plugins`) deliberately
      //                                     omitted in favour of latest-refs.
      //                                     There is no option to declare those
      //                                     stable, so this stays a warning.
      //   react-hooks/refs             113  See NO_REF_WRITE_IN_RENDER above —
      //                                     the write half is zero and
      //                                     error-gated. 95 of the rest are
      //                                     `playback.*` in App.tsx: the
      //                                     compiler treats property access on
      //                                     a hook object that also returns
      //                                     refs as a ref access. Measured with
      //                                     a probe: DESTRUCTURING the hook's
      //                                     return removes them entirely, so
      //                                     this is fixable at the source, not
      //                                     inherent noise. The other 18 are
      //                                     genuine render-phase ref reads.
      //   react-hooks/set-state-in-effect 75 Derive-state-in-effect. A real
      //                                     architectural backlog, kept visible.
      //   react-hooks/immutability      11  Mostly "accessed before declared"
      //                                     (function hoisting).
      //   react-hooks/purity             1  KEEP. Highest signal here: its two
      //                                     original hits were Math.random()
      //                                     during render, and one was a real
      //                                     bug (a "random" sort re-dealing on
      //                                     every memo recompute — now seeded,
      //                                     see useEntityDetail.seededRandom).
      //                                     The remaining one is benign.
      "react-hooks/refs": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/set-state-in-render": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/static-components": "warn",
      // `any` is rare and every production hit is a plugin-payload cast.
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },

  // Tests may assert on empty handlers, log freely, and stub components.
  {
    files: ["src/**/__tests__/**/*.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": "off",
      "no-console": "off",
      // A test fixture standing in for a plugin payload or a skin JSON blob is
      // where `any` is least harmful and most convenient.
      "@typescript-eslint/no-explicit-any": "off",
    },
  },

  // ---- Build / release scripts --------------------------------------------
  {
    files: ["scripts/**/*.mjs", "*.config.{js,ts}", "vite.config.ts"],
    extends: [js.configs.recommended],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // Scripts print to stdout as their whole job.
      "no-console": "off",
      "no-empty": ["error", { allowEmptyCatch: false }],
      "no-useless-assignment": "off", // see the note in the src/** block
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },

  // ---- E2E specs ----------------------------------------------------------
  {
    files: ["tests/**/*.{js,mjs,ts}"],
    extends: [js.configs.recommended],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      "no-console": "off",
      // Mock signatures must keep unused params to match the real API shape.
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
);
