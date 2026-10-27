---
title: Standard modules
description: "Eleven Node-shaped standard modules: pinned LLRT utilities and capability-checked files, processes and networking."
order: 14.5
---

Native Shell provides eleven standard modules for TSX, imported by their bare names (Rust code uses Rust's own libraries: [From Rust](#from-rust)): Node-shaped APIs compatible with gpui-shell's, running in the app's VM on NSH's native runtime, with their capabilities checked in Rust. Their TypeScript declarations in `.nsh/types` are generated from the same specs as the modules, so what the types show is what the runtime exports.

| Module | Exports |
|---|---|
| `buffer` | `Buffer`, `atob`, `btoa`, `constants`, default (LLRT); `Buffer` is also a global |
| `crypto` | `createHash`, `createHmac`, `randomBytes`, `randomFill`, `randomFillSync`, `randomInt`, `randomUUID`, `getRandomValues`, `webcrypto`, `crypto`, `Crc32`, `Crc32c`, `Md5`, `Sha1`, `Sha256`, `Sha384`, `Sha512`, default (LLRT); `crypto` is also a global |
| `path` | `basename`, `delimiter`, `dirname`, `extname`, `format`, `isAbsolute`, `join`, `normalize`, `parse`, `relative`, `resolve`, `sep`, default (LLRT) |
| `url` | `URL`, `URLSearchParams`, `domainToASCII`, `domainToUnicode`, `fileURLToPath`, `format`, `pathToFileURL`, `urlToHttpOptions`, default; `URL` and `URLSearchParams` are NSH's global classes |
| `zlib` | `deflate`, `deflateRaw`, `inflate`, `inflateRaw`, `gzip`, `gunzip`, `brotliCompress`, `brotliDecompress`, `zstdCompress`, `zstdDecompress`, each with its `Sync` form, default (LLRT) |
| `os` | `platform()`, `arch()`, `homedir()`, `EOL`, default |
| `console` | default: the VM's `console` (`log`, `info`, `debug`, `warn`, `error`) |
| `fs/promises` | `readFile`, `writeFile`, `readdir`, `exists`, `mkdir`, `rename`, `unlink`, `rmdir`, `stat`, `lstat`, `readlink`, default |
| `process` | `run`, `spawn`, `exit`, `platform`, `arch`, `nextTick`, `ChildProcess`, default; the default object also has `env` and `dataDir` and is the global `process` |
| `net` | `connect`, `Socket`, default |
| `websocket` | `WebSocket.connect(url, options?)` resolving a `WebSocketConnection` (`read`, `write`, `close`), `WebSocketConnection`; the global `WebSocket` constructor on native hosts |

## From Rust

Rust code does the same work with Rust's standard library and crates.io, in the app's own native code: blocking calls run on the runtime's threads with `blocking(…)` and async ones with `background(…)` (`nsh_core::prelude`), and their results come back to the component in a task. The `capabilities` of `nsh.json` govern the app's TSX and NSH's services (`fetch`, the clipboard); the app's own Rust code runs with the permissions of the app's process. In browser apps, Rust code reaches the network with `fetch` and keeps data with `nsh_core::storage::Storage`.

| Module | Rust |
|---|---|
| `buffer` | `Vec<u8>`, `&[u8]`, the `base64` crate |
| `crypto` | crates such as `sha2`, `hmac`, `rand` and `uuid` |
| `path` | `std::path` |
| `url` | the `url` crate |
| `zlib` | crates such as `flate2`, `brotli` and `zstd` |
| `os` | `std::env::consts`, `os()` |
| `console` | the `log` crate |
| `fs/promises` | `std::fs` in `blocking(…)`; `Storage` for key-value data |
| `process` | `std::process::Command` in `blocking(…)` |
| `net` | `std::net::TcpStream` in `blocking(…)`, or `tokio::net` in `background(…)` |
| `websocket` | a crate such as `tokio-tungstenite` in `background(…)` |

## Imports and generated types

Each module is imported by exactly the name in the table: `import { join } from "path"`, `import fs from "fs/promises"`. The bundler keeps these imports, and the runtime serves them natively; the catalog is these eleven names. `buffer`, `crypto`, `path`, `url` and `zlib` are LLRT's implementations, pinned to `d9fd873e793c6551c5d92b2e31480f3279e3cd8d`, with declarations projected from that revision onto the exports the runtime has. The others are NSH's own. NSH keeps the identity of its URL, Blob, stream and event classes.

All eleven modules load on native hosts and in browser apps. `Buffer`, hashing, crypto and compression use the same portable Rust implementation in WebAssembly, including synchronous APIs; random values use browser cryptographic entropy. Browser `path` operations use POSIX paths and a virtual `/` working directory. Browser files use persistent app-private storage, and WebSockets use the browser transport. Process execution and raw TCP calls report typed platform errors in browsers.

## How they compare with Node.js and gpui-shell

The modules follow Node's names and shapes for the subset they export, and gpui-shell's behavior where it defines one. NSH's own choices:

- `fs/promises`' `exists` is `true` for a symlink whose target is missing, and `unlink`, `rename`, `rmdir`, `lstat` and `readlink` act on a symlink itself.
- `Stats` and `Dirent` have their fields (`size`, `mtimeMs`, `name`, ...) as own properties, as Node's do, and `isFile()`, `isDirectory()` and `isSymbolicLink()` on their prototype.
- A `ChildProcess` listener receives the event's payload: the output text, or the exit's `{ code, signal }` (with `error` when the runtime ended the child). `on` returns the child.
- A child's environment is a small set from the host plus the names the app is granted, and it runs in the app's data directory or a `cwd` within an `fs.write` root ([Processes](#processes)).
- `process.platform`, `process.arch`, `os.platform()` and `os.arch()` give Rust's `std::env::consts` names, as gpui-shell's do: `"macos"`, `"windows"`, `"linux"`, `"ios"`, `"android"`; `"aarch64"`, `"x86_64"` ([OS metadata](#os-metadata-and-logging)).
- `process.dataDir` is `null` when the host has no data directory; `process.exit` asks the host to close the app surface.
- Limits are part of each API: sizes, counts and timeouts are listed with each module below.

## OS metadata and logging

`os.platform(): string` and `os.arch(): string` report the actual native host OS and architecture, and `process.platform` and `process.arch` hold the same values. They are the names of Rust's `std::env::consts::OS` and `ARCH`, as gpui-shell's are: `"macos"`, `"windows"`, `"linux"`, `"ios"`, `"android"` for the OS, `"aarch64"`, `"x86_64"` for the architecture, so apps compare against them directly (`process.platform === "macos"`). `os.EOL: string` is the host's line separator. `os.homedir(): string` returns a configured absolute host home path and throws when none is configured. Directory paths are metadata: file operations still require `fs.read` / `fs.write` grants.

Browser apps read an empty `process.env` object and receive an error from `os.homedir()`, since home paths and environment variables belong to native hosts.

`import console from "console"` shares the VM's global `console` object. The module has a default export only, supporting `log`, `info`, `debug`, `warn`, `error`, each with signature `(...values: unknown[]): void`. It uses NSH's logger formatting.

## Compression

`zlib` is LLRT's, with one bound NSH adds: each decompression (`inflate`, `inflateRaw`, `gunzip`, `brotliDecompress`, `zstdDecompress` and their `Sync` forms) produces at most 64 MiB, or the VM's heap limit when that is smaller. Longer output throws a `RangeError`, as Node.js does for `maxOutputLength`; an app's own `maxOutputLength` sets a lower bound for one call. `Buffer.alloc`, `Buffer.allocUnsafe`, `Buffer.allocUnsafeSlow` and `crypto.randomBytes` throw a `RangeError` (`code` `ERR_OUT_OF_RANGE`) for a size past the VM's heap limit, or 1 GiB without one; `allocUnsafe` returns zeroed memory.

## Files

`fs/promises` reads and writes native files on desktop hosts (macOS, Windows and Linux), and app-private browser files through the Origin Private File System (OPFS). Every path is checked against `capabilities.fs` before the operation starts: `read` roots for `readFile`, `readdir`, `stat`, `lstat`, `readlink` and `exists`, `write` roots for `writeFile`, `mkdir`, `rename`, `unlink` and `rmdir`. A path outside the grants throws a `TypeError` at the call; I/O failures reject the promise with an `Error`.

```json
{
  "capabilities": {
    "fs": { "read": ["${dataDir}"], "write": ["${dataDir}"] }
  }
}
```

Roots are absolute paths, `${dataDir}` (this app's data directory, chosen by the host), `${pluginDir}` (the app's directory), `${homeDir}`, or paths relative to the app's directory. A relative path in a call is resolved in each granted root in turn. An embedding host may narrow the grants further. Every operation stays inside its granted root, symlinks included; an absolute path is checked as written, so a root is reached by its own path (or its resolved one), not through a link outside it. `lstat`, `readlink`, `exists`, `unlink`, `rename` and `rmdir` act on a symlink itself: `exists` is `true` for a symlink whose target is missing, and `unlink` removes the link and keeps its target.

Failures carry Node's error properties: `code` (`ENOENT`, `EEXIST`, `ENOTDIR`, `EISDIR`, `ENOTEMPTY`, `ELOOP`, `EACCES`, `EPERM`, ...; `EILSEQ` for text that is not UTF-8, `ERR_FS_FILE_TOO_LARGE` past the read limit), `syscall` and `path`, so `error.code === "ENOENT"` tells a missing file apart. A path outside the grants throws a `TypeError` with `code` `EACCES`, and `ENOSYS` where the host has no native filesystem.

`readFile` returns a `Uint8Array`, or a string with `"utf8"`, and reads files up to 64 MiB. `writeFile` writes a string or `Uint8Array` of up to 8 MiB, creating or replacing a regular file. `readdir` lists up to 10 000 names (1 MiB of them; a larger directory rejects with a `RangeError`, `code` `ERR_OUT_OF_RANGE`), sorted, or `Dirent`s (`name`, `isDirectory()`) with `{ withFileTypes: true }`. `stat` and `lstat` resolve a `Stats` with `size`, `mode`, `mtimeMs` / `atimeMs` / `birthtimeMs`, `mtime` / `atime` / `birthtime` as `Date`s, and `isFile()`, `isDirectory()` and `isSymbolicLink()`. `rmdir` removes one empty directory. One VM runs up to 1024 operations at a time and holds up to 64 MiB of file data in flight (data handed to `writeFile` until it is written, data read until its promise settles); a call past these limits throws a `RangeError`, a read past them rejects.

Browser storage is scoped to the page's origin and the app's own namespace, with the same file grants and size limits checked in Rust. OPFS requires a secure context, such as HTTPS or localhost. File modification times come from browser metadata; unknown access/birth times and modes are zero. `rename` uses an atomic browser handle move and reports `ENOTSUP` when the browser does not provide it. Browser entries are regular files or directories, and `readlink` reports `EINVAL`.

## Processes

`process.spawn` and `process.run` launch commands on desktop hosts (macOS, Windows and Linux). The runtime executes the program directly with an argument array, with no shell, and owns its pipes; stdout and stderr arrive as incremental UTF-8.

```json
{
  "capabilities": {
    "process": { "execute": ["git"], "env": ["GIT_AUTHOR_NAME"] },
    "fs": { "write": ["${dataDir}"] }
  }
}
```

Commands match `process.execute` exactly: `git` and `/usr/bin/git` are separate grants. Bare commands resolve through the absolute directories of the host's `PATH`; on Windows a bare command also finds `<name>.com` and `<name>.exe` there. A batch file (`.cmd`, `.bat`) runs through `cmd.exe`: grant its absolute path (`C:\Windows\System32\cmd.exe`) and pass `/d`, `/c` and the script as arguments. A child's environment is `PATH`, `HOME`, `USERPROFILE`, `SystemRoot`, `TEMP`, `TMP`, `TMPDIR`, `LANG` and `LC_*` from the host, plus the names `process.env` grants (matched exactly, ignoring case only on Windows, whose environment does). A child runs in the app's data directory (created when missing), or in `cwd`, an existing directory within an `fs.write` root, since the child may write where it runs. An embedding host can narrow the grants.

```rust tabs
use std::{
    io::{BufRead, BufReader},
    process::{Command, Stdio},
};

spawn(async move {
    // `run`: the whole output once the command exits.
    if let Ok(Ok(output)) = blocking(|| Command::new("git").args(["status", "--short"]).output()).await {
        log::info!("{} {}", output.status, String::from_utf8_lossy(&output.stdout));
    }
    // `spawn` with `lines: true`: each line as it comes.
    let _ = blocking(|| -> std::io::Result<()> {
        let mut child = Command::new("git").args(["log", "--oneline"]).stdout(Stdio::piped()).spawn()?;
        if let Some(stdout) = child.stdout.take() {
            for line in BufReader::new(stdout).lines() {
                log::info!("{}", line?);
            }
        }
        log::info!("done {}", child.wait()?);
        Ok(())
    })
    .await;
});
```

```tsx tabs
import process from "process";

const { code, stdout } = await process.run("git", ["status", "--short"]);
const child = process.spawn("git", ["log", "--oneline"], { lines: true });
child.on("stdout", (line) => console.log(line));
child.on("exit", ({ code, signal }) => console.log("done", code, signal));
```

`run` resolves `{ code, stdout, stderr }` for any exit status and rejects on launch failures, timeouts and output past its limit. `spawn` returns a child at once; `stdin: "pipe"` enables `write` and `end`, and `lines: true` delivers complete lines. `on(event, handler)` returns the child, and a handler gets the event's payload: the text, or `{ code, signal }` once, after the final output (with `error` when the runtime ended the child: a timeout, an over-long line) (at once for a listener added later). `pid` is the child's process id. A refused command, or a `cwd` outside the grants, throws a `TypeError` with `code` `EACCES`; a launch failure carries `code` (`ENOENT` for a missing executable, `EACCES` for one that cannot run), `syscall` (`spawn <command>`) and `path`: `spawn` throws it, `run` rejects with it. Past the children limit, `spawn` throws and `run` rejects with a `RangeError`. `process.dataDir` is `null` when the host has no data directory. `kill`, a timeout, the reactive owner's cleanup and the VM's teardown end the whole process tree: on Unix its process group gets SIGTERM and then SIGKILL after 250 ms (at teardown, SIGKILL at once).

| Limit | Value |
|---|---|
| `timeoutMs` | Up to 4,294,967,295 ms; `run` defaults to 30 seconds, `spawn` runs until exit |
| `run`'s capture | 8 MiB per stream |
| One line with `lines: true` | 8 MiB |
| Children per VM | 32 |
| Output in flight per VM | 8 MiB; readers wait for JS to take it |
| Pending stdin per child | 1 MiB; `write` throws past it |
| Listeners | 64 per event per child |

`process.exit(code?)` requests that the host close this app surface. Grant it with `"exit": true` in `capabilities.process`; the engine forwards the request through the platform's app-exit command. On macOS, this closes the surface window. In a browser, it stops the app and clears its surface while keeping the host page open. An embedding host controls how its surface handles the request. Gallery denies this capability so its **Request host exit** action demonstrates permission handling and keeps the demo open.

## Network permissions and boundaries

Global `fetch` retains NSH's streaming HTTP implementation, checking `network.hosts` or `network.http` for requests and redirect hops. WebSocket supports `ws:` / `wss:`, text and binary messages, event listeners and closing handshakes. A WebSocket handshake is an HTTP GET, so both the global `WebSocket` and the `websocket` module's `WebSocket.connect` use the HTTP grants: `ws` is checked as `http` and `wss` as `https`, using GET (a rule may also list `ws` / `wss` in `schemes`). NSH checks the initial normalized URL before starting the connection. The native handshake connects to that URL and rejects redirects; browser WebSocket redirects and connection policy are controlled by the browser. Both APIs refuse a URL with credentials or a fragment. Each VM holds at most 32 WebSockets across both APIs, and messages are at most 8 MiB in both.

The global `WebSocket` queues at most eight messages to send, with at most 8 MiB buffered (`bufferedAmount`); `send()` past either throws. Its handshake and each write time out after 30 seconds, and closing waits up to 5 seconds for the peer's close frame. Messages are delivered as `message` events as they arrive.

The `websocket` module's `WebSocketConnection` holds at most eight pending operations (reads, writes, close) and at most 8 MiB of writes not sent yet; a `write()` past the byte limit throws a `RangeError` at the call, and one past the operation limit rejects. One `read()` may wait at a time. Messages that arrive before they are read are kept, up to eight and 8 MiB together; one more closes the connection, since the app reads slower than the peer sends. Resolving, connecting and the handshake together, each write and closing time out after 30 seconds. After the connection ends (the peer closed it, a read or write failed, or too much arrived unread), `read()` still resolves the kept messages, in order, then rejects with why it ended.

`net.connect(host, port)` uses only `network.sockets`, a list of exact `"host:port"` destinations (`"[::1]:9000"` for IPv6), checked before DNS lookup. Each entry grants one port on one host; host patterns, `network.hosts` and HTTP grants cover HTTP traffic only, and an app without `"capabilities"` lists its sockets too. The returned `Socket` provides `read(size?)`, `write(text)` and `close()`; reads return `Uint8Array`, or `null` at EOF. A refused grant throws a `TypeError` and a limit a `RangeError` at the call; connection and I/O failures reject with Node's `code` (`ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT`, `ECONNRESET`, ...) and `syscall`, a connection's also with `address` and `port`, and an operation on a closed socket with `ERR_SOCKET_CLOSED`. Connections and I/O have 30-second timeouts, each read/write is limited to 1 MiB, at most 4 MiB of writes may wait to be sent, and `close()` ends pending reads and writes at once. Each VM keeps at most 32 sockets open or connecting. This is a promise-based client socket interface.

Raw TCP uses native hosts. Both WebSocket interfaces use the browser transport in web apps, retaining Rust capability checks and the limits above. Custom browser handshake headers report an explicit unsupported-option error. Browser connection policies also apply. Embedding grants intersect the app's capability declaration.

## WebSocket grant example

This `nsh.json` fragment permits the GET handshake for this `wss` URL, keeping its path and HTTPS scope:

```json
{
  "capabilities": {
    "network": {
      "http": [{
        "host": "chat.example.com",
        "methods": ["GET"],
        "schemes": ["https"],
        "pathPrefix": "/socket"
      }]
    }
  }
}
```

```rust tabs
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::{connect_async, tungstenite::Message};

spawn(async move {
    let _ = background(async {
        let (mut socket, _) = connect_async("wss://chat.example.com/socket").await?;
        socket.send(Message::text("hello")).await?;
        while let Some(message) = socket.next().await {
            log::info!("{}", message?);
        }
        Ok::<_, tokio_tungstenite::tungstenite::Error>(())
    })
    .await;
});
```

```tsx tabs
const socket = new WebSocket("wss://chat.example.com/socket");
socket.addEventListener("open", () => socket.send("hello"));
socket.addEventListener("message", (event) => console.log(event.data));
```

## TCP grant example

TCP uses a socket grant: the exact host and port the app connects to.

```json
{
  "capabilities": {
    "network": { "sockets": ["tcp.example.com:9000"] }
  }
}
```

```rust tabs
use std::{
    io::{Read, Write},
    net::TcpStream,
};

spawn(async move {
    let reply = blocking(|| -> std::io::Result<String> {
        let mut socket = TcpStream::connect(("tcp.example.com", 9000))?;
        socket.write_all(b"hello\n")?;
        let mut bytes = [0; 1024];
        let n = socket.read(&mut bytes)?;
        Ok(String::from_utf8_lossy(&bytes[..n]).into_owned())
    })
    .await;
    if let Ok(Ok(reply)) = reply {
        log::info!("{reply}");
    }
});
```

```tsx tabs
import { connect } from "net";

const socket = await connect("tcp.example.com", 9000);
try {
  await socket.write("hello\n");
  const bytes = await socket.read(1024);
  if (bytes) console.log(new TextDecoder().decode(bytes));
} finally {
  socket.close();
}
```

## Gallery

Open **Standard APIs** in `examples/gallery` to run file operations, child processes, TCP and both WebSocket interfaces, and inspect host metadata and queued jobs. The utilities action demonstrates buffers, hashing, compression and file URLs. Each action displays its result or error. Files stay in a temporary directory under the gallery's own data directory and are removed after the action. The TCP and WebSocket actions connect to local echo servers on ports 9876 and 9877. On web, file actions exercise OPFS, utilities run in WebAssembly, and both WebSocket actions use browser connections; process and TCP actions display the host's typed platform errors.

Gallery's **AI Chat** uses `process.spawn` to chat through a locally installed Claude or Codex CLI on desktop. Sign in through the CLI in a terminal, then choose the provider in the composer. Replies use the conversation as context; Stop and leaving the screen end the child process. Web and mobile run scripted streaming conversations, including reasoning, tool cards and error recovery.
