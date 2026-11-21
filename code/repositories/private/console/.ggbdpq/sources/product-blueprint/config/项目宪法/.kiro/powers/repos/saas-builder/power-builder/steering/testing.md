# Testing Your Kiro Power

This guide shows you how to test powers you're building before sharing them.

---

## Testing Workflow Overview

```
1. Create Power Directory in Workspace
   ↓
2. Write Power Files (POWER.md, mcp.json, steering/)
   ↓
3. Install Power Locally via Powers UI
   ↓
4. Test Power in Kiro
   ↓
5. Iterate and Fix
```

---

## Prerequisites: Power Files Should Already Exist

**Before testing, the following steps should have been completed using the interactive.md steering file:**

1. Power directory created in workspace: `{workspace}/powers/{power-name}/`
2. All power files generated:
   - POWER.md with frontmatter and documentation
   - mcp.json (if Guided MCP Power)
   - steering/ directory (if needed)

**If you haven't created the power files yet:**

```
Call action "readSteering" with powerName="power-builder", steeringFile="interactive.md"
```

Follow the interactive workflow to work with the user to create all necessary power files before proceeding with testing.

---

## Step 1: Install Power Locally

### Quick Local Testing

**This is the fastest way to test the power:**

**Step 1: Open Powers Panel**

Call action="configure" to open the Powers UI:
```
action="configure"
```

Or instruct the user to manually click the Powers icon in the Kiro sidebar.

**Step 2: Install from Local Directory**

Provide the user with the exact absolute path they should use:

**Tell the user:**
```
"In the Powers panel:
1. Click 'Add Custom Power' button at the top
2. Select 'Local Directory' option
3. Copy and paste this absolute path:

   {workspace}/powers/{power-name}

4. Click 'Add' to install"
```

Replace `{workspace}` with the actual workspace path and `{power-name}` with the actual power name.

**Example:**
If workspace is `/Users/john/projects/myapp` and power name is `weather-power`, tell the user:
```
"Use this path: /Users/john/projects/myapp/powers/weather-power"
```

**Step 3: Verify Installation**

- Power should appear in your "Installed Powers" list
- Status should show as "Active" or "Installed"

---

## Step 2: Test the Power with the User

The user should test the power in two ways to ensure it works correctly:

### 1. Try Power Button

On the power's detail page in the Powers UI, instruct the user to click the **"Try Power"** button to test the local power in a dedicated chat session.

### 2. New Agent Chat

Ask the user to also open a new agent chat to test the power with fresh context. This tests the power in a regular chat environment.

**Both testing methods are important** to verify the power works correctly in different contexts.

---

### Test Power Triggering

**Goal:** Test if the power triggers naturally for relevant user queries.

Ask the user to make natural language requests that should trigger the power based on its keywords and description:

**Example test queries:**
- If the power has keywords like ["release", "notes", "changelog"]:
  - User: "Generate release notes for version 2.0"
  - User: "Create a changelog from my recent commits"

- If the power has keywords like ["weather", "forecast"]:
  - User: "What's the weather in Seattle?"
  - User: "Get me a weather forecast"

**What to verify:**
- Agent activates the power for relevant queries
- Power documentation helps agent complete the task
- Workflow executes successfully

**If the power doesn't trigger:**
- Review the keywords in POWER.md frontmatter
- Ensure keywords match common user language
- Make description more specific about use cases
- Add 5-7 varied keywords that users might say

⚠️ **Warning About Broad Keywords:**

If the power triggers too often for unrelated queries:
- Keywords may be too broad or generic
- Broad keywords like "test", "api", "data", "help", "debug" cause false positives
- False positive activations annoy users and lead to uninstallation
- Use more specific, domain-focused keywords instead
- Example: Instead of "database", use "postgresql" or "mongodb"
- Example: Instead of "test", use "playwright" or "jest" or the specific tool name

### Test Actual Usage

Work with the user to test the power's main functionality with realistic requests:

**Expected workflow:**
- Agent activates power for relevant query
- Agent reads POWER.md documentation
- Agent calls action="use" with correct parameters (if Guided MCP Power)
- Operation succeeds

**If it fails:**
- Check error message returned
- Review the POWER.md documentation for accuracy
- Verify MCP tool names are exact matches (if applicable)
- Update documentation with clearer instructions

### Test Steering Files (if the power has them)

**Goal:** Test if steering files are read for scenarios that require them.

Ask the user to make requests that should trigger specific steering file usage:

**Example:**
- If power has `steering/advanced-automation.md`:
  - User: "Show me advanced automation patterns with this tool"
  - User: "What are some complex use cases?"

**What to verify:**
- Agent reads relevant steering file when needed
- Steering content helps agent provide better guidance
- Steering files load successfully

