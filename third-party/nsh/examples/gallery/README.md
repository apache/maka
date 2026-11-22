# Gallery

Run `cargo run` from the repository root to explore the native UI demos. The Standard APIs page exercises NSH's file, process, TCP, WebSocket, environment and job APIs. Its utilities card demonstrates the standard library's Buffer, crypto, path, URL and compression integration.

For the TCP and WebSocket echo actions, start the local peers in another terminal:

```sh
python3 examples/gallery/tools/echo.py
```

The helper uses Python's standard library and binds loopback ports 9876 and 9877. Run the gallery on the same machine to reach these peers. File actions use a temporary directory inside the host's configured data directory and remove it afterwards. Process actions use `echo` and `cat` on Unix or `cmd.exe` on Windows; the host checks the executable grants in `nsh.json`.

The web gallery uses the same standard APIs: utilities run in WebAssembly, files persist in the app's private browser filesystem, and both WebSocket interfaces use browser connections. Process and TCP actions display the browser host's typed platform errors.

The **Request host exit** action calls `process.exit(0)` explicitly. Gallery denies this capability in `nsh.json` and displays the expected permission result, keeping the demo open on native hosts and in browsers. The page displays capability and host errors from actions so the same gallery can run under different host policies.

AI Chat uses the local Claude or Codex CLI on desktop. Install `claude` and/or `codex` on the host's `PATH`, then sign in through that CLI in a terminal. Choose the provider in the composer. Each reply includes the conversation as context; Stop and leaving the screen terminate the child process. Codex runs with its read-only sandbox; Claude runs with tools disabled. The CLI uses its own saved login and configuration. Replies have a two-minute deadline, and launch or authentication errors appear with a retry action.

On web and mobile, AI Chat uses the scripted streaming demo, including reasoning, tools, attachments and error recovery. Run `./target/debug/nsh run examples/gallery --target web` to try it in a browser.
