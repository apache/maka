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

# Replace the composer view

[简体中文](README.zh-CN.md)

This compact UI package contributes `composer` with the public `maka.composer` view contract. Its source imports only NSH and SDK types. It receives the selected session's draft, upload actions, queue/send/stop actions and original receipt recovery from the conversation plugin. The conversation plugin retains state and mutation ownership while this package renders the input. Model and pending interaction views arrive through the contract's `models` and `request` slots.

Copy these files together and use Node.js 26 with a Maka executable that supports the view contract:

```sh
node build.mjs --output ./composer-build --maka /path/to/maka
```

The output directory must be new. The helper invokes `maka application build-ui`, stages its module and assets into `composer-build/plugin`, writes the declaration and prints the exact inspected package reference. Type imports disappear during UI compilation; this example requires no runtime SDK package or repository source imports.

Install the resulting package into the current deployment and add an enabled UI instance, for example `example-composer`. Point the conversation UI instance's `configuration.values.composer` at it:

```json
{ "path": ["example-composer"], "id": "composer" }
```

Retain the current source revision, unrelated instances, bindings and instance UUIDs when applying that change. The selected application root stays the same. The example has no Host service or service imports. See the authoring skill's runtime UI guide for installing packages and committing a checked source.

The sample demonstrates a different input layout, stable native attachment picker ownership, upload/send receipt recovery, guarded asynchronous paste/drop and live draft edits. Its local selection and IME state are disposable; it creates no second draft, model subscription, history watch or send journal. The bundled composer additionally provides skill/file/command completion, sandbox selection, MCP consent and the queue editor. Add the corresponding controls through the supplied session facade when extending this example.

Mount `attachments.renderPicker` as a component, as shown by `const Picker = session.attachments.renderPicker; <Picker ... />`. Calling it as a reactive child expression would replace the native picker when its props change and lose its selected-path owner.
