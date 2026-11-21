---
name: curl-command-generator
description: Generates ready-to-run cURL commands from Express, Next.js, Fastify, or other API routes. Creates copy-paste commands with proper headers, authentication, and request bodies. Use when users request "generate curl commands", "curl examples", "api curl", or "command line api testing".
---

# cURL Command Generator

Generate ready-to-run cURL commands for quick API testing from the command line.

## Core Workflow

1. **Scan routes**: Find all API route definitions
2. **Extract metadata**: Methods, paths, params, bodies
3. **Generate commands**: Create cURL commands with flags
4. **Add authentication**: Bearer, Basic, API Key headers
5. **Include examples**: Request bodies with sample data
6. **Output options**: Markdown, shell script, or plain text

## Basic cURL Syntax

```bash
# GET request
curl -X GET "http://localhost:3000/api/users"

# POST with JSON body
curl -X POST "http://localhost:3000/api/users" \
  -H "Content-Type: application/json" \
  -d '{"name": "John", "email": "john@example.com"}'

# With authentication
curl -X GET "http://localhost:3000/api/users" \
  -H "Authorization: Bearer YOUR_TOKEN"

# With query parameters
curl -X GET "http://localhost:3000/api/users?page=1&limit=10"

# Show response headers
curl -i -X GET "http://localhost:3000/api/users"

# Verbose output
curl -v -X GET "http://localhost:3000/api/users"
```

## Generator Script

````typescript
// scripts/generate-curl.ts
import * as fs from "fs";

interface RouteInfo {
  method: string;
  path: string;
  name: string;
  description?: string;
  body?: object;
  queryParams?: { name: string; value: string }[];
  auth?: boolean;
}

interface CurlOptions {
  baseUrl: string;
  authHeader?: string;
  verbose?: boolean;
  showHeaders?: boolean;
  format?: "markdown" | "shell" | "plain";
}

function generateCurlCommand(route: RouteInfo, options: CurlOptions): string {
  const parts: string[] = ["curl"];

  // Add flags
  if (options.verbose) {
    parts.push("-v");
  }
  if (options.showHeaders) {
    parts.push("-i");
  }

  // Method
  parts.push(`-X ${route.method}`);

  // URL with query params
  let url = `${options.baseUrl}${route.path}`;

  // Replace path params with placeholders
  url = url.replace(/:(\w+)/g, "{$1}");

  // Add query params
  if (route.queryParams?.length) {
    const queryString = route.queryParams.map((p) => `${p.name}=${p.value}`).join("&");
    url += `?${queryString}`;
  }

  parts.push(`"${url}"`);

  // Headers
  if (["POST", "PUT", "PATCH"].includes(route.method)) {
    parts.push('-H "Content-Type: application/json"');
  }

  if (route.auth && options.authHeader) {
    parts.push(`-H "${options.authHeader}"`);
  }

  // Request body
  if (route.body && ["POST", "PUT", "PATCH"].includes(route.method)) {
    const bodyJson = JSON.stringify(route.body);
    parts.push(`-d '${bodyJson}'`);
  }

  return parts.join(" \\\n  ");
}

