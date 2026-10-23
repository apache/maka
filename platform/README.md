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

# Platform

[简体中文](README.zh-CN.md)

The platform loads packages, checks compositions, owns execution resources and presents committed UI frames. Product features live in [plugins](../plugins/README.md).

| Area | Crates |
| --- | --- |
| Declarations and package bytes | [plugin-core](plugin-core/README.md), [packages](packages/README.md) |
| Resource authority and persistence | [capabilities](capabilities/README.md), [event-log](event-log/README.md) |
| Service and component owners | [host-runtime](host-runtime/README.md), [ui-runtime](ui-runtime/README.md) |
| JavaScript execution | [js-runtime](js-runtime/README.md), [host-js](host-js/README.md), [ui-js](ui-js/README.md) |
| Native presentation | [presentation](presentation/README.md) |
| I/O and isolation | [network](network/README.md), [process](process/README.md), [sandbox](sandbox/README.md), [computer-use](computer-use/README.md) |
| Connections and health | [transport](transport/README.md), [background-health](background-health/README.md) |

Host and UI share the plugin lifecycle kernel. Optional execution adapters run JavaScript plugins. The [workbench](../products/maka/workbench/README.md) is an NSH application that connects through public Host services; the [terminal shell](../products/maka/terminal-shell/README.md) renders it in a terminal and the [desktop shell](../products/maka/desktop-shell/README.md) in a window.

The dependency boundary is deliberate: Host and UI lifecycle crates can compile without V8 or the Agent engine. Some platform code still depends on shared Agent facts for storage and presentation. Those data dependencies are visible in the Cargo manifests.
