# MCP (Hosted)

Supabase hosts an MCP server on `https://mcp.supabase.com/mcp`.

Options may configured with additional query parameters:
- `read_only`: Used to restrict the server to read-only queries and tools. Recommended by default.
- `project_ref`: Used to scope the server to a specific project. Recommended by default. If you omit this, the server will have access to all projects in your Supabase account.
- `features`: Used to specify which tool groups to enable.

Depending on which options the user has configured, tool behavior may vary. Refer the user to our MCP docs if they need help configuring these.

Tools executing using this server affect the hosted Supabase project(s), and changes can be synced to the filesystem using Supabase CLI.

Although you're working in a local editor, prefer development using this hosted Supabase instance and use Supabase CLI to sync changes to the local `supabase/` folder.

The user will likely have linked their Supabase CLI to a development project.
You can find the linked project ref in `supabase/.temp/project-ref`, use this as the `project_id` in MCP tool calls.

# Schema managament

To update tables:

1. Call MCP `list_tables` to inspect the current schema
2. Call `apply_migration` with desired changes
3. Call MCP `get_advisors` to find and fix "security" and "performance" issues as needed with further migrations
4. Sync new migration(s) to `supabase/migrations/` locally with `supabase migration fetch --yes`
5. Generate updated types and review codebase to align usage

Assume the hosted database is the source of truth for migration history, and use CLI to sync changes to the local workspace.

# Type generation

While iterating on the schema, you should generate updated types with `supabase gen types --linked`. This outputs to stdio, so use `>` to redirect to a file.

# Troubleshooting

- Frontend error `Could not find the '<column>' column of '<table>' in the schema cache`: Update types + implementation to ensure code matches current schema
- No project ref: Run `supabase link` to link the workspace to a hosted development project
- Data not appearing in app: Run `supabase db diff --linked`. If schema drift exists run `supabase db pull <migration_name> --yes` to store changes in a new local migration and repair remote migration history. Then proceed to update types and usage.