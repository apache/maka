---
name: "neon"
displayName: "Build a database with Neon"
description: "Serverless Postgres with database branching, autoscaling, and scale-to-zero - perfect for modern development workflows"
keywords: ["neon", "postgres", "database", "serverless", "branching", "sql", "postgresql"]
author: "Neon"
---

# Neon Database Power

## Overview

Neon is a serverless Postgres platform with unique features like database branching, autoscaling, and scale-to-zero. This power provides complete access to Neon's MCP server for managing projects, branches, databases, and executing SQL queries.

**Key capabilities:**
- **Database Branching**: Create isolated copies of your database for development, testing, or schema changes
- **Project Management**: Create and manage Neon projects and organizations
- **Schema Management**: Execute SQL queries, create tables, and manage database schema
- **Connection Strings**: Get connection strings for any project or branch
- **Serverless Features**: Automatic scaling and scale-to-zero for cost efficiency

**Perfect for:**
- Setting up new projects with Neon Postgres
- Creating development/staging branches for safe testing
- Managing database schema and migrations
- Building serverless applications with Postgres
- Testing schema changes before production deployment

**No API keys required** - Authentication handled through Neon CLI or browser login.

## Available Steering Files

This power has the following steering files:
- **steering** - Interactive "Get Started with Neon" guide for onboarding users step-by-step

## Available MCP Servers

### neon
**Package:** `mcp-remote` + `https://mcp.neon.tech/mcp`
**Connection:** Remote MCP server via npx

**Tools:**

1. **list_organizations** - List all Neon organizations the user has access to
   - No parameters required
   - Returns: Array of organizations with id, name, and metadata

2. **list_projects** - List all projects in an organization
   - Required: `org_id` (string) - Organization ID
   - Returns: Array of projects with id, name, region, and creation date

3. **create_project** - Create a new Neon project
   - Required: `org_id` (string) - Organization ID
   - Required: `name` (string) - Project name
   - Optional: `region` (string) - AWS region (default: auto-selected)
   - Returns: Project details including connection string

4. **get_connection_string** - Get connection string for a project or branch
   - Required: `project_id` (string) - Project ID
   - Optional: `branch_id` (string) - Branch ID (defaults to main branch)
   - Optional: `database_name` (string) - Database name (defaults to main database)
   - Optional: `role_name` (string) - Database role (defaults to project owner)
   - Returns: PostgreSQL connection string

5. **list_branches** - List all branches in a project
   - Required: `project_id` (string) - Project ID
   - Returns: Array of branches with id, name, parent, and creation date

6. **create_branch** - Create a new database branch
   - Required: `project_id` (string) - Project ID
   - Required: `name` (string) - Branch name
   - Optional: `parent_id` (string) - Parent branch ID (defaults to main)
   - Returns: Branch details including connection string

7. **execute_sql** - Execute SQL query on a database
   - Required: `project_id` (string) - Project ID
   - Required: `query` (string) - SQL query to execute
   - Optional: `branch_id` (string) - Branch ID (defaults to main)
   - Optional: `database_name` (string) - Database name
   - Returns: Query results with rows and metadata

## Tool Usage Examples

### Listing Organizations

**Get all organizations:**
```javascript
usePower("neon", "neon", "list_organizations", {})
// Returns: [{ id: "org-abc123", name: "My Company", ... }]
```

### Managing Projects

**List projects in an organization:**
```javascript
usePower("neon", "neon", "list_projects", {
  "org_id": "org-abc123"
})
// Returns: Array of projects with names, IDs, regions
```

**Create a new project:**
```javascript
usePower("neon", "neon", "create_project", {
  "org_id": "org-abc123",
  "name": "my-app-production",
  "region": "us-east-1"
})
// Returns: Project details with connection string
```

### Getting Connection Strings

**Get connection string for main branch:**
```javascript
usePower("neon", "neon", "get_connection_string", {
  "project_id": "proj-xyz789"
})
// Returns: "postgresql://user:pass@host.neon.tech/dbname"
```

**Get connection string for specific branch:**
```javascript
usePower("neon", "neon", "get_connection_string", {
  "project_id": "proj-xyz789",
  "branch_id": "br-dev-456"
})
// Returns: Connection string for dev branch
```

### Database Branching

**List all branches:**
```javascript
usePower("neon", "neon", "list_branches", {
  "project_id": "proj-xyz789"
})
// Returns: [{ id: "br-main", name: "main" }, { id: "br-dev", name: "dev" }]
```

**Create a development branch:**
```javascript
usePower("neon", "neon", "create_branch", {
  "project_id": "proj-xyz789",
  "name": "feature-new-schema",
  "parent_id": "br-main"
})
// Returns: New branch details with connection string
```

### Executing SQL

**Create a table:**
```javascript
usePower("neon", "neon", "execute_sql", {
  "project_id": "proj-xyz789",
  "query": `
    CREATE TABLE users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      name VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW()
    );
  `
})
// Returns: Query execution result
```