**If steering files aren't being read:**
- Ensure POWER.md references available steering files
- Make steering file descriptions clear in POWER.md
- Test with more specific queries that need steering guidance

---

## Step 6: Iterate and Fix

### Common Issues During Testing

#### Issue: "Power not found"
**Causes:**
- Directory doesn't have POWER.md
- POWER.md frontmatter has errors
- Path is incorrect

**Fix:**
1. Verify POWER.md exists with valid frontmatter
2. Check required fields: name, displayName, description
3. Ensure directory name matches `name` field
4. Verify the path provided is correct (absolute path)

#### Issue: "Tool 'tool_name' not found"
**Causes:**
- Tool name in documentation doesn't match actual MCP tool name
- Server name is wrong
- MCP server not installed in Kiro

**Fix:**
1. Test MCP server directly: `npx -y package-name`
2. List available tools using action="activate"
3. Update POWER.md with exact tool names
4. Guide user to update the power in Powers UI

#### Issue: "Invalid arguments for tool"
**Causes:**
- Parameter names wrong in documentation
- Parameter types wrong (string vs number)
- Missing required parameters

**Fix:**
1. Check MCP tool schema from action="activate" response
2. Update POWER.md with correct parameter names and types
3. Show complete examples with all required params

#### Issue: "Agent doesn't activate the power"
**Causes:**
- Description too vague
- Keywords not specific enough
- Power documentation unclear about use cases

**Fix:**
1. Make description more specific (what problem does it solve?)
2. Add 5-7 relevant keywords that match user queries
3. Add clear use case examples in POWER.md

#### Issue: "Agent can't follow the workflow"
**Causes:**
- Steps not clear in documentation
- Missing code examples
- No complete end-to-end example

**Fix:**
1. Add "Common Workflows" section with numbered steps
2. Show complete runnable examples with actual parameters
3. Add use case examples with real scenarios

### Iterating on the Power

When issues are found during testing:

1. **Edit files** in the workspace: `{workspace}/powers/{power-name}/`
2. **Update the power** manually (see Step 7 below)
3. **Test again** by working with the user to verify fixes

---

## Step 7: Updating Your Power

### For Powers Installed from Local Directory

When you make changes to power files:

1. Edit files in your workspace: `{workspace}/powers/power-name/`
2. Save your changes
3. **Manually update the power** (changes do NOT reflect automatically)

### How to Update the Power

To update the power after making changes:

1. **Open Powers UI:**
   - Call action="configure", or
   - Instruct the user to click Powers icon in sidebar

2. **Navigate to your power:**
   - Go to "Installed Powers" tab
   - Find your locally installed power
   - Click on the power tile to open details page

3. **Check for updates:**
   - On the power details page, click "Check for Updates" button
   - If updates detected, click "Update Power" button
   - System will reinstall from your local directory

**Note:** This compares your current directory files against the installed version.

### Testing After Updates

Always verify changes work by testing with the user:
- [ ] Call action="activate" with powerName - verify documentation updated
- [ ] Test main workflows still function correctly
- [ ] Test any new features or changes that were made
- [ ] Verify error handling still works

---

## Testing Checklist

Before considering the power complete, verify:

### Structure (Required)
- [ ] Directory name matches frontmatter name
- [ ] POWER.md exists with valid frontmatter
- [ ] mcp.json uses mcpServers format (if power has tools)
- [ ] No metadata in mcp.json (goes in POWER.md)

### Content Quality (Recommended)
These improve power quality but are not strictly required:
- Description is clear and concise (max 3 sentences)
- 5-7 relevant keywords included
- Overview explains what power does and why
- Tools documented with names and key parameters
- Workflow examples included
- Best practices section
- Troubleshooting guidance

### Testing with the User (Required)
- [ ] Power installs successfully from local directory
- [ ] Appears in Installed Powers list
- [ ] Agent activates power for relevant user requests
- [ ] Workflows complete successfully
- [ ] MCP tools work as documented (if applicable)

### Real Usage (Recommended)
Test thoroughly but not all are strictly required:
- Test with realistic user requests
- Verify complete workflow works end-to-end
- Check edge cases (empty results, missing data, errors)
- Test with different parameter values

---

## References

**Only read these resources if you need additional information or are doing advanced troubleshooting.** The documentation in this power should be sufficient for most power building and testing tasks.

### Kiro MCP Documentation
https://kiro.dev/docs/mcp/

Comprehensive documentation about MCP (Model Context Protocol) in Kiro, including:
- How MCP servers work in Kiro
- Configuration options
- Advanced troubleshooting

### Kiro Powers Documentation
https://kiro.dev/docs/powers/

Complete documentation about Kiro Powers, including:
- Power architecture and concepts
- Advanced power patterns
- Publishing and sharing powers

**Note:** Only consult these resources when the information in this power's documentation is insufficient for your needs.

