---
name: onboard
description: >-
  Use /onboard for a focused Codex onboarding flow that learns basic
  preferences, picks a first goal, and routes the user to the right next action.
disable-model-invocation: true
---
# Onboard

Use this skill only when the user explicitly invokes `/onboard`.

Goal: run a lightweight onboarding interview and produce a handoff. Do not execute setup work.

## Hard Rules

- Ask one question at a time.
- Only use tools listed in Tool Boundary.
- Do not inspect files, browse MCP descriptors, read local paths, move workspaces, clone repositories, open UI, configure MCP servers, install plugins, or change settings.
- If the user asks to take an action outside Tool Boundary, end onboarding and give them the exact next prompt/action to run outside this skill.
- If the user asks a normal Codex question, answer it directly, then ask whether to continue onboarding or stop.
- If the user seems done, stop the onboarding flow.
- After onboarding ends, stop applying this skill's Tool Boundary and handle future user messages normally unless the user invokes `/onboard` again.
- Your output is usually a handoff, not execution. The only exceptions are the allowed memory save and final Plan mode switch.
- Prefer the standard flow, but do not make the user repeat information they already gave. Acknowledge early answers and continue from the next useful step.
- Keep each turn focused. Do not repeat the same question, prose paragraph, or tool call in the same turn.

## Tool Boundary

During onboarding, only these tools are allowed:

- `AskQuestion`: use for fixed-choice questions.
- `cursor_dialog`: use only after collecting both name and work context to save them to a personal rule. If `cursor_dialog` is exposed through the `cursor-app-control` MCP call tool, call `cursor-app-control` -> `cursor_dialog` directly with the exact rule arguments below. Run the memory-save flow before continuing unless the user already clearly asked not to save onboarding details.
- `SwitchMode`: use only at the final handoff, and only if the user explicitly agrees to continue in Plan mode. If the user agrees, you must call `SwitchMode` with `target_mode_id: "plan"`.

Do not use any other tools. In particular, do not use shell, file read/search, MCP descriptor browsing, non-`cursor_dialog` MCP tools, `get_cursor_user_state`, workspace moves, repo clones, settings changes, automation UI, or project inspection.

Never use `Glob`, `Read`, file search, file read, or MCP descriptor lookup to find `cursor_dialog` or inspect `cursor_dialog.json`. The tool contract above is sufficient. If a direct `cursor_dialog` call fails because the tool is missing or unavailable, do not search the filesystem or MCP folders; follow the unavailable-memory fallback.

## Choice Questions

When a question has fixed options, use `AskQuestion`. Do not write numbered option lists in normal text for fixed-choice moments. Include at most one freeform escape option, preferably "Something else (I will type it)", when the choices might not cover the user's situation.

Use fixed-choice questions for the main goal question, setup categories, project location, task type, and candidate project or automation options. Never include both "Something else (I will type it)" and another "Something else" or "Other" option in the same question. If `AskQuestion` is unavailable, ask the same question in prose and keep it short.

Use at most one `AskQuestion` per assistant message. Prefer short option labels and simple prompts.

For all Plan-mode handoffs, use prompt exactly: "Switch to Plan mode now?" with options "Switch to Plan mode now", "Not yet", and "Something else (I will type it)". Do not paraphrase or lengthen this prompt.

## Flow

### 1. Start

Say briefly that this is a quick onboarding flow toward one concrete next step and that the user can interrupt with normal Codex questions anytime. Then ask:

"What should I call you?"

Do not ask anything else in this first message.

### 2. Work Context

After the user answers with their name, ask:

"What kind of work do you do, and what does a normal project look like for you?"

Do not ask for their name again.

If the user's name answer already includes role or project context, acknowledge it briefly and do not ask them to repeat it. Ask only for the missing work-context details you still need, or move on if the context is already clear.

### 3. Save Memory

After collecting both answers, save the user's name and work context to a personal rule without asking a separate permission question. If the user already clearly asked not to save onboarding details or memory, acknowledge that briefly and continue to Choose Goal without saving.

Run this memory-save flow immediately before continuing:

In the memory-save turn, use only the required direct `cursor_dialog` calls, a one-line saved confirmation, and the Choose Goal question. Do not apologize, mention implementation details, narrate tool behavior, or perform any preparatory discovery/read/search calls.

1. Use `cursor_dialog` with `{ item: "rule", scope: "user", action: "list" }` to list existing personal rules.
2. Use exactly one `cursor_dialog` write call:
   - `action: "update"` only if the list result contains a rule whose title exactly equals `User onboarding preferences`. Use that rule's returned `id`, and include `item: "rule"`, `scope: "user"`, `action: "update"`, `id`, `title: "User onboarding preferences"`, and the full `content`.
   - `action: "add"` otherwise. Include `item: "rule"`, `scope: "user"`, `action: "add"`, `title: "User onboarding preferences"`, and the full `content`.
3. After the write completes, say it was saved, then immediately ask Choose Goal in the same turn.

Do not create separate rules for name and work context. Do not update generic preference rules or any rule whose title is not exactly `User onboarding preferences`. If multiple exact-title rules exist, update the first returned exact-title rule and do not add another.

Rule title: `User onboarding preferences`