**Query data:**
```javascript
usePower("neon", "neon", "execute_sql", {
  "project_id": "proj-xyz789",
  "query": "SELECT * FROM users WHERE created_at > NOW() - INTERVAL '7 days'"
})
// Returns: { rows: [...], rowCount: 5 }
```

## Combining Tools (Workflows)

### Workflow 1: Complete Project Setup

```javascript
// Step 1: Get user's organizations
const orgs = usePower("neon", "neon", "list_organizations", {})
const orgId = orgs[0].id

// Step 2: Create new project
const project = usePower("neon", "neon", "create_project", {
  "org_id": orgId,
  "name": "my-new-app",
  "region": "us-east-1"
})

// Step 3: Get connection string
const connString = usePower("neon", "neon", "get_connection_string", {
  "project_id": project.id
})

// Step 4: Create initial schema
usePower("neon", "neon", "execute_sql", {
  "project_id": project.id,
  "query": `
    CREATE TABLE users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      name VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW()
    );
  `
})

// Result: Project ready with connection string and schema
```

### Workflow 2: Safe Schema Migration with Branching

```javascript
// Step 1: Create a migration branch from main
const branch = usePower("neon", "neon", "create_branch", {
  "project_id": "proj-xyz789",
  "name": "migration-add-users-table",
  "parent_id": "br-main"
})

// Step 2: Test schema changes on branch
usePower("neon", "neon", "execute_sql", {
  "project_id": "proj-xyz789",
  "branch_id": branch.id,
  "query": `
    ALTER TABLE users ADD COLUMN last_login TIMESTAMP;
    CREATE INDEX idx_users_last_login ON users(last_login);
  `
})

// Step 3: Test queries on branch
const testResults = usePower("neon", "neon", "execute_sql", {
  "project_id": "proj-xyz789",
  "branch_id": branch.id,
  "query": "SELECT * FROM users WHERE last_login IS NULL"
})

// Step 4: If tests pass, apply to main branch
usePower("neon", "neon", "execute_sql", {
  "project_id": "proj-xyz789",
  "branch_id": "br-main",
  "query": `
    ALTER TABLE users ADD COLUMN last_login TIMESTAMP;
    CREATE INDEX idx_users_last_login ON users(last_login);
  `
})
```

### Workflow 3: Multi-Environment Setup

```javascript
// Step 1: Get main project connection
const prodConn = usePower("neon", "neon", "get_connection_string", {
  "project_id": "proj-xyz789"
})

// Step 2: Create development branch
const devBranch = usePower("neon", "neon", "create_branch", {
  "project_id": "proj-xyz789",
  "name": "development"
})

// Step 3: Create staging branch
const stagingBranch = usePower("neon", "neon", "create_branch", {
  "project_id": "proj-xyz789",
  "name": "staging"
})

// Step 4: Get connection strings for each environment
const devConn = usePower("neon", "neon", "get_connection_string", {
  "project_id": "proj-xyz789",
  "branch_id": devBranch.id
})

const stagingConn = usePower("neon", "neon", "get_connection_string", {
  "project_id": "proj-xyz789",
  "branch_id": stagingBranch.id
})

// Result: Three isolated environments with separate connection strings
// Add to .env: DATABASE_URL_PROD, DATABASE_URL_STAGING, DATABASE_URL_DEV
```

### Workflow 4: Database Seeding Across Branches

```javascript
// Step 1: List all branches
const branches = usePower("neon", "neon", "list_branches", {
  "project_id": "proj-xyz789"
})

// Step 2: Seed data on development branch
const devBranch = branches.find(b => b.name === "development")

usePower("neon", "neon", "execute_sql", {
  "project_id": "proj-xyz789",
  "branch_id": devBranch.id,
  "query": `
    INSERT INTO users (email, name) VALUES
      ('alice@example.com', 'Alice'),
      ('bob@example.com', 'Bob'),
      ('charlie@example.com', 'Charlie');
  `
})

// Step 3: Verify data
const results = usePower("neon", "neon", "execute_sql", {
  "project_id": "proj-xyz789",
  "branch_id": devBranch.id,
  "query": "SELECT COUNT(*) as user_count FROM users"
})
```

## Best Practices

### ✅ Do:

- **Use database branching** for development and testing before production changes
- **Create separate branches** for each feature or migration
- **Test schema changes** on branches before applying to main
- **Store connection strings** in environment variables (.env file)
- **Use SSL connections** (enabled by default in Neon)
- **Leverage autoscaling** - Neon automatically scales compute based on load
- **Take advantage of scale-to-zero** - databases suspend after inactivity to save costs
- **Use point-in-time recovery** for production databases
- **Name branches descriptively** (e.g., "feature-auth", "migration-v2")
- **Delete old branches** after merging to keep projects clean

### ❌ Don't:

