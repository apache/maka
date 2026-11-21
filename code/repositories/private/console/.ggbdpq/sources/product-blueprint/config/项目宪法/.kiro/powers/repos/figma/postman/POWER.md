---
name: "postman"
displayName: "API Testing with Postman"
description: "Automate API testing and collection management with Postman - create workspaces, collections, environments, and run tests programmatically"
keywords: ["postman", "api", "testing", "collections", "rest", "http", "automation"]
author: "Postman"
---

# Onboarding

Before proceeding, validate that the user has completed the following steps before using this power.

## Step 1

Prompt the user to configure their own Postman API key for authentication. They can either set it as an environment variable named POSTMAN_API_KEY on their system, or hardcode it directly into the user level MCP configuration file (usually at ~/.kiro/settings/mcp.json) in the power section. To obtain an API key, they log into their Postman account, navigate to Settings → API Keys, and generate a new key with appropriate permissions for workspace, collection, and environment management. The key will be automatically used by the MCP server to authenticate all API requests to Postman's services.

## Step 2

Create a hook that runs anytime the source code or configuration file has been changed. Save the hook in .kiro/hooks/hookname.kiro.hook. Example hook format. Please update the patterns to match the project's file structure.

```json
{
  "enabled": true,
  "name": "API Postman Testing",
  "description": "Monitors API source code changes across multiple programming languages and automatically runs Postman collection tests to validate functionality",
  "version": "1",
  "when": {
    "type": "fileEdited",
    "patterns": [
      "*.js",
      "*.ts",
      "*.py",
      "*.java",
      "*.cs",
      "*.go", 
      "*.rs",
      "*.php",
      "*.rb",
      "*.kt",
      "*.swift",
      "*.scala",
      "package.json",
      "requirements.txt",
      "Pipfile",
      "pom.xml",
      "build.gradle",
      "*.csproj",
      "go.mod",
      "Cargo.toml",
      "composer.json",
      "Gemfile",
      "build.sbt",
      "openapi.yaml",
      "openapi.yml",
      "swagger.yaml",
      "swagger.yml",
      "api.yaml",
      "api.yml"
    ]
  },
  "then": {
    "type": "askAgent",
    "prompt": "API source code or configuration has been modified. Please retrieve the contents of the .postman.json file. If the file does not exist or is empty, create a Postman collection for the API. If it exists, get the collection ID and run the collection, showing me the results and propose fixes for any errors found."
  }
}
```
# Overview

Automate API testing and collection management with Postman. Create workspaces, collections, environments, and run tests programmatically.

**Authentication**: Requires Postman API key (Settings → API Keys at postman.com)

## Available MCP Servers

### postman
**Package:** `@postman/postman-mcp-server`
**Connection:** SSE-based MCP server
**Authentication:** Postman API key via Bearer token
**Mode:** Minimal (40 essential tools) - Default configuration
**Endpoint:** https://mcp.postman.com/minimal

**Note:** This power connects to Postman's hosted MCP server via SSE. To enable Full mode (112 tools) for advanced collaboration and enterprise features, change the URL to `https://mcp.postman.com/full`.

**Available Tools (40 in Minimal Mode):**

**Workspace Management:**
- `createWorkspace` - Create a new workspace
- `getWorkspace` - Get workspace details
- `getWorkspaces` - List all accessible workspaces
- `updateWorkspace` - Update workspace properties

**Collection Management:**
- `createCollection` - Create a new API collection
- `getCollection` - Get detailed collection information
- `getCollections` - List all collections in a workspace
- `putCollection` - Replace/update entire collection
- `duplicateCollection` - Create a copy of a collection
- `createCollectionRequest` - Add a request to a collection
- `createCollectionResponse` - Add a response example to a request

**Environment Management:**
- `createEnvironment` - Create a new environment
- `getEnvironment` - Get environment details
- `getEnvironments` - List all environments
- `putEnvironment` - Replace/update entire environment

**Mock Server Management:**
- `createMock` - Create a mock server
- `getMock` - Get mock server details
- `getMocks` - List all mock servers
- `updateMock` - Update mock server configuration
- `publishMock` - Make mock server public

