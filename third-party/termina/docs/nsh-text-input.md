# Negotiated NSH text input

This experimental private extension carries real OS IME composition through
`OSC 777;nsh-text-input;OPERATION ST`. It is not an existing terminal standard.
Termina exposes it as `escape::osc::NshTextInput` inside `Osc::NshTextInput` and
the existing `Event::Osc`. Formatting emits ST; parsing retains ordinary OSC
framing, including BEL termination. No terminal-name detection enables it.

| Direction | Operation |
| --- | --- |
| Application → terminal | `query` |
| Terminal → application | `supported` |
| Application → terminal | `enable;E` |
| Terminal → application | `ready;E` |
| Terminal → application | `update;C;ACTIVE;START;END;COMMIT;PREEDIT` |
| Application → terminal | `cancel;C` |
| Application → terminal | `disable;E` |
| Terminal → application | `disabled;E` |

`E` and `C` are positive unsigned decimal u64 values (`NonZeroU64`). `E` is a
random application nonce used only to admit or revoke one subscription. A
`supported` reply alone cannot enable delivery. The terminal drains and revokes
old native delivery before `ready;E`, then sends all new snapshots after that
reply. Repeated `enable;E` is idempotent and does not reset a composition.
`disable;E` revokes the matching subscription, drains native delivery, then
replies `disabled;E`; a stale nonce cannot revoke a newer subscription.

`C` belongs to the source and identifies one composition lifetime, including
partial commits and remaining preedit. IDs increase monotonically and are never
reused during the source connection. The allocator survives reset, enable and
disable, and control detach/reattach. `cancel;C` affects only that still-current
native lifetime, so a late cancellation cannot damage a newer composition.
Termina parses these values; subscription and lifetime admission remain with the
native input owners. There is no per-update subscription or sequence field.

`COMMIT` and `PREEDIT` are canonical padded standard Base64 of UTF-8; empty fields
are valid. Controls and semicolons are data inside the decoded strings. `ACTIVE`
is exactly `0` or `1`. `START..END` is a UTF-16 range within decoded preedit,
ordered and bounded on Unicode scalar boundaries (never inside a surrogate
pair). An inactive update requires empty preedit and `0..0`; an active empty
preedit can announce composition start without deleting the editor selection.
The parser rejects malformed complete packets as a whole, preserving following
ordinary input. It adds no text-length or reply-time limit. Formatting rejects
invalid update ranges before writing its OSC introducer.

The application binds a new `C` once to its current native focus admission.
Subsequent packets cannot rebind an ended or revoked lifetime, even if focus
moves A→B→A. With no focused editor, ignore and cancel the new composition.
Revocation clears only that lifetime's temporary mark and sends `cancel;C` once;
monotonic IDs allow closed lifetimes to be rejected without remembering each ID.
An update is one ordered snapshot: apply its committed prefix to the original
marked target, then recheck its admission before applying remaining preedit.
Callbacks can move focus. Never replay a partly applied packet. Inactive with
empty commit cancels marked text without implicitly committing it.

After subscription admission, the terminal forwards actual composition snapshots,
suppresses its duplicate legacy committed-text write and composition preview,
and retains OS candidate-window ownership. Without negotiation it keeps normal
input behavior. Before ordinary input that can change editor focus or selection,
the terminal finishes the old composition and sends its real final result, then
that input, then any new composition. While native completion is pending, retain
the real event and subsequent input in FIFO order; do not synthesize preedit from
keys or re-inject Unicode. Finish and drain on the terminal UI thread through
native callbacks, with no polling or arbitrary timeout; send outside terminal
locks. Reset immediately revokes queued delivery too, and quarantined callbacks
cannot fall back to legacy text. Candidate placement uses the reported native
caret without applying the preedit cursor offset twice.

On exit, the application keeps its single reader until the matching
`disabled;E` or its existing bounded best-effort restoration ends. Incomplete
restoration is surfaced, and final cleanup preserves ordering even when output
is blocked. This exit contract adds no normal-input size, count, or time limit.
