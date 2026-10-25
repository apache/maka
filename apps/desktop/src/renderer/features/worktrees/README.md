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

# Worktrees

Worktrees owns the settings surface for Host and project configuration, Git checkout discovery,
initialization recovery and explicit cleanup. It renders each Host and expandable project without
changing session navigation groups. The production frame remains SettingsSurface.

- Consumers import the feature index. Host I/O enters through WorktreeServices.
- Desktop routing is confined to platform/desktop/create-worktree-services.ts.
- Git, durable operation identities, bindings and scripts belong to HostWorktreeManager on the
  execution Host. Renderer state never decides whether deletion or execution is permitted.
- Failed initialization supports retry and explicit skip. Failed cleanup requires a second,
  Host-issued confirmation before removal; cancel preserves the checkout.
- Requests are generation-fenced and mutations are single-flight per Host. Unmount fences UI
  updates and follow-up actions without claiming to cancel submitted Host work.

- Checkout status precedes the collapsed project configuration. Failed script output opens by
  default; loading and mutations show explicit progress, and long operations show elapsed time.
- Host discovery notifications and bounded, single-flight polling refresh checkout status while
  the page is open. Background refreshes preserve unsaved root and project configuration drafts.
- Settings lists and counts include only available, Maka-managed worktrees. Missing checkouts
  stay in the Host journal for fixed session bindings and can reappear when restored.