**API Specification Management:**
- `createSpec` - Create a new API specification
- `getSpec` - Get specification details
- `getAllSpecs` - List all specifications
- `getSpecDefinition` - Get complete spec definition
- `updateSpecProperties` - Update spec metadata
- `createSpecFile` - Add a file to a spec
- `getSpecFile` - Get a specific spec file
- `getSpecFiles` - List all files in a spec
- `updateSpecFile` - Update a spec file

**Code Generation & Sync:**
- `generateCollection` - Generate collection from API spec
- `generateSpecFromCollection` - Generate spec from collection
- `getGeneratedCollectionSpecs` - Get specs generated from a collection
- `getSpecCollections` - Get collections generated from a spec
- `syncCollectionWithSpec` - Sync collection with its spec
- `syncSpecWithCollection` - Sync spec with its collection

**Testing & Execution:**
- `runCollection` - Execute a collection with automated tests

**User & Metadata:**
- `getAuthenticatedUser` - Get current user information
- `getTaggedEntities` - Get entities by tag
- `getStatusOfAnAsyncApiTask` - Check async task status
- `getEnabledTools` - List available tools by mode

## Tool Usage Examples

```javascript
// Create workspace
mcp_postman_createWorkspace({
  "workspace": { "name": "My API Project", "type": "personal" }
})

// Create collection
mcp_postman_createCollection({
  "workspace": "workspace-id",
  "collection": {
    "info": {
      "name": "User API",
      "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"
    }
  }
})

// Create environment
mcp_postman_createEnvironment({
  "workspace": "workspace-id",
  "environment": {
    "name": "Local",
    "values": [
      { "key": "base_url", "value": "http://localhost:3000", "enabled": true }
    ]
  }
})

// Run collection
mcp_postman_runCollection({
  "collectionId": "collection-id",
  "environmentId": "environment-id"
})
```

## Workflows

**Project Setup:**
```javascript
const { workspace } = await mcp_postman_createWorkspace({ "workspace": { "name": "Project", "type": "personal" }})
const { collection } = await mcp_postman_createCollection({ "workspace": workspace.id, "collection": { "info": { "name": "API", "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" }}})
const { environment } = await mcp_postman_createEnvironment({ "workspace": workspace.id, "environment": { "name": "Local", "values": [{ "key": "base_url", "value": "http://localhost:3000", "enabled": true }]}})
// Save IDs to .postman.json
```

**Generate from OpenAPI:**
```javascript
const { spec } = await mcp_postman_createSpec({ "workspaceId": "workspace-id", "name": "API Spec", "type": "OPENAPI:3.0", "files": [{ "path": "openapi.yaml", "content": "..." }]})
const result = await mcp_postman_generateCollection({ "specId": spec.id, "elementType": "collection", "name": "Generated Collection" })
```

**Automated Testing:**
```javascript
const { workspaces } = await mcp_postman_getWorkspaces()
const { collections } = await mcp_postman_getCollections({ "workspace": workspaces[0].id })
const { environments } = await mcp_postman_getEnvironments({ "workspace": workspaces[0].id })
for (const collection of collections) {
  await mcp_postman_runCollection({ "collectionId": collection.uid, "environmentId": environments[0]?.id })
}
```

## Best Practices

- Store workspace/collection/environment IDs in `.postman.json`
- Use environment variables for different contexts (local/staging/production)
- Add post-request test scripts for validation
- Organize requests in folders
- Run collections before deployment
- Ensure API server is running before tests

## Troubleshooting

**"Collection not found"**: Call `getCollections` to verify ID and permissions

**"Environment not found"**: Call `getEnvironments` with correct workspace ID

**Test failures**: Verify API server running, check environment variables (base_url, api_key), review test scripts

**"Invalid API key"**: Generate new key at postman.com Settings → API Keys, verify permissions

## Configuration

**MCP Configuration (Minimal mode - 40 tools):**
```json
{
  "mcpServers": {
    "postman": {
      "url": "https://mcp.postman.com/minimal",
      "headers": {
        "Authorization": "Bearer ${POSTMAN_API_KEY}"
      }
    }
  }
}
```

**Full mode (112 tools):** Change URL to `https://mcp.postman.com/full`

**API Key Permissions:** Workspace management, collection read/write, environment read/write, collection runs
