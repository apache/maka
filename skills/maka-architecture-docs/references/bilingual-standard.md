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

# Maka Bilingual Documentation Standard

## Default publishing model

Maintain separate, complete Chinese and English documents. Give counterparts matching relative paths, filenames, or a shared stable `doc_id`. Reuse diagrams, code snippets, schemas, and other language-neutral assets.

Avoid paragraph-by-paragraph interleaving unless the user explicitly needs a side-by-side artifact. Interleaving makes both versions harder to read and maintain.

## Source and counterpart

Choose one source language for each editing cycle. Draft and technically verify that version first, then create the counterpart. The counterpart is an adaptation for readers in the target language, not a literal transliteration.

Both versions must preserve:

- the core question and scope;
- technical claims and their lifecycle status;
- degree of certainty;
- examples and identifiers;
- diagram semantics;
- decision rationale and trade-offs;
- warnings, limitations, and failure behavior.

Natural differences in sentence structure, section phrasing, and explanatory context are allowed. Do not add a technical claim to only one language version without intentionally updating or marking the other.

## Terminology

Maintain a project glossary with at least:

| Field | Meaning |
|---|---|
| Chinese term | Preferred Chinese name |
| English term | Canonical English name |
| Code identifier | Type, field, API, or package spelling when relevant |
| Definition | Language-neutral concept boundary |
| Avoid | Ambiguous or deprecated synonyms |

Preserve code identifiers exactly. On first use, introduce the counterpart when it helps recognition, for example `运行（Run）`; afterward, use the natural preferred term consistently.

Do not translate product names, protocol names, type names, or identifiers merely to make the prose look fully localized.

## Semantic parity checks

Compare the two versions by meaning rather than sentence count:

1. Do titles and summaries promise the same answer?
2. Do scope and exclusions match?
3. Are Current, Planned, Exploratory, Deprecated, and Historical labels identical in effect?
4. Are MUST, SHOULD, MAY, guarantees, and possibilities equally strong?
5. Do quantities, timeouts, limits, state names, and ordering rules match?
6. Are failure and recovery behaviors equally complete?
7. Do diagrams use terms recognized by both versions?
8. Do links resolve to the appropriate language or shared source?

Translation must not silently turn “may” into “will,” “planned” into “supported,” or “usually” into “always.”

## Suggested metadata

Use repository conventions first. When no convention exists, recommend metadata such as:

```yaml
doc_id: architecture.example
title: "Reader-oriented title"
language: zh-CN
source_language: zh-CN
counterpart: ./example.md
implementation_status: current
document_status: draft
translation_status: synced
last_verified: YYYY-MM-DD
owners:
  - maka-backend
```

Useful translation states are `synced`, `needs-update`, and `source-only`. Metadata is optional unless the project adopts it; semantic clarity is mandatory.

## Writing voice

In both languages:

- prefer direct, concrete sentences;
- explain necessary jargon at first use;
- write headings as reader-oriented signposts;
- avoid promotional claims and vague adjectives;
- retain the same technical altitude, even when one language needs extra connective explanation.

Chinese prose should read as native technical Chinese rather than English syntax with Chinese words. English prose should read as an original technical article rather than expose Chinese word order or omitted subjects.