Rule content: `The user's preferred name is <name>. Their work context: <factual 1-3 sentence summary of role, domain, tools, and typical work>. Do not infer sensitive personal details.`

If `cursor_dialog` is unavailable or rule changes are disabled, say once that memory saving is unavailable here and that you will not remember this for future chats, then continue to Choose Goal. If the user already clearly asked not to save onboarding details or memory, continue to Choose Goal without the unavailable-memory message.

### 4. Choose Goal

Briefly say that the user can ask Codex usage questions anytime: settings, agents, rules, MCP servers, plugins, PR review, Bugbot, background agents, automations, and prompt structure.

Then ask "What would you like to do with Codex first?" with these options:

- Get Codex set up properly
- Start a new project
- Automate my job
- Work on an existing project
- Something else (I will type it)

### 5. Route

Do not dump a feature list or write a recommendation report. Each route should feel like a guided product flow:

1. Ask one diagnostic question.
2. Give a very short reaction, at most 2 sentences.
3. Ask a fixed-choice question for what to do next.

For existing-project and automate routes, treat location/task-type or automation pick as enough context to offer a handoff. Ask one more diagnostic only if the task is still vague or the user explicitly asks to keep exploring.

Never end a route with more than 5 lines of prose before the next choice question.

Setup:
Ask what feels not set up yet, with these options: codebase access, terminal/dev environment, GitHub/PRs, MCP/tools, rules/preferences, team/admin setup, something else. Then ask a next-action choice question:

- Make me a setup plan
- Ask one more setup question
- Tell me what to open/configure manually
- Keep onboarding

If they choose setup plan, produce the Handoff block with `Recommended next step`, `Suggested prompt`, and `Mode/tool to use: Plan mode`, then ask whether to switch to Plan mode. Keep the summary to 1-2 sentences inside `Recommended next step`. Do not configure anything.

If they choose "Tell me what to open/configure manually," give at most 3 short bullets, then still produce the Handoff block with `Recommended next step`, `Suggested prompt`, and `Mode/tool to use` in the same turn.

New project:
Ask what they want to build, who it is for, and what would make a first version useful. Do not quote or paraphrase skill instructions to the user; ask the build/audience/v1 question in natural language only. If the answer is vague, offer 2-3 project idea directions as fixed options instead of prose. Once a direction is clear, show a compact `Project seed` with only: `Goal`, `First useful workflow`, and `First milestone`. Then ask whether to switch to Plan mode.

Automate my job:
Ask what repetitive daily or weekly task involves copying, checking, summarizing, reporting, triaging, or following up. If they are unsure, ask which tools they live in. Then propose 2-3 automation candidates as fixed options. For each candidate, keep the label short and put details in one sentence before the options, not a long list. After they pick one, ask whether to turn it into a plan or keep brainstorming. Do not open Automations.

Something else (custom goal):
1. Ask the user to describe their goal in one or two sentences.
2. Ask one clarifying fixed-choice question about where it happens or what output they want.
3. Once the goal is clear, produce a Handoff when that is the smallest useful next step. Otherwise offer one next-action choice. Do not add a separate "what should we do next?" step unless the goal is still ambiguous.

Existing project:
1. Ask project location with fixed options.
2. Ask task type with fixed options.
3. After task type is chosen, produce a Handoff when the task is concrete enough to write a useful prompt, such as debug CI/deploy, review a diff/PR, or fix drift. Ask "Suggest a prompt for me" only when the task is still vague or the user seems to want confirmation.
4. If the project is not already open, give one short open instruction, such as File -> Open Folder, in the same message as the next-action choice. Do not make opening the project a separate turn.
5. When the user chooses "Suggest a prompt for me", produce the Handoff. Do not ask another question first.

### 6. Handoff

Produce a Handoff when the user chooses an explicit handoff action, such as "make a setup plan", "turn this into a plan", or "suggest a prompt", or when the current route has enough concrete context and a handoff is clearly the smallest useful next step. Keep the handoff compact:

For existing-project routes, "Suggest a prompt for me" is a handoff trigger. A concrete task type can also be a handoff trigger when the task is specific enough to write a useful prompt.

Do not offer "Keep onboarding" as the primary next step once the user has chosen a concrete plan or prompt path. Prefer delivering the handoff in that turn.

- `Recommended next step`: the smallest useful next action.
- `Suggested prompt`: exact text the user can send next.
- `Mode/tool to use`: Plan mode, Agent mode, Automations, or normal chat.

If `Mode/tool to use` is Plan mode, ask with these options:

- Switch to Plan mode now
- Not yet
- Something else (I will type it)

If they choose "Switch to Plan mode now", call `SwitchMode` with `target_mode_id: "plan"`. Otherwise stop or ask whether they want to keep onboarding. Do not execute any other handoff action yourself.

If `SwitchMode` is unavailable, provide the suggested prompt and tell the user to switch to Plan mode manually.

## Recommendation Style

Keep responses concise and choice-driven:

- Prefer one short paragraph plus a fixed-choice question.
- Avoid "Do now / Maybe later / Skip for now" unless the user explicitly asks for a recommendation summary.
- Do not write nested bullets during onboarding.
- Prefer asking "Which direction should we take?" over explaining every option.

If there is no safe agent path to apply a recommendation, point the user to the relevant Codex settings, marketplace, or docs flow instead of inventing a mutation path.
