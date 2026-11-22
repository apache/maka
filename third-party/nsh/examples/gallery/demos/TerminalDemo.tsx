import { platform, Text, View } from "nsh";
import process, { type ChildProcess } from "process";
import { Terminal, type TerminalRef } from "nsh/base";

// `nsh/base`'s `Terminal` draws a program's output with the platform's own
// text and sends the keys back as a terminal does. The program is the
// app's: here a small shell written in TypeScript, which on the desktop
// runs any other command with `sh -c` (`cmd.exe /c` on Windows) through
// `process.spawn`; a real app connects `write` and `onData` to a
// pseudo-terminal, a WebSocket or SSH.

const PROMPT = "\x1b[32mnsh\x1b[0m:\x1b[34m~\x1b[0m$ ";

const HELP = [
  "Commands:",
  "  \x1b[1mls\x1b[0m        the files here",
  "  \x1b[1mcolors\x1b[0m    the 16 ANSI colors and a 24-bit ramp",
  "  \x1b[1mprogress\x1b[0m  a bar redrawn in place",
  "  \x1b[1mecho\x1b[0m …    prints what follows",
  "  \x1b[1mclear\x1b[0m     clears the screen",
  "Anything else runs in the system shell on the desktop (Ctrl+C stops it).",
].join("\r\n");

const desktop = platform.desktop && platform.os !== "web";

function colors() {
  let out = "";
  for (let i = 0; i < 16; i++) {
    out += `\x1b[48;5;${i}m  \x1b[0m`;
    if (i === 7) out += "\r\n";
  }
  out += "\r\n";
  for (let i = 0; i < 48; i++) {
    const r = Math.round(255 * (1 - i / 47));
    const b = Math.round(255 * (i / 47));
    out += `\x1b[48;2;${r};96;${b}m \x1b[0m`;
  }
  return out;
}

const LS = [
  "\x1b[1;34mcrates\x1b[0m  \x1b[1;34mexamples\x1b[0m  \x1b[1;34mwebsite\x1b[0m  Cargo.toml  README.md  \x1b[1;32minstall.sh\x1b[0m",
].join("\r\n");

/** Terminal: a TypeScript shell's output and the keys typed into it. */
export function TerminalDemo() {
  let term: TerminalRef | undefined;
  let line = "";
  let child: ChildProcess | undefined;
  let welcomed = false;
  const write = (s: string) => term?.write(s);

  const progress = () => {
    let done = 0;
    const tick = () => {
      done += 5;
      const filled = Math.round(done / 5);
      write(`\r\x1b[36m${"█".repeat(filled)}\x1b[2m${"░".repeat(20 - filled)}\x1b[0m ${done}%`);
      if (done < 100) setTimeout(tick, 60);
      else write("\r\n" + PROMPT);
    };
    tick();
  };

  const run = (command: string) => {
    const [name, ...rest] = command.trim().split(/\s+/);
    switch (name) {
      case "":
        break;
      case "help":
        write(HELP + "\r\n");
        break;
      case "ls":
        // The desktops list the real files.
        if (desktop) {
          shell(command);
          return;
        }
        write(LS + "\r\n");
        break;
      case "colors":
        write(colors() + "\r\n");
        break;
      case "echo":
        write(rest.join(" ") + "\r\n");
        break;
      case "clear":
        write("\x1b[2J\x1b[H");
        break;
      case "progress":
        progress();
        return;
      default:
        if (desktop) {
          shell(command);
          return;
        }
        write(`\x1b[31m${name}: command not found\x1b[0m\r\n`);
    }
    write(PROMPT);
  };

  const shell = (command: string) => {
    const windows = process.platform === "windows";
    try {
      child = windows
        ? process.spawn("cmd.exe", ["/d", "/c", command])
        : process.spawn("sh", ["-c", command]);
    } catch (error) {
      write(`\x1b[31m${String(error)}\x1b[0m\r\n${PROMPT}`);
      return;
    }
    const out = (text: string) => write(text.replace(/\r?\n/g, "\r\n"));
    child.on("stdout", out);
    child.on("stderr", (text) => out(`\x1b[31m${text}\x1b[0m`));
    child.on("exit", () => {
      child = undefined;
      write(PROMPT);
    });
  };

  const input = ({ data }: { data: string }) => {
    if (child) {
      if (data.includes("\x03")) child.kill();
      return;
    }
    for (const ch of data) {
      if (ch === "\r") {
        write("\r\n");
        const command = line;
        line = "";
        run(command);
      } else if (ch === "\x7f") {
        if (line.length > 0) {
          line = line.slice(0, -1);
          write("\b \b");
        }
      } else if (ch === "\x03") {
        line = "";
        write("^C\r\n" + PROMPT);
      } else if (ch === "\x0c") {
        write("\x1b[2J\x1b[H" + PROMPT + line);
      } else if (ch >= " ") {
        line += ch;
        write(ch);
      }
    }
  };

  return (
    <View class="flex-1 gap-3 bg-background p-4">
      <Text class="text-[13px] text-muted-foreground">Type help, then press Enter.</Text>
      <Terminal
        ref={(r) => {
          term = r;
          r.focus();
        }}
        onResize={() => {
          // The welcome waits for the first size, so it wraps at the
          // terminal's width.
          if (welcomed) return;
          welcomed = true;
          write("Welcome to the \x1b[1mNSH\x1b[0m terminal.\r\n\r\n" + HELP + "\r\n\r\n" + PROMPT);
        }}
        onData={input}
        accessibilityLabel="Terminal"
        cursorClass="bg-foreground/50"
        class="flex-1 rounded-xl border border-border bg-card px-3 py-2"
      />
    </View>
  );
}
