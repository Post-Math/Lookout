// Lint config — the recurrence-prevention gate. `eslint-plugin-obsidianmd`
// encodes the same rules the Obsidian plugin reviewer runs, so violations are
// caught locally and in CI instead of at submission/review time.
import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";

export default tseslint.config(
  {
    ignores: ["main.js", "main.js.map", "node_modules/**", "tests/**", "*.mjs"],
  },
  ...obsidianmd.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // User-facing strings are Korean by project convention (and the rule also
      // mis-fires on key names like "Esc"), so English sentence-case doesn't apply.
      "obsidianmd/ui/sentence-case": "off",
    },
  }
);
