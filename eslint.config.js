// Flat ESLint config: typescript-eslint recommended, correctness only — no
// style rules (Prettier owns formatting).
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "state/", "runs/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // The engine logs operational output by design (CLI tool).
      "no-console": "off",
      // Zod-inferred shapes travel through a few deliberate `unknown` casts.
      "@typescript-eslint/no-explicit-any": "warn",
      // `catch (e)` + narrow-at-use is the repo's error idiom.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  },
);
