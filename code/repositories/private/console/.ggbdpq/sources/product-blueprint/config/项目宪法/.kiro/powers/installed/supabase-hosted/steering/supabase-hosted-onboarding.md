# Prerequisites

Before using Supabase MCP, ensure the following are installed and running:
- Supabase CLI
- MCP

## Supabase CLI

You MUST refer to `supabase-cli.md` and follow setup before proceeding.

1. Verify CLI is installed
2. Verify CLI is logged in and linked to a project with `supabase projects list`
3. If CLI is not logged in, run `supabase login`
4. If CLI is logged in but no project is linked, ask which project the user wants to link to then run `supabase link --project-ref <id>`

## MCP

You MUST refer to `supabase-hosted-database-workflow.md` to understand MCP usage and setup.

# Initial setup checklist

1. Ensure Supabase CLI is installed
2. Ensure Supabase CLI is logged in and linked to a hosted project
3. Initialize a git repo with `git init` if not already within a repo
4. Generate a basic `.gitignore` if not already present with `npx gitignore node` (substitute preferred package manager runner)
5. Run `supabase init --yes` to initialize the project (creates `supabase/` directory)
6. Call MCP tools to get project URL and anon/publishable key
7. Create `.env.local` file with:
```
   NEXT_PUBLIC_SUPABASE_URL=<project url>
   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<anon or publishable key>
```

# Hooks setup

After initial setup you MUST refer to `supabase-hooks.md` and follow instructions to set up Kiro hooks.

# Troubleshooting

- MCP tools not available or connection fails: Instruct user to reconnect MCP server in Kiro's MCP Servers View (run "Kiro: Focus on MCP Servers View" from VS Code command palette) and follow the Supabase login flow in the browser