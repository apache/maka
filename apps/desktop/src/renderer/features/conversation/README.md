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

# Conversation feature

Conversation owns runtime-only Session presentation state and the policies
that connect transcript identity to the Desktop bounded-range controller. Its
public API includes task-readiness presentation and a headless
`TranscriptReadingPositionController` component. That component owns bookmark
restoration, landmark refresh, and history navigation, while exposing explicit
capture, send preparation, and history commands to AppShell.

`LiveTurnReconciler` owns the handoff of every retained Turn's content to the
durable transcript. It subscribes to the whole buffer; selecting only the Host
execution root would miss late predecessor content. AppShell continues to use
the low-frequency summary for its chrome.

Successful send preparation publishes a one-shot viewport command through the
Session UI controller. The message surface forwards that port to ChatView,
where the scroll authority follows the tail. History catches up in the background
so local Message admission does not wait for it. Message growth and bookmark
updates do not replay the command; the range controller rejects stale catch-up results.
Accepted store updates reach the message surface through the existing transcript
projection; navigation completion only settles bookmark state.

Running Turns have no durable sequence in the RuntimeEvent transcript. Reading
intent therefore carries the Turn ID until persistence supplies its sequence;
later Turns must not displace it just because it began in the live projection.

The feature does not access the Desktop bridge. AppShell supplies bounded-range
and landmark ports plus current Session and controller identities; the feature
rejects stale completions against those identities. Session Navigation supplies explicit navigation intent
only; it does not own transcript state.
