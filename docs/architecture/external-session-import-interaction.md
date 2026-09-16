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

# External Session import interaction

## User contract

An explicit import creates a new, independent Maka Session snapshot. A source can be imported repeatedly. A successful import returns the exact new Session and opens it; an import does not start a model turn. Desktop and TUI show the number of currently published Maka Sessions imported from that source and may open the most recently created one.

If a dispatched import has an unknown outcome, the client says so without claiming success or failure, opening a possibly unrelated Session, or automatically repeating the request. The user may inspect the Maka Session list, open a published import shown by the external catalog, or explicitly import again. That new request may create another independent Session. A source with a Host-owned import currently in flight cannot start another import from the catalog; an already published import remains openable.

The source catalog and the Maka Session list are different views. Source rows identify external conversations. Maka Session rows identify published tasks. A newly imported old conversation need not appear first in the Maka list because that list is ordered by conversation activity, not import time.

## Authority and seams

| Obligation | Authority module | Interface and callers |
| --- | --- | --- |
| Source enumeration, conversion, commit, staging, recovery and per-source in-flight coalescing | Runtime Host external-session coordinator and source adapter | `external-session.catalog.query` and `external-session.import`; Desktop Main and TUI consume the outcomes |
| Imported count and recent Session IDs | Storage Session authority, queried by the Host | `lookupExternalSessionImports(adapterId, sourceSessionIds, limit)`; catalog projection exposes `importState` |
| Import outcome classification | Host operation result, with client transport dispatch evidence | Desktop Main maps Host/transport outcomes to IPC reasons; TUI reads the Host result/error |
| Desktop Session identity and navigation | Desktop preload and shell | Preload scopes Host Session IDs to the selected Host; renderer presents `importState` and requests shell navigation |
| TUI Session navigation | `MakaSessionDriver` | Runner calls the existing `switchSession(sessionId)` seam for both a fresh success and an already published import |
| Request-local warnings and action menus | Desktop import page and TUI runner | Presentation state only; neither client adds an unknown flag to the catalog or infers which request produced a catalog record |

Storage counts live, published Sessions whose immutable `externalOrigin` matches the adapter and source ID. Archived Sessions count; deleted and staged Sessions do not. The bounded recent-ID list is sorted by Maka Session creation time and can contain an import from another client. “Open latest” means exactly the first ID currently returned by the Host, not “open the result of my unknown request.”

## Client flows

Desktop keeps the existing separate row actions: **Open latest imported task** when an ID exists, and **Import** or **Import again** when the Host is not importing that source. A single or batch request with unknown outcome shows a warning for the request observed by that mounted page. Remounting the page reads the Host catalog; it does not revive an unknown lock. Batch results do not count unknown as success or definite failure.

TUI opens an unimported source directly through `external-session.import`. Selecting a source with a recent imported ID opens a small action menu: **Open latest imported task**, **Import again** when the Host is not already importing, and Esc to cancel. Opening uses the ID returned by the Host catalog and does not call import. A failed open reports that ID and leaves the user able to find it with `/session`; it does not start an import.

The Host retains its current in-flight coalescing, staged recovery, and typed error semantics. This interaction adds no protocol field, persistent client state, TTL, cache, or attempt-to-Session correlation. Automatic retry remains disallowed because an unknown request may already have created a task; a later explicit import is a new user operation with the documented independent-task outcome.

## Verification obligations

- Host and Storage tests own imported count, ordering, staging exclusion, recovery and in-flight coalescing.
- Desktop Main tests own unknown mapping and faithful catalog projection. Renderer tests own repeat eligibility, request-local warning, batch accounting and opening the Host-provided latest ID.
- TUI runner tests own direct first import, open versus repeat choice, unknown followed by an explicit repeat, Host in-flight exclusion, cancel and failed-open behavior. Copy tests own locale variable alignment.
