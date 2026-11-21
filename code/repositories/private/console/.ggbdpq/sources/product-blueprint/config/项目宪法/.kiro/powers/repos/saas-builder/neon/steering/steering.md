---
inclusion: manual
---

# Neon Database Get Started Guide

## Overview

This guide provides steps to help users get started with Neon in their project. It sets up their Neon project (with a connection string) and connects their database to their code by understanding the context within the codebase.

## Use Case

These guidelines apply when users say "Get started with Neon" or similar phrases. The user's codebase may be mature (with existing database connections) or have little to no code - the guidelines should apply to both cases.

## Communication Style

**Keep all responses succinct:**

- ✅ Tell the user what you did: "Created users table with 3 columns"
- ✅ Ask direct questions when needed: "Which database should I use?"
- ❌ Avoid verbose explanations of what you're about to do
- ❌ Don't explain every step unless the user asks

**Examples:**

- **Good**: "Added DATABASE_URL to .env. Ready to connect?"
- **Bad**: "I'm going to add the DATABASE_URL environment variable to your .env file so that your application can connect to the database. This will allow..."

---

## Get Started with Neon (Interactive Guide)

**TRIGGER PHRASE:** When the user says "Get started with Neon" or similar phrases, provide an interactive onboarding experience by following these steps:

**Before starting:** Let the user know they can pause and resume anytime by saying "Continue with Neon setup" if they need to come back later.

**RESUME TRIGGER:** If the user says "Continue with Neon setup" or similar, check what's already configured (MCP server, .env, dependencies, schema) and resume from where they left off. Ask them which step they'd like to continue from or analyze their setup to determine automatically.

### Step 1: Check Organizations and Projects

**First, check for organizations:**

Use the Neon MCP Server to check the user's organizations:

**If they have 1 organization:**

- Default to that organization automatically
- Proceed to check projects within that org

**If they have multiple organizations:**

- List all their organizations with names
- Ask: "Which organization would you like to use?"
- Confirm their selection before proceeding

**Then, check for existing projects:**

Use the Neon MCP Server to check if the user has existing projects within the selected organization. Then guide them based on what you find:

**If they have NO projects:**

- Ask if they want to create a new project
- Guide them to create one at console.neon.tech or help them do it via the MCP server

**If they have 1 project:**

- Show them the project name and ask: "Would you like to use '{project_name}' or create a new one?"
- If they choose existing project, proceed to Step 3
- If they want to create new, guide them accordingly

**If they have multiple projects (less than 6):**

- List all their projects with each name
- Ask which one they want to work on, OR
- Offer the option to create a new project
- Confirm their selection before proceeding

**If they have many projects (6+):**

- List project(s) created in the past 1 day (if any)
- Ask them if they want to use a project from the list (if any are there), create a new one or specify another project they want to use by name or ID

### Step 2: Branching (Neon's Unique Feature)

**Explain Neon branching:**

Let the user know: "Neon supports database branching - you can create isolated copies of your database for development, testing, or schema changes. This is perfect for safely experimenting with migrations before applying them to production."

**Check for existing branches:**

Use the MCP server to list available branches in their project.

**Ask the user:**

"Would you like to create a new branch or switch to an existing branch before making schema changes? This lets you test changes safely without affecting your main database."

**Options:**

1. **Use main branch** - Continue with the default production branch
2. **Create new branch** - Create a new branch (e.g., "dev", "migration-test") and switch to it
3. **Use existing branch** - Switch to an existing branch if they have multiple branches

**If they choose to create or switch branches:**

- Use the MCP server to create/switch to the branch
- Get the new connection string for the branch
- Update their `.env` with the branch connection string (or suggest using a separate env var like `DATABASE_URL_DEV`)

**If they stay on main:**

- That's fine - proceed to database setup
- Remind them they can create branches anytime for safe testing

### Step 3: Database Setup

**Get the connection string:**

- Use the MCP server to get the connection string for the selected project (or branch if they created/switched to one)

**Configure it for their environment:**

- Most projects use a `.env` file with `DATABASE_URL`
- For other setups (deployed platforms, containers, cloud configs), check their project structure and ask where they store credentials

**Before modifying .env:**

