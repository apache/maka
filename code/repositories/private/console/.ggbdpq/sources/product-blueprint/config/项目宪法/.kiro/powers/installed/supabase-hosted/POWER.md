---
name: "supabase-hosted"
version: "0.1.0"
displayName: "Supabase Hosted Development"
description: "Build fullstack applications with Supabase's Postgres database, authentication, storage, and real-time subscriptions"
keywords: ["database", "postgres", "auth", "storage", "realtime", "backend", "supabase", "rls"]
---

# When to Load Steering Files

You MAY read multiple steering files if multiple topics are relevant.
You must ALWAYS read `supabase-cli.md` to understand how to invoke Supabase CLI.
You must ALWAYS read `supabase-hosted-database-workflow.md` to understand how to interact with the database through CLI and MCP.
**IMPORTANT** You CANNOT perform actions (MCP tools, reading/writing files) before reading relevant steering file(s).

In addition, consider these cases to read other steering files:

- First time setup and troubleshooting Supabase project configuration → `supabase-hosted-onboarding.md`
- Writing or formatting SQL code → `supabase-prompts-code-format-sql.md`
- Writing Supabase Edge Functions (TypeScript/Deno) → `supabase-prompts-edge-functions.md`
- Creating or modifying RLS policies → `supabase-prompts-database-rls-policies.md`
- Creating PostgreSQL functions → `supabase-prompts-database-functions.md`
- Setting up or modifying Next.js authentication with Supabase SSR → `supabase-prompts-nextjs-supabase-auth.md`
- Implementing realtime features (broadcast, presence, channels, subscriptions) → `supabase-prompts-use-realtime.md`

Available but less common:

- Working with declarative schema (`supabase/schemas/` directory) → `supabase-prompts-declarative-database-schema.md`
- Creating migration files manually (`supabase/migrations/` directory) → `supabase-prompts-database-create-migration.md`
