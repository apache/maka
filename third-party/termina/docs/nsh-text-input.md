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
| Application → terminal | `focus;CONTEXT` |
| Terminal → application | `focused;CONTEXT` |
| Terminal → application | `update;CONTEXT;ACTIVE;START;END;COMMIT;PREEDIT` |

`CONTEXT` is unsigned decimal u64. Focus and its acknowledgement allow zero to
disable forwarding; updates require a positive context (`NonZeroU64`). An
application issues a new context on each editor admission, including A→B→A,
and accepts updates only after the terminal acknowledges that exact context.
Termina parses values; the native input owner owns these admission checks.

`COMMIT` and `PREEDIT` are canonical padded standard Base64 of UTF-8; empty fields
are valid. Controls and semicolons are data inside the decoded strings. `ACTIVE`
is exactly `0` or `1`. `START..END` is a UTF-16 range within decoded preedit,
ordered and bounded on Unicode scalar boundaries (never inside a surrogate
pair). An inactive update requires empty preedit and `0..0`; an active empty
preedit can announce composition start without deleting the editor selection.
The parser rejects malformed complete packets as a whole, preserving following
ordinary input. It adds no text-length or reply-time limit. Formatting rejects
invalid update ranges before writing its OSC introducer.

An update is one ordered snapshot: apply its committed prefix to the original
marked target, then recheck that target before applying its remaining preedit.
Callbacks can move focus. Never replay a partly applied packet. Inactive with
empty commit cancels marked text without implicitly committing it.

After negotiation and focus, the terminal forwards actual composition snapshots,
suppresses its duplicate legacy committed-text write and composition preview,
and retains OS candidate-window ownership. Without negotiation it keeps normal
input behavior. Bind/finish the old composition on the terminal UI thread before
acknowledging a new context; send outside terminal locks. Focus zero, reset, and
alternate-screen exit release forwarding. Candidate placement uses the reported
native caret without applying the preedit cursor offset twice.
