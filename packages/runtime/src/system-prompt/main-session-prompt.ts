/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/**
 * Shared main-session prompt assembly (#2352).
 *
 * Main-session system prompts used to be built only from functional fragments
 * (personalization, skills, AGENTS.md, memory, …) and never opened with a
 * product identity. This closes that gap while leaving sub-agent identities to
 * the agent catalog.
 *
 * The assembler is deliberately order-agnostic: it only prepends the shared
 * defaults, drops empty fragments, and joins. It does NOT impose a fixed
 * fragment order, because several fragments are position-semantic and must stay
 * where the host put them — e.g. the Side Chat isolation boundary and the Deep
 * Research mode contract are trailing assertions that constrain everything
 * before them, so moving them earlier weakens them. Each host keeps its existing
 * fragment order.
 *
 * The identity and response-format guidance are pure static text: constant
 * across turns, so they never churn the systemPromptHash / prefix-cache (see
 * request-shape.ts). They are intentionally NOT injected into sub-agent
 * (childInstruction) paths, which already carry their own role identities.
 */

/** Product identity line, prepended by the main-session assembler. */
function buildIdentityPromptFragment(): string {
  return "You are Maka, an AI agent operating on the user's machine. You help by reading files, running commands, editing code, and answering questions.";
}

function buildResponseFormatPromptFragment(): string {
  return `## Response format

Use GitHub-Flavored Markdown for responses.
Keep simple answers simple; do not add headings or lists to simple answers.
Use short headings and flat lists to organize longer answers.
Use fenced code blocks for multiline code and backticks for inline commands, paths, identifiers, and literal values.
Prefer descriptive link text for external sources when it is available.
Follow a more specific format requested by the user or task.`;
}

export function assembleMainSessionSystemPrompt(
  fragments: readonly (string | undefined)[],
): string {
  return [buildIdentityPromptFragment(), buildResponseFormatPromptFragment(), ...fragments]
    .filter((fragment): fragment is string => Boolean(fragment?.trim()))
    .join('\n\n');
}
