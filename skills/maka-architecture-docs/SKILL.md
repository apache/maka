---
name: maka-architecture-docs
description: Draft, restructure, translate, or review bilingual Chinese-English architecture documentation for the Maka Agent backend. Use when Codex works on Maka technical narratives, component or mechanism explanations, architecture decisions, system flows, engineering guides, or documentation quality checks and needs blog-like clarity without losing architectural precision. Do not use it to impose a fixed topic list or information architecture unless the user asks for one.
---
<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# Maka Architecture Docs

Create architecture documentation that is easy to enter, technically rigorous, and maintainable in both Chinese and English. Treat the user's chosen subject and document organization as constraints; this skill governs writing quality, evidence, bilingual consistency, and review.

## Select the task mode

- **Draft**: create a new document from code, design notes, interviews, or a user brief.
- **Rewrite**: improve an existing document while preserving its technical meaning.
- **Translate**: produce a natural counterpart in the other language, not a sentence-by-sentence transliteration.
- **Review**: identify concrete gaps in clarity, evidence, correctness, or bilingual consistency.
- **Standardize**: align multiple documents on terminology, metadata, status labels, and structure without forcing them into identical narratives.

Confirm the intended mode from the request. Infer it when safe; ask only when different interpretations would materially change the output.

## Follow the workflow

1. **Establish the article contract.** State the one core question, intended reader, expected reading depth, source language, and claimed implementation status. Do not invent a topic or replace the user's outline.
2. **Collect evidence.** Inspect the relevant code paths, tests, schemas, configuration, ADRs, and existing documents before presenting implementation details as facts. Separate verified behavior from plans and interpretation.
3. **Build the narrative.** Move from problem and intuition to a concrete scenario, then mechanism, boundaries, failures, and trade-offs. Include only the sections that help answer the core question.
4. **Add technical anchors.** Connect claims to real components, state transitions, invariants, interfaces, observability signals, or code locations as appropriate.
5. **Create the bilingual counterpart.** Preserve concepts, status, examples, diagrams, and section identity while rewriting naturally for the target language.
6. **Run the quality gate.** Review both language versions against `references/quality-gate.md`. Fix failed required checks before calling the document complete.

Read `references/writing-standard.md` whenever drafting, rewriting, or standardizing architecture content. Read `references/bilingual-standard.md` whenever creating or reviewing both languages. Use `assets/article-template.md` as a starting scaffold only when it fits the chosen subject; remove irrelevant sections rather than filling them mechanically.

## Apply non-negotiable rules

- Start from a reader question or engineering problem, not a component inventory.
- Distinguish **Current**, **Planned**, **Exploratory**, **Deprecated**, and **Historical** claims.
- Never present an unverified design assumption as current implementation.
- Explain important mechanisms through intuition, scenario, mechanism, and boundary.
- Cover meaningful failure paths and trade-offs, not only the happy path.
- Keep diagrams purposeful and language-neutral where practical; explain what each diagram includes and omits.
- Use stable terms. Do not alternate among synonyms for variety when they represent the same Maka concept.
- Prefer separate, complete Chinese and English documents with shared assets over interleaved paragraph-by-paragraph translation.
- Preserve uncertainty. Translation must not strengthen or weaken a claim.
- Optimize for progressive depth: a reader should gain value from the opening summary without reading the entire article.

## Handle reviews

Lead with actionable findings ordered by impact. Cite the exact section or line when possible. Check, in order:

1. factual correctness and status confusion;
2. missing boundaries, invariants, or failure behavior;
3. broken narrative or unexplained concepts;
4. bilingual semantic drift and terminology inconsistency;
5. maintainability issues such as duplicated diagrams or unstable code references;
6. style polish.

If there are no material findings, say so and identify any verification limits.

## Deliver artifacts

When creating files, follow the repository's existing documentation layout. If no convention exists, recommend rather than silently establish a new repository-wide structure. Keep language counterparts at matching relative paths or give them stable shared document IDs. Report which technical claims were verified and which remain planned or uncertain.
