Supabase CLI runs and interacts with Supabase stack locally.

CLI may be installed globally (e.g. with homebrew or scoop) or as a project dependency  (e.g. in "devDependency" with npm, pnpm, bun, etc.).
Prefer using it as a project dependency to keep CLI version pinned in your development environment.

# Package manager setup

To install or use CLI through a Node.js package manager, you must determine which package manager is desired for the project.

You MUST either:

- Determine the project's existing package manager by checking for popular lockfile formats (e.g. package-lock.json, yarn.lock, pnpm-lock.yaml, bun.lockb)
- Ask the user which package manager they prefer

# CLI setup

1. Determine the project's preferred package manager (see above)
2. Verify CLI is installed with `[prefix?] supabase --version` using appropriate package manager prefix if applicable
3. If CLI is not installed:
   1. Ensure `package.json` is initialized with the preferred package manager (e.g. `npm init -y`, `pnpm init`, etc.)
   2. Install `supabase` as a "devDependency"

**Note for pnpm:**

pnpm requires a manual `approve-builds` step (or approval via config) to generate the `.bin/supabase` entry.

Before installing with pnpm, add to `pnpm-workspace.yaml`:
```yaml
onlyBuiltDependencies:
  - supabase
```

# CLI invocation

For Node.js package managers, `supabase` commands MUST be prefixed with the package manager's command runner.
- npm: `npx supabase ...`
- pnpm: `pnpm supabase ...`
- bun: `bun supabase ...`

**IMPORTANT** Every time a bare `supabase` command is mentioned, consider which prefix is needed and add it accordingly.

# Troubleshooting 

For further troubleshooting, direct the user to: https://supabase.com/docs/guides/cli/getting-started
