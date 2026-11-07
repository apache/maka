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

# maka-web

[简体中文](README.zh-CN.md)

Implements Web fetch and search through scoped network capabilities. `fetch` and `search` own content policy; `settings` manages provider configuration; `provide` registers the Host factory. It can run in a Host composition without an Agent engine.

`probe` supports process health checks: send HEAD, fall back once to GET only for 405/501, never follow redirects or read the response body, and wait for response cleanup. It requires its own network authorization; retrieval settings and search credentials do not control endpoint probes. Permission wait is included in elapsed time. HTTP 2xx is healthy, 3xx is unknown, and 4xx/5xx is unhealthy; denied or failed requests report an unknown endpoint.

Fetch preserves complete extracted text. Redirects stop on an actual repeated target. Documents outside the recursive readability adapter's supported shape, or whose readability extraction fails, return the complete original HTML as text. Parser workers retain their native permits through completion; scoped response cleanup and transport idle/connect deadlines remain. Search retains complete returned titles/snippets and the caller's selected result count within Tavily's documented 20-result endpoint range.

[Source](src/lib.rs) · [Cargo manifest](Cargo.toml)
