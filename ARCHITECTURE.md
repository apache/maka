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

# Architecture

[简体中文](ARCHITECTURE.zh-CN.md)

Maka assembles applications from plugins. A package declares what it provides and what it needs. A composition chooses instances and connects their imports to exports. Host services perform work; UI plugins contribute NSH components to the shared terminal and desktop workbench.

## Code ownership

[Platform](platform/README.md) contains the package loader, composition kernel, execution owners and renderers. [Plugins](plugins/README.md) contain business features and their declarations. [The Maka product](products/maka/README.md) selects packages, native factories and startup behavior.

A `package.ts` identifies an authored plugin. A Cargo crate identifies code compiled together. They need not correspond one-to-one: an Agent service can use several domain crates, while related plugin entries can share one native implementation crate.

The composition kernel models Host, UI and structural instances in one source. `host-js` executes JavaScript Host services through the existing background runtime. The [workbench](products/maka/workbench/README.md) runs trusted UI modules in its shared NSH VM; both shells supply the same Host bindings. NSH owns reactive layout, input and rendering. Shared fact types remain explicit dependencies where persistence or presentation needs them.

## From package to running application

1. The package loader validates immutable bytes and computes their reference.
2. The composition planner checks each Host, UI or structural node, its configuration and bindings.
3. A Root stores the desired source and its package bytes at a revision.
4. The Host reconciles enabled Host services. The workbench observes the same source and lazily loads enabled UI contributions when they are used.

Installation adds immutable packages to the available set; explicit UI nodes determine which contributions are enabled. User-installed UI plugins are trusted: they run in the workbench VM with its existing NSH and Host capabilities, without a separate plugin sandbox or permission workflow. Host admission still checks the caller, method, input and actual resources. Local IPC connections carry the launcher’s method and recovery grants.

Updating a source preserves unchanged activations and their captured bindings. Changed instances retire before replacement. Already accepted work remains with its original owner, including when the caller disconnects or a component disappears.

## State and effects

The EventLog owns the durable Root and canonical records. Stable plugin data belongs to a Root, deployment and instance. Package revisions and activation epochs describe code and execution; neither creates a new data namespace by itself.

Mutations have receipts. Business completion and physical cleanup are recorded separately. If a reply is lost, the caller resolves the original receipt instead of issuing a replacement operation. Cancellation asks work to stop; resources remain owned until their actual cleanup completes.

Desktop, terminal pixel rendering and terminal Unicode rendering run the same TSX/NSH workbench. UI modules contribute commands, panels, settings pages and tool renderers. The plugin contract depends on NSH, rather than GPUI or a terminal scene language; backend-specific native components remain a renderer concern.

A UI module is evaluated by immutable package identity and activated under an NSH reactive owner. Its visible components have their own lifetimes. Disabling an instance, changing its package or configuration, or removing it cleans up the activation and its contributions. Source revision changes that leave an instance unchanged do not reload it. NSH component cleanup releases subscriptions and timers; accepted Host work and mutation receipts remain with their original client owner. Native file snapshots and clipboard resource support live in [ui-support](platform/ui-support/README.md).

## Development and distribution

Each CLI build embeds the product bundle, and each workbench build embeds its TSX application. UI plugin source modules and assets use the existing immutable package installation and read paths, so installing or updating UI plugins does not require rebuilding the client. Rebuilding the executable does not replace an installation’s saved composition.

Rust contracts generate the [JavaScript SDK](packages/plugin-sdk/README.md) through [maka-schema](tools/schema/README.md), without building the product. The npm package is a [native executable launcher](packages/cli/README.md).
