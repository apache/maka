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

# Architecture Document Quality Gate

Use this checklist before marking a draft or review complete. Treat items marked **Required** as release blockers when they apply.

## Purpose and narrative

- [ ] **Required:** The opening states the core question and why it matters.
- [ ] **Required:** The intended audience and scope can be inferred without reading the entire article.
- [ ] The document provides a useful answer at more than one reading depth.
- [ ] Central concepts are explained through intuition, scenario, mechanism, and boundary where needed.
- [ ] A concrete example is used when abstraction would otherwise impede understanding.
- [ ] Sections advance the core question instead of becoming a component inventory.

## Technical integrity

- [ ] **Required:** Current implementation is separated from Planned, Exploratory, Deprecated, and Historical material.
- [ ] **Required:** Important implementation claims were verified against appropriate evidence or explicitly marked unverified.
- [ ] **Required:** Responsibilities and non-responsibilities are clear.
- [ ] **Required:** Meaningful failure paths, interruption, and recovery behavior are covered.
- [ ] Relevant states, transitions, invariants, ordering, and idempotency rules are stated.
- [ ] Important design choices include alternatives, costs, and revisit conditions.
- [ ] Code, interface, schema, test, or observability anchors are provided at the depth the article promises.

## Diagrams and examples

- [ ] Every diagram answers a specific question.
- [ ] Diagram terminology matches prose and implementation terminology.
- [ ] Reading direction and important omissions are explained.
- [ ] Examples do not imply guarantees that the system does not provide.

## Bilingual parity

- [ ] **Required:** Both versions preserve scope, lifecycle status, certainty, guarantees, and limitations.
- [ ] **Required:** Canonical terms and code identifiers are consistent.
- [ ] Numbers, limits, states, ordering, examples, and failure behavior match.
- [ ] Each version reads naturally in its own language.
- [ ] Shared diagrams and links work from both versions.
- [ ] Counterpart metadata or translation status is accurate when used.

## Maintainability

- [ ] The document follows existing repository layout and metadata conventions.
- [ ] Ownership and verification date are recorded when supported.
- [ ] Fragile duplication and unstable line-number references are avoided.
- [ ] Details owned elsewhere are linked rather than copied.
- [ ] Known uncertainty or stale areas are visible to future maintainers.

## Completion report

When handing off a document, state:

- files created or changed;
- evidence used to verify current behavior;
- planned or uncertain claims that remain;
- whether both languages passed semantic parity review;
- any checklist items intentionally left open and why.
