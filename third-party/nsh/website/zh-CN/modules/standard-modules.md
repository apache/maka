---
title: 标准模块
description: "十一个 Node 风格的标准模块：固定版本的 LLRT 工具模块，以及经能力检查的文件、进程和网络。"
order: 14.5
---

Native Shell 为 TSX 提供十一个标准模块，按裸模块名导入（Rust 代码使用 Rust 自己的库：见[在 Rust 中](#在-rust-中)）：与 gpui-shell 兼容的 Node 风格接口，运行在应用的 VM 中，由 NSH 的原生运行时实现，能力检查在 Rust 中进行。`.nsh/types` 中的 TypeScript 声明与模块由同一份规格生成，类型所示即运行时所导出。

| 模块 | 导出 |
|---|---|
| `buffer` | `Buffer`、`atob`、`btoa`、`constants`、默认导出（LLRT）；`Buffer` 也是全局对象 |
| `crypto` | `createHash`、`createHmac`、`randomBytes`、`randomFill`、`randomFillSync`、`randomInt`、`randomUUID`、`getRandomValues`、`webcrypto`、`crypto`、`Crc32`、`Crc32c`、`Md5`、`Sha1`、`Sha256`、`Sha384`、`Sha512`、默认导出（LLRT）；`crypto` 也是全局对象 |
| `path` | `basename`、`delimiter`、`dirname`、`extname`、`format`、`isAbsolute`、`join`、`normalize`、`parse`、`relative`、`resolve`、`sep`、默认导出（LLRT） |
| `url` | `URL`、`URLSearchParams`、`domainToASCII`、`domainToUnicode`、`fileURLToPath`、`format`、`pathToFileURL`、`urlToHttpOptions`、默认导出；`URL` 和 `URLSearchParams` 是 NSH 的全局类 |
| `zlib` | `deflate`、`deflateRaw`、`inflate`、`inflateRaw`、`gzip`、`gunzip`、`brotliCompress`、`brotliDecompress`、`zstdCompress`、`zstdDecompress` 及各自的 `Sync` 形式、默认导出（LLRT） |
| `os` | `platform()`、`arch()`、`homedir()`、`EOL`、默认导出 |
| `console` | 默认导出：VM 的 `console`（`log`、`info`、`debug`、`warn`、`error`） |
| `fs/promises` | `readFile`、`writeFile`、`readdir`、`exists`、`mkdir`、`rename`、`unlink`、`rmdir`、`stat`、`lstat`、`readlink`、默认导出 |
| `process` | `run`、`spawn`、`exit`、`platform`、`arch`、`nextTick`、`ChildProcess`、默认导出；默认导出对象还有 `env` 和 `dataDir`，它也是全局 `process` |
| `net` | `connect`、`Socket`、默认导出 |
| `websocket` | `WebSocket.connect(url, options?)` 解析为 `WebSocketConnection`（`read`、`write`、`close`）、`WebSocketConnection`；原生宿主上另有全局 `WebSocket` 构造器 |

## 在 Rust 中

Rust 代码用 Rust 标准库和 crates.io 完成同样的工作，作为应用自己的原生代码运行：阻塞调用用 `blocking(…)` 在运行时的线程上执行，异步调用用 `background(…)`（`nsh_core::prelude`），结果在任务中回到组件。`nsh.json` 的 `capabilities` 约束应用的 TSX 和 NSH 的服务（`fetch`、剪贴板）；应用自己的 Rust 代码以应用进程的权限运行。在浏览器应用中，Rust 代码用 `fetch` 访问网络，用 `nsh_core::storage::Storage` 保存数据。

| 模块 | Rust |
|---|---|
| `buffer` | `Vec<u8>`、`&[u8]`、`base64` crate |
| `crypto` | `sha2`、`hmac`、`rand`、`uuid` 等 crate |
| `path` | `std::path` |
| `url` | `url` crate |
| `zlib` | `flate2`、`brotli`、`zstd` 等 crate |
| `os` | `std::env::consts`、`os()` |
| `console` | `log` crate |
| `fs/promises` | 在 `blocking(…)` 中使用 `std::fs`；键值数据用 `Storage` |
| `process` | 在 `blocking(…)` 中使用 `std::process::Command` |
| `net` | 在 `blocking(…)` 中使用 `std::net::TcpStream`，或在 `background(…)` 中使用 `tokio::net` |
| `websocket` | 在 `background(…)` 中使用 `tokio-tungstenite` 等 crate |

## 导入与类型

每个模块都按表中的名称导入：`import { join } from "path"`、`import fs from "fs/promises"`。打包器保留这些导入，由运行时原生提供；标准模块目录就是这十一个名称。`buffer`、`crypto`、`path`、`url` 和 `zlib` 采用 LLRT 的实现，固定在 `d9fd873e793c6551c5d92b2e31480f3279e3cd8d`，其声明从该版本投影到运行时实际具有的导出。其余模块由 NSH 自己实现。NSH 的 URL、Blob、流和事件类保留其对象身份。

这十一个模块都可在原生宿主和浏览器应用中加载。`Buffer`、哈希、加密和压缩在 WebAssembly 中运行同一套可移植 Rust 实现，包括同步 API；随机值使用浏览器的密码学随机源。浏览器的 `path` 操作采用 POSIX 路径，虚拟工作目录为 `/`。浏览器文件使用持久化的应用私有存储，WebSocket 使用浏览器传输。浏览器中的进程执行和原始 TCP 调用返回带类型的平台错误。

## 与 Node.js 和 gpui-shell 的比较

这些模块在其导出的子集内沿用 Node 的名称和形态，在 gpui-shell 定义了行为之处沿用 gpui-shell 的行为。NSH 自己的选择：

- `fs/promises` 的 `exists` 对目标不存在的符号链接返回 `true`；`unlink`、`rename`、`rmdir`、`lstat` 和 `readlink` 作用于符号链接本身。
- `Stats` 和 `Dirent` 的字段（`size`、`mtimeMs`、`name` 等）与 Node 一样是对象自身的属性，`isFile()`、`isDirectory()` 和 `isSymbolicLink()` 在其原型上。
- `ChildProcess` 的监听器收到事件的内容：输出文本，或退出时的 `{ code, signal }`（由运行时结束子进程时还带有 `error`）。`on` 返回子进程本身。
- 子进程的环境是宿主的一小组变量加上应用获授权的变量名；它在应用的数据目录中运行，或在 `fs.write` 根目录内的 `cwd` 中运行（见[进程](#进程)）。
- `process.platform`、`process.arch`、`os.platform()` 和 `os.arch()` 给出 Rust 的 `std::env::consts` 名称，与 gpui-shell 一致：`"macos"`、`"windows"`、`"linux"`、`"ios"`、`"android"`；`"aarch64"`、`"x86_64"`（见[系统元数据](#系统元数据与日志)）。
- 宿主没有数据目录时 `process.dataDir` 为 `null`；`process.exit` 请求宿主关闭当前应用界面。
- 限制是每个接口的一部分：大小、数量和超时在下面各模块中列出。

## 系统元数据与日志

`os.platform(): string` 和 `os.arch(): string` 返回实际原生宿主的系统与架构，`process.platform` 和 `process.arch` 的值与之相同。它们是 Rust 的 `std::env::consts::OS` 和 `ARCH` 的名称，与 gpui-shell 一致：系统为 `"macos"`、`"windows"`、`"linux"`、`"ios"`、`"android"`，架构为 `"aarch64"`、`"x86_64"`，应用直接与它们比较（`process.platform === "macos"`）。`os.EOL: string` 是宿主的换行符。`os.homedir(): string` 返回配置为绝对路径的宿主主目录，在缺少此配置时抛出错误。返回目录路径只是元数据，文件操作仍需要 `fs.read` / `fs.write` 授权。

浏览器应用读取的 `process.env` 是空对象，调用 `os.homedir()` 会收到错误；主目录路径与环境变量属于原生宿主。

`import console from "console"` 与全局 `console` 是同一个 VM 日志对象。该模块仅默认导出，支持 `log`、`info`、`debug`、`warn`、`error`，每个方法的签名为 `(...values: unknown[]): void`。接口采用 NSH 的日志格式。

## 压缩

`zlib` 采用 LLRT 的实现，NSH 为其加上一个上限：每次解压（`inflate`、`inflateRaw`、`gunzip`、`brotliDecompress`、`zstdDecompress` 及其 `Sync` 形式）最多输出 64 MiB；VM 的堆上限更小时以堆上限为准。超出时抛出 `RangeError`，与 Node.js 对 `maxOutputLength` 的处理一致；应用自己的 `maxOutputLength` 可以为单次调用设置更低的上限。`Buffer.alloc`、`Buffer.allocUnsafe`、`Buffer.allocUnsafeSlow` 和 `crypto.randomBytes` 在大小超过 VM 的堆上限（没有堆上限时为 1 GiB）时抛出 `RangeError`（`code` 为 `ERR_OUT_OF_RANGE`）；`allocUnsafe` 返回清零的内存。

## 文件

`fs/promises` 在桌面宿主（macOS、Windows 和 Linux）上读写原生文件，在浏览器中通过 Origin Private File System（OPFS）读写应用私有文件。每个路径在操作开始前都按 `capabilities.fs` 检查：`readFile`、`readdir`、`stat`、`lstat`、`readlink` 和 `exists` 使用 `read` 根目录，`writeFile`、`mkdir`、`rename`、`unlink` 和 `rmdir` 使用 `write` 根目录。授权范围之外的路径在调用时抛出 `TypeError`；I/O 失败以 `Error` 拒绝 Promise。

```json
{
  "capabilities": {
    "fs": { "read": ["${dataDir}"], "write": ["${dataDir}"] }
  }
}
```

根目录可以是绝对路径、`${dataDir}`（宿主为此应用选定的数据目录）、`${pluginDir}`（应用目录）、`${homeDir}`，或相对于应用目录的路径。调用中的相对路径依次在每个授权根目录中解析。嵌入应用可以进一步缩小授权。每个操作都限定在其授权根目录之内，符号链接也是如此；绝对路径按书写形式检查，因此须通过根目录自身的路径（或其解析后的路径）访问，而不能经由根目录之外的符号链接。`lstat`、`readlink`、`exists`、`unlink`、`rename` 和 `rmdir` 作用于符号链接本身：目标不存在的符号链接 `exists` 为 `true`，`unlink` 删除链接并保留其目标。

失败时的错误带有 Node 的错误属性：`code`（`ENOENT`、`EEXIST`、`ENOTDIR`、`EISDIR`、`ENOTEMPTY`、`ELOOP`、`EACCES`、`EPERM` 等；文本不是 UTF-8 时为 `EILSEQ`，超出读取上限时为 `ERR_FS_FILE_TOO_LARGE`）、`syscall` 和 `path`，因此可以用 `error.code === "ENOENT"` 判断文件不存在。授权范围之外的路径抛出 `code` 为 `EACCES` 的 `TypeError`，宿主没有原生文件系统时 `code` 为 `ENOSYS`。

`readFile` 返回 `Uint8Array`，指定 `"utf8"` 时返回字符串，可读取最大 64 MiB 的文件。`writeFile` 写入最多 8 MiB 的字符串或 `Uint8Array`，创建或替换一个普通文件。`readdir` 最多列出 10 000 个按名称排序的条目名（名称合计最多 1 MiB；更大的目录以 `code` 为 `ERR_OUT_OF_RANGE` 的 `RangeError` 拒绝），传入 `{ withFileTypes: true }` 时返回 `Dirent`（`name`、`isDirectory()`）。`stat` 和 `lstat` 返回 `Stats`，包含 `size`、`mode`、`mtimeMs` / `atimeMs` / `birthtimeMs`、`Date` 类型的 `mtime` / `atime` / `birthtime`，以及 `isFile()`、`isDirectory()` 和 `isSymbolicLink()`。`rmdir` 删除一个空目录。每个 VM 同时最多进行 1024 个操作，进行中的文件数据最多 64 MiB（交给 `writeFile` 直到写完的数据，以及读取后直到 Promise 完成的数据）；超出这些限制的调用抛出 `RangeError`，超出限制的读取被拒绝。

浏览器存储按页面来源和应用命名空间隔离，文件授权与大小限制同样由 Rust 检查。OPFS 需要 HTTPS 或 localhost 等安全上下文。文件修改时间来自浏览器元数据；未知的访问时间、创建时间和权限模式为零。`rename` 使用浏览器句柄的原子移动操作，浏览器未提供该操作时返回 `ENOTSUP`。浏览器条目为普通文件或目录，`readlink` 返回 `EINVAL`。

## 进程

`process.spawn` 和 `process.run` 在桌面宿主（macOS、Windows 和 Linux）上启动命令。运行时以参数数组直接执行程序，不经过 shell，并管理其管道；stdout 和 stderr 以增量 UTF-8 送达。

```json
{
  "capabilities": {
    "process": { "execute": ["git"], "env": ["GIT_AUTHOR_NAME"] },
    "fs": { "write": ["${dataDir}"] }
  }
}
```

命令须与 `process.execute` 完全一致：`git` 和 `/usr/bin/git` 是两项不同的授权。裸命令通过宿主 `PATH` 中的绝对目录解析；在 Windows 上，裸命令还会在其中匹配 `<name>.com` 和 `<name>.exe`。批处理文件（`.cmd`、`.bat`）通过 `cmd.exe` 运行：授权它的绝对路径（`C:\Windows\System32\cmd.exe`），并把 `/d`、`/c` 和脚本作为参数传入。子进程的环境是宿主的 `PATH`、`HOME`、`USERPROFILE`、`SystemRoot`、`TEMP`、`TMP`、`TMPDIR`、`LANG` 和 `LC_*`，加上 `process.env` 授权的变量名（按名称精确匹配，仅在环境变量不区分大小写的 Windows 上忽略大小写）。子进程在应用的数据目录（不存在时创建）中运行，或在 `cwd` 中运行；`cwd` 须是 `fs.write` 根目录内已存在的目录，因为子进程可以在其运行目录中写入。嵌入应用可以进一步缩小授权。

```rust tabs
use std::{
    io::{BufRead, BufReader},
    process::{Command, Stdio},
};

spawn(async move {
    // `run`：命令退出后得到全部输出。
    if let Ok(Ok(output)) = blocking(|| Command::new("git").args(["status", "--short"]).output()).await {
        log::info!("{} {}", output.status, String::from_utf8_lossy(&output.stdout));
    }
    // `spawn` 配合 `lines: true`：逐行得到输出。
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

`run` 在任何退出状态下都以 `{ code, stdout, stderr }` 完成，在启动失败、超时和输出超过限制时拒绝。`spawn` 立即返回子进程；`stdin: "pipe"` 启用 `write` 和 `end`，`lines: true` 按完整行送达。`on(event, handler)` 返回子进程本身，处理函数收到事件的内容：文本，或在最后一次输出之后收到一次 `{ code, signal }`（由运行时结束子进程时，例如超时或行过长，还带有 `error`）（之后添加的监听器会立即收到它）。`pid` 是子进程的进程号。未授权的命令或授权范围之外的 `cwd` 抛出带 `code` `EACCES` 的 `TypeError`；启动失败的错误带有 `code`（可执行文件不存在时为 `ENOENT`，无法执行时为 `EACCES`）、`syscall`（`spawn <命令>`）和 `path`：`spawn` 抛出该错误，`run` 以它拒绝。超过子进程数量上限时，`spawn` 抛出、`run` 以 `RangeError` 拒绝。宿主没有数据目录时 `process.dataDir` 为 `null`。`kill`、超时、响应式所有者的清理和 VM 的销毁都会结束整个进程树：在 Unix 上，进程组先收到 SIGTERM，250 ms 后收到 SIGKILL（VM 销毁时立即发送 SIGKILL）。

| 限制 | 值 |
|---|---|
| `timeoutMs` | 最多 4,294,967,295 ms；`run` 默认 30 秒，`spawn` 运行到退出 |
| `run` 的捕获 | 每个流 8 MiB |
| `lines: true` 时的单行 | 8 MiB |
| 每个 VM 的子进程 | 32 |
| 每个 VM 进行中的输出 | 8 MiB；读取端等待 JS 取走 |
| 每个子进程待写入的 stdin | 1 MiB；超出时 `write` 抛出错误 |
| 监听器 | 每个子进程每个事件 64 个 |

`process.exit(code?)` 请求宿主关闭当前应用界面。在 `capabilities.process` 中设置 `"exit": true` 后，引擎通过平台的应用退出命令转发请求。在 macOS 上，该请求关闭当前界面所在的窗口。在浏览器中，它停止应用并清空其界面，宿主页面保持打开。嵌入宿主决定如何处理其界面的退出请求。Gallery 禁用此权限，让 **Request host exit** 操作展示权限拦截结果，并保持演示界面打开。

## 网络授权与边界

全局 `fetch` 保留 NSH 的流式 HTTP 实现，按 `network.hosts` 或 `network.http` 检查每次请求与重定向。WebSocket 支持 `ws:` / `wss:`、文本及二进制消息、事件监听器与关闭握手。WebSocket 握手是一次 HTTP GET，因此全局 `WebSocket` 与 `websocket` 模块的 `WebSocket.connect` 都使用 HTTP 授权：`ws` 按 `http`、`wss` 按 `https` 以 GET 检查（规则也可以在 `schemes` 中列出 `ws` / `wss`）。NSH 在开始连接前检查初始的规范化 URL。原生握手连接该 URL 并拒绝重定向；浏览器 WebSocket 的重定向与连接策略由浏览器控制。两种 API 都拒绝带有凭据或片段的 URL。每个 VM 的两种 API 合计最多 32 个 WebSocket，两者的单条消息都最多 8 MiB。

全局 `WebSocket` 的发送队列最多 8 条消息、缓冲总量最多 8 MiB（`bufferedAmount`），超出任一项时 `send()` 抛出错误。握手和每次写入超时为 30 秒，关闭时最多等待 5 秒对端的关闭帧。消息到达时即以 `message` 事件交付。

`websocket` 模块的 `WebSocketConnection` 最多同时有 8 个待完成操作（读、写、关闭），尚未发出的写入合计最多 8 MiB；超过字节上限的 `write()` 在调用时抛出 `RangeError`，超过操作上限的则被拒绝。同一时间只能有一个 `read()` 等待。尚未读取的到达消息最多保留八条且合计 8 MiB；再多一条就关闭连接，因为应用读取得比对端发送得慢。解析、连接与握手合计、每次写入和关闭的超时均为 30 秒。连接结束后（对端关闭、读写失败或未读数据过多），`read()` 仍按顺序返回保留的消息，然后以连接结束的原因拒绝。

`net.connect(host, port)` 只使用 `network.sockets` 授权：一组精确的 `"host:port"` 目标（IPv6 写作 `"[::1]:9000"`），检查发生在 DNS 查询之前。每一项授权一个主机上的一个端口；主机模式、`network.hosts` 与 HTTP 授权只用于 HTTP 流量，没有 `"capabilities"` 的应用同样需要列出它的 socket。返回的 `Socket` 提供 `read(size?)`、`write(text)` 和 `close()`；读取返回 `Uint8Array`，EOF 返回 `null`。未授权时在调用处抛出 `TypeError`，超出限制时抛出 `RangeError`；连接与 I/O 失败以带有 Node 的 `code`（`ECONNREFUSED`、`ENOTFOUND`、`ETIMEDOUT`、`ECONNRESET` 等）和 `syscall` 的错误拒绝 Promise，连接失败还带有 `address` 和 `port`，对已关闭 socket 的操作为 `ERR_SOCKET_CLOSED`。连接与 I/O 超时为 30 秒，单次读写最多 1 MiB，等待发送的写入合计最多 4 MiB，`close()` 会立即结束待完成的读写。每个 VM 同时最多有 32 个已打开或正在连接的 socket。这是 Promise 客户端 socket 接口。

原始 TCP 使用原生宿主。Web 应用中的两种 WebSocket 接口使用浏览器传输，保留 Rust 能力检查和上述限制。自定义浏览器握手头会返回明确的选项不支持错误，同时遵循浏览器连接策略。嵌入宿主的能力授权与应用声明取交集。

## WebSocket 授权示例

下面的 `nsh.json` 片段允许该 `wss` 地址的 GET 握手，同时保留路径与 HTTPS 范围限制：

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

## TCP 授权示例

TCP 使用 socket 授权：应用所连接的精确主机与端口。

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

打开 `examples/gallery` 中的 **Standard APIs**，可以运行文件操作、子进程、TCP 和两种 WebSocket 接口，并查看主机信息和排队任务。Utilities 操作展示缓冲区、哈希、压缩和文件 URL。每项操作都会显示结果或错误。文件操作使用 gallery 数据目录下的临时目录，并在操作后清理。TCP 和 WebSocket 操作分别连接本机 9876 和 9877 端口的回显服务。在 Web 上，文件操作使用 OPFS，工具函数在 WebAssembly 中运行，两种 WebSocket 操作使用浏览器连接；进程与 TCP 操作显示宿主返回的带类型的平台错误。

Gallery 的 **AI Chat** 在桌面上通过 `process.spawn` 调用本机安装的 Claude 或 Codex CLI。先在终端通过 CLI 登录，再在输入区选择提供方。回复使用对话记录作为上下文；停止生成或离开页面都会结束子进程。Web 和移动端运行模拟流式对话，展示推理、工具卡片和错误恢复。