1. **Always try to read the .env file first** to check if `DATABASE_URL` already exists
2. If the file exists and is readable:
   - Use `search_replace` to update existing `DATABASE_URL`, or
   - Append new `DATABASE_URL` if it doesn't exist
3. If the file is unreadable (in .cursorignore/.gitignore) or you lack write permissions:
   - **DO NOT use the write tool** (it would overwrite the entire file)
   - Instead, run the append command: `echo "DATABASE_URL=postgresql://..." >> .env`
   - Or show them the exact line to add manually:

```
DATABASE_URL=postgresql://user:password@host/database
```

### Step 4: Install Dependencies

Check if the user already has a common driver installed. If not, based on their framework, environment and use case, recommend the appropriate driver and install it for the user. Keep the conversation focused.

**For Serverless/Edge (Vercel, Cloudflare Workers, etc.):**

```bash
npm install @neondatabase/serverless
```

**For Traditional Node.js:**

```bash
npm install pg
```

### Step 5: Understand the Project

**First, check if this is an empty/new project:**

- Look for existing source code, routes, components, or substantial application logic
- Check if it's just a bare package.json or minimal boilerplate

**If it's an empty or near-empty project:**

Ask the user briefly (1-2 questions):

- What are they building? (e.g., "a blog", "an API for a mobile app", "a SaaS dashboard")
- Any specific technologies they want to use? (e.g., "Next.js", "tRPC", "Express")

**If it's an established project:**

Skip the questions - you can infer what they're building from the existing codebase. Update any relevant code to use the driver you just installed to connect to their Neon database.

**Remember the context** (whether from questions or code analysis) for all subsequent MCP Server interactions and recommendations. However, stay focused on Neon setup - don't get sidetracked into other architectural discussions until setup is complete.

### Step 6: Schema Setup

**First, check for existing schema:**

Search the codebase for:

- SQL migration files (`.sql`, `migrations/` folder)
- ORM schemas (Prisma `schema.prisma`, Drizzle schema files, TypeORM entities)
- Database initialization scripts

**If they have existing schema:**

- Show them what you found
- Ask: "Found existing schema definitions. Want to migrate these to your Neon database?"
- If yes, help execute the migrations using the MCP server or guide them through their ORM's migration process

**If no existing schema found:**

Ask if they want to:

1. Create a simple example schema (users table)
2. Design a custom schema together
3. Skip schema setup for now

**If they choose (1):** Create a basic example users table using the MCP server:

```sql
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW()
);
```

**If they choose (2):** Ask them about their app's needs and help design tables. Then create the schema using the MCP server or guide them to create it via their ORM.

**If they choose (3):** Move on to Step 7. They can always come back to add schema later.

### Step 7: What's Next

Let them know you're ready to help with more:

"You're all set! Here are some things I can help with - feel free to ask about any of these (or anything else):

- Neon-specific features (branching, autoscaling, scale-to-zero)
- Connection pooling for production
- Writing queries or building API endpoints
- Database migrations and schema changes
- Performance optimization"

### Important Notes:

- Be succinct yet conversational and guide them step-by-step
- Know the context of the user's codebase before each step
- Provide working, tested code examples
- Check for errors in their existing setup before proceeding
- Don't give up - always at least give the user a way to complete the setup manually.

---

## Neon Database Best Practices

### Security

**Follow these security practices:**

1. Never commit connection strings to version control
2. Use environment variables for all database credentials
3. Prefer SSL connections (default in Neon)
4. Use least-privilege database roles for applications
5. Rotate API keys and passwords regularly

### Neon-Specific Features

**Leverage Neon's unique features:**

1. **Branching**: Create database branches for development/staging
2. **Autoscaling**: Neon automatically scales compute based on load
3. **Scale to Zero**: Databases automatically suspend after inactivity
4. **Point-in-Time Recovery**: Restore databases to any point in time

## Additional Resources

- [Neon Documentation](https://neon.com/docs)
- [Neon Serverless Driver](https://neon.com/docs/serverless/serverless-driver)
- [Neon API Reference](https://neon.com/docs/reference/api-reference)
- [Postgres Documentation](https://www.postgresql.org/docs)