- **Commit connection strings** to version control
- **Skip testing on branches** - always test migrations before production
- **Use main branch for experiments** - create a branch instead
- **Hardcode credentials** in application code
- **Forget to update .env** after creating new branches
- **Run destructive queries** without testing on a branch first
- **Ignore region selection** - choose regions close to your users
- **Create too many unused branches** - clean up after merging
- **Use weak database passwords** - Neon generates strong ones by default

## Troubleshooting

### Error: "Organization not found"
**Cause:** Invalid organization ID or user doesn't have access
**Solution:**
1. Call `list_organizations` to get valid org IDs
2. Verify you're authenticated with Neon CLI
3. Check organization permissions in Neon console

### Error: "Project not found"
**Cause:** Invalid project ID or project doesn't exist
**Solution:**
1. Call `list_projects` with correct org_id to see available projects
2. Verify project ID format (starts with "proj-")
3. Check if project was deleted

### Error: "Branch not found"
**Cause:** Invalid branch ID or branch doesn't exist in project
**Solution:**
1. Call `list_branches` to see available branches
2. Verify branch ID format (starts with "br-")
3. Check if branch was deleted or merged

### Error: "SQL execution failed"
**Cause:** Invalid SQL syntax or database permissions issue
**Solution:**
1. Verify SQL syntax is valid PostgreSQL
2. Check if table/column names exist
3. Ensure database role has necessary permissions
4. Test query on a branch first before running on main

### Error: "Connection string invalid"
**Cause:** Malformed connection string or missing parameters
**Solution:**
1. Use `get_connection_string` to get fresh connection string
2. Verify all required parameters (project_id at minimum)
3. Check if branch_id is valid if specified
4. Ensure connection string includes all parts: postgresql://user:pass@host/db

### Error: "Cannot create branch"
**Cause:** Invalid parent branch or project limits reached
**Solution:**
1. Verify parent_id exists using `list_branches`
2. Check Neon plan limits for number of branches
3. Delete unused branches to free up quota
4. Ensure project is not in suspended state

### Error: "Region not available"
**Cause:** Specified region doesn't exist or isn't supported
**Solution:**
1. Use auto-region selection (omit region parameter)
2. Check Neon docs for available regions
3. Common regions: us-east-1, us-west-2, eu-central-1, ap-southeast-1

### Error: "Authentication failed"
**Cause:** Not logged in to Neon or session expired
**Solution:**
1. Run `neonctl auth` to login via CLI
2. Or authenticate via browser when prompted by MCP server
3. Check if Neon CLI is installed: `npm install -g neonctl`

## Configuration

**Authentication:** Neon MCP server handles authentication automatically through:
- Neon CLI login (if installed)
- Browser-based OAuth flow
- No manual API keys required

**Setup Steps:**
1. Install Neon CLI (optional): `npm install -g neonctl`
2. Login via CLI: `neonctl auth` (or authenticate via browser when prompted)
3. Power is ready to use - no additional configuration needed

**Connection Strings:**
- Store in `.env` file as `DATABASE_URL`
- For multiple environments, use: `DATABASE_URL_DEV`, `DATABASE_URL_STAGING`, `DATABASE_URL_PROD`
- Never commit `.env` to version control

**Recommended Drivers:**

For serverless/edge environments:
```bash
npm install @neondatabase/serverless
```

For traditional Node.js:
```bash
npm install pg
```

For connection pooling:
```bash
npm install @neondatabase/serverless
# Includes built-in connection pooling
```

## PostgreSQL Features

Neon supports full PostgreSQL compatibility:

**Data Types:**
- Standard types: INTEGER, VARCHAR, TEXT, BOOLEAN, TIMESTAMP, JSON, JSONB
- Arrays: INTEGER[], TEXT[]
- UUID, SERIAL, BIGSERIAL
- Custom types and enums

**Advanced Features:**
- Full-text search with tsvector
- JSON/JSONB queries and indexing
- Window functions and CTEs
- Triggers and stored procedures
- Foreign keys and constraints
- Partial and expression indexes

**Extensions:**
- pgvector for vector similarity search
- PostGIS for geospatial data
- pg_trgm for fuzzy text matching
- uuid-ossp for UUID generation

## Tips

1. **Start with branching** - Create a dev branch before making any schema changes
2. **Use descriptive names** - Name projects and branches clearly (e.g., "my-app-prod", "feature-auth")
3. **Test migrations safely** - Always test on a branch before applying to main
4. **Leverage scale-to-zero** - Development branches automatically suspend to save costs
5. **Check existing projects** - Use `list_projects` before creating new ones
6. **Get fresh connection strings** - Use `get_connection_string` instead of hardcoding
7. **Clean up branches** - Delete merged or unused branches to stay organized
8. **Use regions wisely** - Choose regions close to your application servers
9. **Automate with CI/CD** - Use Neon API for automated deployments and migrations
10. **Monitor usage** - Check Neon console for compute and storage metrics

---

**Package:** `mcp-remote` + Neon MCP Server  
**Source:** Official Neon  
**License:** MIT  
**Connection:** Remote MCP server with OAuth authentication
