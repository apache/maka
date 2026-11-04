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

# maka-decisions-api

[简体中文](README.zh-CN.md)

Structured decisions over the JEV and OpenAI Decisions protocols. The public model uses `input`, named questions, and Predicate / Choice / Score / Refusal answers. Private adapters encode provider requests and validate complete responses; provider metadata does not enter the public contract.

Settings explicitly select `protocol` (`jev` or `openai_decisions`), a complete endpoint URL, model and positive timeout. Defaults create a disabled JEV endpoint. For OpenRouter use `jev`, `https://openrouter.ai/api/v1/systemone`, and `~typesafe/jev-latest`; its Alpha Decisions endpoint also uses JEV, not OpenAI, payloads. For OpenAI use `openai_decisions`, `https://api.openai.com/v1/decisions`, and `gpt-6-luna`.

JEV preserves structured instructions, criteria and score legends. Boolean choice values are OpenAI-only; OpenAI requires text choice/score descriptions and supports at most 400 questions, 2–255 choices and 2–10 score levels. Unsupported inputs fail before dispatch; there is no implicit conversion, protocol detection, retry or fallback. Refusal is a per-question result. Score is the probability-weighted mean of level indices; confidence thresholds must be validated for the selected model.

Calls use scoped HTTP resources, endpoint-bound credentials and the caller's execution deadline. Cancellation, timeout, network failure and unconfirmed settlement can leave the remote outcome unknown. Complete JSON responses are buffered. Returned model IDs and provider probabilities are preserved; usage exposes input/output totals without adding their component counts.

[Source](src/lib.rs) · [Cargo manifest](Cargo.toml)
