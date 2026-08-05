# OpenAI Responses incremental transport

## 1. Problem and invariant

Long tool loops currently rebuild and upload the complete provider history on every step. The
durable Runtime event ledger remains the source of truth, but the OpenAI Responses transport may
reuse a turn-scoped WebSocket and send only the suffix after the previous response.

The optimization must never change the logical request. A continuation is eligible only when the
current Maka message list is exactly:

1. the previous request messages;
2. followed by the previous SDK response messages;
3. followed by at least one new message.

Otherwise the adapter sends the complete request and starts a new continuation chain.

## 2. Ownership and lifecycle

- `ModelAdapter` owns semantic continuation state, keyed by turn id so concurrent turns never
  share a chain.
- The OpenAI Responses transport owns the matching WebSocket and wire request/response state.
- The session id supplies a stable `prompt_cache_key`; an explicit caller value wins.
- Durable history remains complete. Only the provider-bound wire projection is incremental.

## 3. Failure matrix

| Condition | Behavior |
| --- | --- |
| First request or message-prefix mismatch | Full request over WebSocket |
| Request options/model/tools changed | Full request; replace the chain baseline |
| Missing/stale response id | Clear the chain; Runtime retry starts from durable full history |
| WebSocket connect failure | Full HTTP request; disable continuation for that turn |
| Socket closes or stream fails | Clear the chain; normal Runtime retry starts from full history |
| Same turn attempts concurrent requests | Full HTTP request for the contender |
| Abort/cancel | Close the socket and clear the chain |
| Configured network proxy | WebSocket uses the same immutable proxy snapshot and bypass list |
| OAuth subscription or Chat Completions model | Existing transport, unchanged |

## 4. Test plan

- Unit-test exact semantic prefix/delta selection and every mismatch fallback.
- Unit-test stable cache-key merging without overwriting explicit provider options.
- Exercise a local WebSocket server to verify connection reuse, `previous_response_id`, delta-only
  input, and SSE translation.
- Verify WebSocket setup failure reconstructs and sends a complete HTTP request.
- Run Runtime typecheck and focused tests, then the repository validation appropriate to the diff.

## 5. Observability and rollout

The existing provider-attempt telemetry already records request bytes, latency, time to first token,
and cache usage. Rollout can compare those fields by provider step. WebSocket is limited to the
API-key OpenAI Responses adapter; direct, HTTP(S)-proxy, and SOCKS5 routes follow the existing
transport snapshot. Every failure path preserves a complete HTTP fallback. OAuth subscription
transports remain on their refresh-aware HTTP path.

## 6. Verification outcome

- Runtime TypeScript build passes.
- Focused continuation, WebSocket, existing Responses HTTP, model-adapter, and scoped-network tests:
  60 passed.
- HTTP proxy behavior is exercised end-to-end through an authenticated local CONNECT proxy.
- SOCKS5 selection and shared bypass-list routing are covered at the transport boundary.
- A Runtime-wide run passed 3,150 tests before repository dependency patches were applied; the 27
  patch-dependent failures pass after applying the patches. One unrelated pre-existing macOS
  sandbox assertion remains environment-sensitive (`/usr/local` executable-root ordering).
