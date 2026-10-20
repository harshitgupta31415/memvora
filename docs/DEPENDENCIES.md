# Dependency decisions

The root `package-lock.json` records the installed dependency graph. Install with `npm ci` after changing machines; review updates deliberately rather than using a forced audit fix. Node 24 is the baseline, with Node 26 also allowed by the starter.

## Web lint preset

The generated Next.js lint preset was replaced with TypeScript ESLint and React's official recommended Hooks rules during setup. On 21 October 2026, `eslint-config-next@16.4.2` pulled `fast-glob` → `micromatch` → `braces@3.0.3`. The [upstream advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) listed no patched braces version. No incompatible override or framework downgrade was applied.

This means Next-specific lint rules are not currently enabled. TypeScript, React Hooks lint, behavior tests, and the production Next.js build remain required checks. Reconsider the official framework lint preset when its transitive dependency is patched. React's [plugin configuration](https://github.com/facebook/react/tree/main/packages/eslint-plugin-react-hooks#flat-config-eslintconfigjsts) documents the chosen recommended rules.

Before introducing an integration, check its installed version and primary documentation. Keep any token or provider configuration in local environment files or a platform credential store. The starter does not need production credentials.
