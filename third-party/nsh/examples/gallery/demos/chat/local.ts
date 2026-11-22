import { spawn } from "process";

export type Provider = "Claude" | "Codex";

/** Runs one local CLI turn. Credentials stay in the CLI's own login store. */
export function localReply(provider: Provider, prompt: string, text: (chunk: string) => void, done: (error?: string) => void): () => void {
  const command = provider === "Claude" ? "claude" : "codex";
  const args = provider === "Claude"
    ? ["--print", "--verbose", "--output-format", "stream-json", "--include-partial-messages", "--tools", "", "--strict-mcp-config", "--no-session-persistence"]
    : ["exec", "--json", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only", "-"];
  let stopped = false;
  let output = false;
  let stderr = "";
  let failure = "";
  const child = spawn(command, args, { stdin: "pipe", lines: true, timeoutMs: 120000 });
  child.on("stdout", (line) => {
    if (stopped) return;
    let event;
    try { event = JSON.parse(line); } catch { return; }
    let chunk = "";
    if (provider === "Claude") {
      const delta = event.type === "stream_event" ? event.event?.delta : undefined;
      if (delta?.type === "text_delta") chunk = delta.text ?? "";
      if (event.type === "result") {
        if (event.is_error) failure = event.result || event.errors?.join("\n") || "Claude could not complete this reply.";
        else if (!output) chunk = event.result ?? "";
      }
    } else {
      if (event.type === "item.completed" && event.item?.type === "agent_message") chunk = event.item.text ?? "";
      if (event.type === "error" || event.type === "turn.failed") failure = event.message || event.error?.message || "Codex could not complete this reply.";
    }
    if (chunk) { output = true; text(chunk); }
  });
  child.on("stderr", (chunk) => { stderr = (stderr + chunk + "\n").slice(-3000); });
  child.on("exit", (result) => {
    if (stopped) return;
    if (result.code !== 0 || result.error || failure || !output) {
      done(`${provider}: ${result.error || failure || stderr.trim() || `exited with ${result.code ?? result.signal ?? "no reply"}`}. Install ${command} on PATH and sign in with ${command} in a terminal, then retry.`);
    } else done();
  });
  child.write(prompt);
  child.end();
  return () => { stopped = true; child.kill(); };
}
