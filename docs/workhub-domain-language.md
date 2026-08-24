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

# WorkHub domain language

WorkHub gives users one conversational place to continue, create, and inspect work while ordinary Sessions remain the product's canonical work records.

## Terms

**Session**: The authoritative record for identity, transcript, execution state, permissions, interactions, and recovery. A Session ID is the stable identity of the work.

**Work**: The user-facing continuity of exactly one ordinary Session. “Work” is a product-language view of a Session, not a second stored record.

**WorkHub**: A projection and routing surface over ordinary Sessions. It may keep transient inference context while mounted, but it does not own a transcript or execution state.

**Session projection**: A rebuildable view derived from Session facts for display and routing. It can be discarded and recreated without losing work.

**Route correction**: A user's decision that an input belongs to a different existing Session. It may influence later transient routing, but it does not become an authority for Session content or state.

_Avoid_: independent Work records, copied transcripts, or a second writable WorkHub state store.
