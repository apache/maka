import { mount, Text, View } from "nsh";
import { Terminal, type TerminalRef } from "nsh/base";

// The program is the app's: here a small shell written in TypeScript. A real
// app connects `write` and `onData` to a pseudo-terminal, a WebSocket or SSH.

const PROMPT = "\x1b[32mnsh\x1b[0m:\x1b[34m~\x1b[0m$ ";

const HELP = [
  "Commands:",
  "  \x1b[1mls\x1b[0m        the files here",
  "  \x1b[1mcolors\x1b[0m    ANSI colors, a 24-bit ramp",
  "  \x1b[1mprogress\x1b[0m  a bar redrawn in place",
  "  \x1b[1mecho\x1b[0m …    prints what follows",
  "  \x1b[1mclear\x1b[0m     clears the screen",
].join("\r\n");

const LS = "\x1b[1;34mcrates\x1b[0m  \x1b[1;34mexamples\x1b[0m  \x1b[1;34mwebsite\x1b[0m  Cargo.toml  README.md  \x1b[1;32minstall.sh\x1b[0m";

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

function App() {
  let term: TerminalRef | undefined;
  let line = "";
  let busy = false;
  let welcomed = false;
  const write = (s: string) => term?.write(s);

  const progress = () => {
    busy = true;
    let done = 0;
    const tick = () => {
      done += 5;
      const filled = done / 5;
      write(`\r\x1b[36m${"█".repeat(filled)}\x1b[2m${"░".repeat(20 - filled)}\x1b[0m ${done}%`);
      if (done < 100) setTimeout(tick, 60);
      else {
        busy = false;
        write("\r\n" + PROMPT);
      }
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
        write(`\x1b[31m${name}: command not found\x1b[0m\r\n`);
    }
    write(PROMPT);
  };

  const input = ({ data }: { data: string }) => {
    if (busy) return;
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
        ref={(r) => (term = r)}
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

mount(App);
