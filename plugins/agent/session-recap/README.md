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

# maka-session-recap

[简体中文](README.zh-CN.md)

Generates and stores manual Session recaps through authorized history and model ports. The recap is derived data and leaves canonical history intact. Generation records an operation before calling the model; a repeated operation ID resolves that original request. An unknown result must not silently start a new paid request. Implementation and receipt handling live in `recap`.

The ordinary Agent service selects this domain with `recaps: true`. Its `recap` query reads the latest or one original cached receipt; `generateRecap` is an admitted mutation with an explicit model selection. The default product provides a Session recap panel with fee confirmation. The native adapter supplies only history reads and bounded generation, preserving session access and physical cleanup through cancellation.

[Source](src/lib.rs) · [Cargo manifest](Cargo.toml)
