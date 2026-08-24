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

# Maka Architecture Writing Standard

## Purpose

Use this standard to make each article approachable like a strong technical blog while retaining the precision required of an architecture record. It defines article-level quality, not a mandatory topic list or repository table of contents.

## Article contract

Before drafting, establish:

- **Core question:** the single question the article must answer.
- **Audience:** newcomer, active developer, technical lead, external integrator, or a deliberate combination.
- **Reading depth:** orientation, working understanding, or implementation/debugging depth.
- **Scope:** what the article covers and explicitly does not cover.
- **Evidence basis:** code, tests, schemas, runtime observation, accepted decision, or proposal.
- **Lifecycle status:** Current, Planned, Exploratory, Deprecated, or Historical.

A document may serve multiple depths through progressive disclosure, but it must identify its primary audience.

## Narrative model

Prefer this progression when it fits the subject:

1. **Problem:** what reader or system problem makes the subject matter.
2. **Intuition:** the simplest correct mental model.
3. **Concrete scenario:** one representative example that can continue through the article.
4. **Mechanism:** components, sequence, data, and state involved.
5. **Boundaries:** responsibilities, non-responsibilities, and interfaces.
6. **Failure behavior:** expected failures, recovery, partial success, and irrecoverable cases.
7. **Trade-offs:** benefits, costs, alternatives, and revisit conditions.
8. **Technical anchors:** code map, schemas, APIs, tests, telemetry, or operational signals.

Do not force this order when another narrative answers the core question more clearly. Do not start with a flat list of services unless the document's question is specifically about inventory or ownership.

## Four-layer explanation

For every concept central to the article, provide enough of these layers to prevent misunderstanding:

1. **Intuition:** what it means in plain language.
2. **Scenario:** why the system needs it.
3. **Mechanism:** how it works internally.
4. **Boundary:** what it does not mean or own.

Define a term before relying on it. Prefer one stable term over stylistic synonym variation.

## Precision rules

### Separate lifecycle states

- **Current:** verified in the current system.
- **Planned:** agreed direction not yet fully implemented.
- **Exploratory:** option under discussion, with no commitment implied.
- **Deprecated:** still present but being removed or replaced.
- **Historical:** retained only to explain past choices or migration context.

Label mixed-status sections at the claim or subsection level. A document-level status alone is insufficient when current behavior and future design appear together.

### Support claims with evidence

Use the strongest available evidence:

1. runtime behavior or passing tests;
2. implementation and schema;
3. accepted ADR or specification;
4. design discussion or roadmap;
5. author inference.

Identify inference as inference. If code and prose disagree, report the discrepancy rather than silently choosing the more convenient story.

### Describe state and invariants

When behavior depends on lifecycle or concurrency, name:

- states and valid transitions;
- ownership of each transition;
- durable versus ephemeral state;
- invariants that must remain true;
- idempotency or ordering expectations;
- interruption, retry, timeout, and cancellation behavior.

### Explain decisions

For meaningful choices, capture:

- context and constraints;
- chosen approach;
- credible alternatives;
- reason for the choice;
- benefits and costs;
- conditions that should trigger reevaluation.

Move long-lived, consequential choices into an ADR when the repository uses ADRs. The article may summarize and link to the decision.

## Examples and diagrams

Use a concrete example when it materially reduces abstraction. Keep the same example through multiple sections unless a second example reveals a distinct boundary.

Choose a diagram by the relationship being explained:

- context diagram for system boundaries;
- component diagram for responsibilities and dependencies;
- sequence diagram for interactions over time;
- state diagram for lifecycle and recovery;
- data-flow diagram for information movement;
- deployment diagram for runtime placement and infrastructure.

Every diagram must have a purpose statement. Explain its reading entry point and meaningful omissions. Keep names consistent with prose and code. Prefer shared, language-neutral diagram sources for bilingual documents.

## Progressive depth

Design for three reading passes where appropriate:

- **Opening:** the reader understands the conclusion and why it matters.
- **Main narrative:** the reader understands the end-to-end mechanism and boundaries.
- **Deep sections:** the reader can implement, extend, or debug the behavior.

Put essential meaning in prose. Tables, diagrams, and code snippets should clarify the prose rather than carry unexplained conclusions.

## Maintainability

- Prefer stable package, module, type, and interface links over fragile line-number references in committed documents.
- Record document owner and verification date when the repository supports metadata.
- Share diagrams and generated API/schema material between languages.
- Link rather than duplicate details owned by another document.
- Keep future direction separate enough that current behavior remains unambiguous.
- Update or mark stale documents when implementation changes invalidate claims.
