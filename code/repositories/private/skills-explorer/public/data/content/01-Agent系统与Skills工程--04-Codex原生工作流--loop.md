---
name: loop
description: >-
  Run a prompt or skill in this session on a recurring or variable interval
  (e.g. /loop 5m /foo).
---

# Loop

Run `/loop` on a recurring or variable interval. First decide which mechanism applies from the tools you have, then follow only that section below:

- If the `cursor-subscriptions-subscribe_timer` MCP tool is available (you are a Cloud Agent), use **Subscription timer (cloud)**. A local `sleep` loop does not work in cloud.
- Otherwise (local IDE/CLI session), use **Monitored shell output (local)**.

## Parse

Accept `/loop [interval] <prompt>`.

- Leading interval: `5m /foo`, `30s check status`, `2h run report`.
- Trailing interval: `check deploy every 5m`, `run tests every 10 minutes`.
- No interval: dynamic mode; the agent chooses the delay and may change it tick to tick.
- Empty prompt: show `Usage: /loop [interval] <prompt>`.

Use intervals like `30s`, `5m`, `2h`, `1d`. Convert unit words to short units. If the user gives a cron-style phrase ("every weekday at 9am") and the subscription-timer mechanism is in use, pass it as a cron expression instead of a delay.

# Subscription timer (cloud)

Use the `cursor-subscriptions` MCP timer to wake this Cloud Agent on a recurring schedule using `cursor-subscriptions-subscribe_timer`.

## Schedule

Call `cursor-subscriptions-subscribe_timer` with:

- `name`: a stable handle, e.g. `loop-<purpose>` derived from the prompt (`loop-check-deploy`). The server dedupes by name and **silently keeps the old config** on a dedupe hit — see "Changing an existing timer" below.
- `prompt`: the literal follow-up text the agent should receive on each tick.
- Exactly one of `delaySeconds` (a positive integer, fixed interval between fires) or `cron` (a cron expression).

Run the prompt once immediately so the first server tick is not a cold start. Then subscribe and confirm: the interval, that the prompt already ran once, the returned `subscriptionId`, and that the loop will fire on each tick until stopped.

Each subsequent tick arrives as a normal follow-up prompt. Do not arm anything client-side; the server keeps firing until you unsubscribe or the timer expires.

## Changing an existing timer

`subscribe_timer` does **not** update an existing timer in place. If a live timer with the same `name` already exists, the server returns its current `subscriptionId` with `created: false` and **drops the `prompt`, `cron`, and `delaySeconds` you just passed**. To actually change any of those, call `cursor-subscriptions-unsubscribe` for the current `subscriptionId` first, then `cursor-subscriptions-subscribe_timer` with the new values.

## Dynamic Schedule

The user wants the agent to self-pace. `cursor-subscriptions` can watch CI checks with `cursor-subscriptions-subscribe_github_ci` or `cursor-subscriptions-subscribe_origin_ci`, but it has no event-watcher analog for arbitrary signals such as file changes or log lines. For those signals, the only knob is the time interval.

1. **Run the prompt now.**
2. Subscribe once with your first-picked `delaySeconds`.
3. On each tick, if the next desired interval is unchanged, do nothing — the timer keeps firing.
4. To change pace, **unsubscribe first** (`cursor-subscriptions-unsubscribe` with the current `subscriptionId`), then `cursor-subscriptions-subscribe_timer` with the same `name` and the new `delaySeconds`. Skipping the unsubscribe is a silent no-op: the server returns the existing subscription unchanged and ignores the new `delaySeconds`.

## Stop

1. Call `cursor-subscriptions-list_subscriptions` to find the row whose name matches `loop-<purpose>`.
2. Call `cursor-subscriptions-unsubscribe` with that `subscriptionId`.
3. Confirm: the loop has stopped and why. Do not arm another timer.

If several timers match the purpose and you cannot disambiguate, surface the candidates to the user and ask which one to stop.

## Guidance

- Use a unique `name` per loop so unrelated timers do not collide.
- Do not start a local `sleep` loop or any background shell wake — they do not work in cloud.
- Re-arming with the same `name` on a live timer is a silent no-op — the new `prompt` / `cron` / `delaySeconds` are dropped. To change anything about a live timer, unsubscribe first.
- On stop, do not schedule another timer.

# Monitored shell output (local)

Use monitored shell output to wake the agent for recurring local work.

## Fixed Schedule

```bash
while true; do
  sleep <seconds>
  echo 'AGENT_LOOP_TICK_<purpose> {"prompt":"<prompt>"}'
done
```

1. Check existing terminals for an already-running matching loop.
2. Start one background shell loop with `notify_on_output`.
3. Use a unique sentinel and a regex such as `^AGENT_LOOP_TICK_<purpose>`.
4. Smoke-check once to confirm clean startup.
5. Run the prompt once immediately after arming the loop.
6. The first sentinel should arrive only after the initial sleep, so startup does not double-run the prompt.
7. Track the PID so the agent can stop the loop if asked.
8. Briefly confirm: the interval, that the prompt already ran once, when the first tick will arrive, and that the loop will fire on each tick until stopped. On later ticks, give a short update of what changed. On stop, say the loop has stopped and why.

## Dynamic Schedule

The user wants the agent to self-pace. Decide what makes the next iteration worth running — a passage of time, or an observable event.

1. **Run the prompt now.**
2. **If the next run is gated on an event** (a git ref advancing, a log line matching, a file changing, a CI check completing), arm a background watcher that emits the sentinel only when the event fires, with `notify_on_output` on `^AGENT_LOOP_WAKE_<purpose>`. Arm once; skip on later ticks if it's still running.
3. **At the end of the turn, arm a one-shot time-based wake**:

```bash
sleep <seconds>
echo 'AGENT_LOOP_WAKE_<purpose> {"prompt":"<prompt>"}'
```

With a watcher armed, this is the **fallback heartbeat** — lean long so idle ticks aren't pure overhead. Without a watcher, this is the cadence — pick a delay based on when the result is worth checking again.

4. **On wake**, read the latest payload, execute its `prompt`, then re-arm the next heartbeat (and re-arm the watcher only if it exited). If both an output wake and a completion notification arrive, act on the output and ignore the completion.
5. **To stop**, kill any watcher PID and don't arm the next heartbeat.
6. Briefly confirm: that you're self-pacing, whether a watcher is the primary wake signal, what fallback delay you picked, and that the prompt already ran.

## Prompt Payload

Wake notifications include an output file path, not a submitted prompt. Put the prompt beside the sentinel, preferably as JSON. On wake, read the latest matching line and act on its `prompt`. The prompt may vary by tick.

## Guidance

- Title shell commands as `Loop <schedule>: <prompt>` (e.g. `Loop every 5m: check deploy status`).
- Adapt loop syntax to the user's shell (e.g. PowerShell `while ($true) { ... Start-Sleep }` on Windows). The examples above use bash.
- Prefer monitored shell output over OS cron when the agent needs wake notifications; stdout stays attached to the monitored task.
- Use a unique sentinel per loop so unrelated output does not trigger notifications.
- Avoid noisy commands inside the loop.
- Do not create duplicate fixed loops or dynamic sleepers.
- If the user asks to stop, kill any tracked loop/sleeper PID, then await the shell task so its completion notification is consumed and does not wake the agent later. Do not schedule another dynamic wake.