function generateCurlCommands(routes: RouteInfo[], options: CurlOptions): string {
  const lines: string[] = [];

  if (options.format === "markdown") {
    lines.push("# API cURL Commands");
    lines.push("");
    lines.push(`Base URL: \`${options.baseUrl}\``);
    lines.push("");
  } else if (options.format === "shell") {
    lines.push("#!/bin/bash");
    lines.push("");
    lines.push(`BASE_URL="${options.baseUrl}"`);
    lines.push('AUTH_TOKEN="${AUTH_TOKEN:-your-token-here}"');
    lines.push("");
  }

  // Group by resource
  const groupedRoutes = groupRoutesByResource(routes);

  for (const [resource, resourceRoutes] of Object.entries(groupedRoutes)) {
    if (options.format === "markdown") {
      lines.push(`## ${capitalize(resource)}`);
      lines.push("");
    } else if (options.format === "shell") {
      lines.push(`# ${capitalize(resource)}`);
      lines.push("");
    }

    for (const route of resourceRoutes) {
      if (options.format === "markdown") {
        lines.push(`### ${route.name}`);
        if (route.description) {
          lines.push(route.description);
        }
        lines.push("");
        lines.push("```bash");
      } else {
        lines.push(`# ${route.name}`);
      }

      lines.push(generateCurlCommand(route, options));

      if (options.format === "markdown") {
        lines.push("```");
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

function groupRoutesByResource(routes: RouteInfo[]): Record<string, RouteInfo[]> {
  const groups: Record<string, RouteInfo[]> = {};

  for (const route of routes) {
    const parts = route.path.split("/").filter(Boolean);
    const resource = parts[0] || "api";

    if (!groups[resource]) {
      groups[resource] = [];
    }
    groups[resource].push(route);
  }

  return groups;
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
````

## Complete Example Output (Markdown)

````markdown
# API cURL Commands

Base URL: `http://localhost:3000/api`

## Authentication

### Login

```bash
curl -X POST "http://localhost:3000/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email": "user@example.com", "password": "password123"}'
```
````

### Register

```bash
curl -X POST "http://localhost:3000/api/auth/register" \
  -H "Content-Type: application/json" \
  -d '{"name": "New User", "email": "new@example.com", "password": "securepass123"}'
```

## Users

### List Users

```bash
curl -X GET "http://localhost:3000/api/users?page=1&limit=10" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Get User by ID

```bash
curl -X GET "http://localhost:3000/api/users/{id}" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Create User

```bash
curl -X POST "http://localhost:3000/api/users" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{"name": "John Doe", "email": "john@example.com", "role": "user"}'
```

### Update User

```bash
curl -X PUT "http://localhost:3000/api/users/{id}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{"name": "John Updated", "email": "john.updated@example.com"}'
```

### Delete User

```bash
curl -X DELETE "http://localhost:3000/api/users/{id}" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

````

## Shell Script Output

```bash
#!/bin/bash
# api-commands.sh

BASE_URL="${BASE_URL:-http://localhost:3000/api}"
AUTH_TOKEN="${AUTH_TOKEN:-your-token-here}"

# Authentication

# Login
login() {
  curl -X POST "${BASE_URL}/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"email\": \"$1\", \"password\": \"$2\"}"
}

# Users

# List Users
list_users() {
  local page="${1:-1}"
  local limit="${2:-10}"
  curl -X GET "${BASE_URL}/users?page=${page}&limit=${limit}" \
    -H "Authorization: Bearer ${AUTH_TOKEN}"
}

# Get User by ID
get_user() {
  curl -X GET "${BASE_URL}/users/$1" \
    -H "Authorization: Bearer ${AUTH_TOKEN}"
}

# Create User
create_user() {
  curl -X POST "${BASE_URL}/users" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${AUTH_TOKEN}" \
    -d "$1"
}

# Update User
update_user() {
  curl -X PUT "${BASE_URL}/users/$1" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${AUTH_TOKEN}" \
    -d "$2"
}

# Delete User
delete_user() {
  curl -X DELETE "${BASE_URL}/users/$1" \
    -H "Authorization: Bearer ${AUTH_TOKEN}"
}

# Usage examples:
# ./api-commands.sh
# login user@example.com password123
# list_users 1 10
# get_user abc123
# create_user '{"name": "John", "email": "john@example.com"}'
# update_user abc123 '{"name": "John Updated"}'
# delete_user abc123

# Execute command if provided
if [ -n "$1" ]; then
  "$@"
fi
````

## Advanced cURL Flags

```bash
# Common useful flags
curl -X GET "http://localhost:3000/api/users" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TOKEN" \
  -i                              # Include response headers
  -v                              # Verbose output
  -s                              # Silent mode (no progress)
  -S                              # Show errors in silent mode
  -o response.json                # Save response to file
  -w "\n%{http_code}\n"           # Print status code
  --connect-timeout 5             # Connection timeout
  --max-time 30                   # Max request time
  -L                              # Follow redirects
  -k                              # Skip SSL verification (dev only)

# Pretty print JSON response
curl -s "http://localhost:3000/api/users" | jq .

# Save cookies and use them
curl -c cookies.txt -b cookies.txt "http://localhost:3000/api/auth/login"

# Upload file
curl -X POST "http://localhost:3000/api/upload" \
  -H "Authorization: Bearer TOKEN" \
  -F "file=@./document.pdf"

# Form data
curl -X POST "http://localhost:3000/api/form" \
  -d "name=John&email=john@example.com"

# With timing info
curl -X GET "http://localhost:3000/api/users" \
  -w "\nDNS: %{time_namelookup}s\nConnect: %{time_connect}s\nTotal: %{time_total}s\n"
```

## Environment-Specific Commands

```bash
# .env.curl
# Development
DEV_URL="http://localhost:3000/api"
DEV_TOKEN=""

# Staging
STAGING_URL="https://staging-api.example.com"
STAGING_TOKEN=""

# Production
PROD_URL="https://api.example.com"
PROD_TOKEN=""
```

```bash
#!/bin/bash
# curl-env.sh

set -a
source .env.curl
set +a

ENV="${1:-dev}"

case $ENV in
  dev)
    BASE_URL="$DEV_URL"
    AUTH_TOKEN="$DEV_TOKEN"
    ;;
  staging)
    BASE_URL="$STAGING_URL"
    AUTH_TOKEN="$STAGING_TOKEN"
    ;;
  prod)
    BASE_URL="$PROD_URL"
    AUTH_TOKEN="$PROD_TOKEN"
    ;;
esac

export BASE_URL AUTH_TOKEN
echo "Using $ENV environment: $BASE_URL"
```

## CLI Script

```typescript
#!/usr/bin/env node
// scripts/curl-gen.ts
import * as fs from "fs";
import { program } from "commander";

program
  .name("curl-gen")
  .description("Generate cURL commands from API routes")
  .option("-f, --framework <type>", "Framework type", "express")
  .option("-s, --source <path>", "Source directory", "./src")
  .option("-o, --output <path>", "Output file", "./docs/api-curl.md")
  .option("-b, --base-url <url>", "Base URL", "http://localhost:3000/api")
  .option("--format <type>", "Output format (markdown|shell|plain)", "markdown")
  .option("-v, --verbose", "Include verbose flag")
  .parse();

const options = program.opts();

async function main() {
  const routes = await scanRoutes(options.framework, options.source);

  const content = generateCurlCommands(routes, {
    baseUrl: options.baseUrl,
    authHeader: "Authorization: Bearer YOUR_TOKEN",
    verbose: options.verbose,
    format: options.format,
  });

  fs.writeFileSync(options.output, content);
  console.log(`Generated ${options.output} with ${routes.length} commands`);
}

main();
```

## Makefile Integration

```makefile
# Makefile
BASE_URL ?= http://localhost:3000/api
AUTH_TOKEN ?= your-token-here

.PHONY: api-login api-users api-user api-create-user

api-login:
	@curl -X POST "$(BASE_URL)/auth/login" \
		-H "Content-Type: application/json" \
		-d '{"email": "$(EMAIL)", "password": "$(PASSWORD)"}'

api-users:
	@curl -X GET "$(BASE_URL)/users" \
		-H "Authorization: Bearer $(AUTH_TOKEN)"

api-user:
	@curl -X GET "$(BASE_URL)/users/$(ID)" \
		-H "Authorization: Bearer $(AUTH_TOKEN)"

api-create-user:
	@curl -X POST "$(BASE_URL)/users" \
		-H "Content-Type: application/json" \
		-H "Authorization: Bearer $(AUTH_TOKEN)" \
		-d '$(DATA)'

# Usage:
# make api-login EMAIL=user@example.com PASSWORD=pass123
# make api-users AUTH_TOKEN=xxx
# make api-user ID=123 AUTH_TOKEN=xxx
# make api-create-user DATA='{"name":"John"}' AUTH_TOKEN=xxx
```

## Best Practices

1. **Use variables**: Replace tokens and IDs with placeholders
2. **Pretty print**: Pipe to `jq` for readable JSON output
3. **Save responses**: Use `-o` to save responses for analysis
4. **Check status**: Use `-w "%{http_code}"` to see status codes
5. **Silent mode**: Use `-sS` for scripts to hide progress
6. **Document examples**: Include realistic sample data
7. **Version control**: Commit curl docs to repository
8. **Environment files**: Use env files for different environments

## Output Checklist

- [ ] All routes converted to cURL commands
- [ ] Path parameters use `{param}` placeholder syntax
- [ ] Query parameters included in URL
- [ ] Request bodies with sample JSON data
- [ ] Content-Type header for POST/PUT/PATCH
- [ ] Authorization header with placeholder token
- [ ] Commands grouped by resource
- [ ] Output in requested format (markdown/shell/plain)
- [ ] Proper escaping for shell special characters
