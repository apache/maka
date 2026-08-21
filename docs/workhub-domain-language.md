# WorkHub domain language

WorkHub gives users one conversational place to continue, create, and inspect work while ordinary Sessions remain the product's canonical work records.

## Terms

**Session**: The authoritative record for identity, transcript, execution state, permissions, interactions, and recovery. A Session ID is the stable identity of the work.

**Work**: The user-facing continuity of exactly one ordinary Session. “Work” is a product-language view of a Session, not a second stored record.

**WorkHub**: A projection and routing surface over ordinary Sessions. It may keep transient inference context while mounted, but it does not own a transcript or execution state.

**Session projection**: A rebuildable view derived from Session facts for display and routing. It can be discarded and recreated without losing work.

**Route correction**: A user's decision that an input belongs to a different existing Session. It may influence later transient routing, but it does not become an authority for Session content or state.

_Avoid_: independent Work records, copied transcripts, or a second writable WorkHub state store.
