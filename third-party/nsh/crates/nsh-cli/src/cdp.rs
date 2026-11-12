//! A Chromium browser (Chrome, Edge, Chromium) driven through the Chrome
//! DevTools Protocol: what `nsh test --target web` runs apps in. The
//! browser runs headless on a profile of its own; each app gets a page in a
//! browser context of its own (storage and cookies apart, as a fresh
//! profile's), and its input is the browser's trusted input
//! (`Input.dispatch*`), which pages cannot tell from a user's.
//!
//! nsh finds the browser installed on this machine ([`find`]) and never
//! fetches one. The protocol's calls go over one WebSocket, one at a time,
//! each waiting for its answer; the few events the browser sends without
//! being asked are skipped.

use std::{
    net::TcpStream,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use serde_json::{Value, json};
use tungstenite::{Message, WebSocket, stream::MaybeTlsStream};

use crate::ui;

/// How long the browser may take to start.
const START: Duration = Duration::from_secs(30);
/// How long a call may take.
const CALL: Duration = Duration::from_secs(30);
/// How often a read looks at the clock while nothing comes.
const POLL: Duration = Duration::from_millis(50);

/// The browser to run apps in: `given` (`--browser`), else Chrome, Edge or
/// Chromium where they install on this system; an error saying how to get
/// one when there is none.
pub(crate) fn find(given: Option<&Path>) -> anyhow::Result<PathBuf> {
    if let Some(path) = given {
        if path.is_file() {
            return Ok(path.to_owned());
        }
        anyhow::bail!("--browser {}: no such file", ui::path(path));
    }
    let candidates = candidates();
    if let Some(found) = candidates.iter().find(|p| p.is_file()) {
        return Ok(found.clone());
    }
    let looked = if cfg!(any(target_os = "macos", windows)) {
        candidates
            .iter()
            .map(|p| format!("\n  {}", p.display()))
            .collect::<String>()
    } else {
        format!(" {} on PATH", LINUX_NAMES.join(", "))
    };
    anyhow::bail!(
        "nsh test --target web runs the apps in Chrome, Edge or Chromium, and none is installed where nsh looks:{looked}\n\
         install one, or name its executable with --browser <PATH>"
    )
}

/// The names Chrome, Edge and Chromium have on Linux and the BSDs.
const LINUX_NAMES: [&str; 6] = [
    "google-chrome",
    "google-chrome-stable",
    "microsoft-edge",
    "microsoft-edge-stable",
    "chromium",
    "chromium-browser",
];

/// Where Chrome, Edge and Chromium install, in that order.
fn candidates() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if cfg!(target_os = "macos") {
        let apps = [
            "Google Chrome.app/Contents/MacOS/Google Chrome",
            "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
            "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "Chromium.app/Contents/MacOS/Chromium",
        ];
        let mut roots = vec![PathBuf::from("/Applications")];
        if let Some(home) = std::env::var_os("HOME") {
            roots.push(PathBuf::from(home).join("Applications"));
        }
        for app in apps {
            paths.extend(roots.iter().map(|root| root.join(app)));
        }
    } else if cfg!(windows) {
        let apps = [
            r"Google\Chrome\Application\chrome.exe",
            r"Microsoft\Edge\Application\msedge.exe",
            r"Chromium\Application\chrome.exe",
        ];
        let roots: Vec<PathBuf> = ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"]
            .into_iter()
            .filter_map(std::env::var_os)
            .map(PathBuf::from)
            .collect();
        for app in apps {
            paths.extend(roots.iter().map(|root| root.join(app)));
        }
    } else {
        let dirs: Vec<PathBuf> = std::env::var_os("PATH")
            .map(|path| std::env::split_paths(&path).collect())
            .unwrap_or_default();
        for name in LINUX_NAMES {
            paths.extend(dirs.iter().map(|dir| dir.join(name)));
        }
    }
    paths
}

/// A headless browser this process started; it goes when it is closed
/// ([`Browser::close`]) or dropped.
pub(crate) struct Browser {
    child: Mutex<Child>,
    socket: Mutex<WebSocket<MaybeTlsStream<TcpStream>>>,
    next: AtomicU64,
    /// Its profile, removed after it.
    profile: PathBuf,
    output: ui::Tail,
    closed: AtomicBool,
}

impl Browser {
    /// Starts `exe` headless on a fresh profile and connects to it.
    pub(crate) fn launch(exe: &Path) -> Result<Browser, String> {
        let profile = std::env::temp_dir().join(format!(
            "nsh-test-browser-{}-{}",
            std::process::id(),
            NEXT_PROFILE.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&profile);
        std::fs::create_dir_all(&profile)
            .map_err(|e| format!("cannot make {}: {e}", profile.display()))?;
        let mut command = Command::new(exe);
        command
            .arg("--headless")
            // The port it picks goes into the profile's DevToolsActivePort.
            .arg("--remote-debugging-port=0")
            .arg(format!("--user-data-dir={}", profile.display()))
            .args([
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-extensions",
                "--disable-sync",
                "--mute-audio",
                // Pages in the background keep their timers and frames: a
                // test's page is never in front.
                "--disable-background-timer-throttling",
                "--disable-backgrounding-occluded-windows",
                "--disable-renderer-backgrounding",
                // Headless, the browser finds no input device and reports no
                // pointer (`pointer: none`, `hover: none`), so pages measure
                // as touch screens; the test drives a mouse: a fine pointer
                // that hovers (Blink's `PointerType` / `HoverType`, as
                // Playwright launches it).
                "--blink-settings=primaryPointerType=4,availablePointerTypes=4,\
                 primaryHoverType=2,availableHoverTypes=2",
                // No downloads of its own (components, Safe Browsing lists):
                // they made a profile in the temp directory 150 MB.
                "--disable-component-update",
                "--disable-background-networking",
                "about:blank",
            ])
            .stdin(Stdio::null());
        let (mut child, output) =
            ui::quiet(&mut command).map_err(|e| format!("cannot start {}: {e}", exe.display()))?;
        let port_file = profile.join("DevToolsActivePort");
        let deadline = Instant::now() + START;
        let url = loop {
            if let Ok(text) = std::fs::read_to_string(&port_file) {
                let mut lines = text.lines();
                if let (Some(port), Some(path)) = (lines.next(), lines.next()) {
                    break format!("ws://127.0.0.1:{}{}", port.trim(), path.trim());
                }
            }
            if let Ok(Some(status)) = child.try_wait() {
                return Err(format!(
                    "{} exited with {status} as it started{}",
                    exe.display(),
                    indented(&output.text())
                ));
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "{} did not start in {} s{}",
                    exe.display(),
                    START.as_secs(),
                    indented(&output.text())
                ));
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        let socket = match tungstenite::connect(url.as_str()) {
            Ok((socket, _)) => socket,
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("cannot connect to {}: {e}", exe.display()));
            }
        };
        if let MaybeTlsStream::Plain(stream) = socket.get_ref() {
            let _ = stream.set_read_timeout(Some(POLL));
            let _ = stream.set_nodelay(true);
        }
        Ok(Browser {
            child: Mutex::new(child),
            socket: Mutex::new(socket),
            next: AtomicU64::new(1),
            profile,
            output,
            closed: AtomicBool::new(false),
        })
    }

    /// Whether it still runs.
    pub(crate) fn alive(&self) -> bool {
        matches!(self.lock_child().try_wait(), Ok(None))
    }

    /// What it printed last, on lines of their own (for errors).
    pub(crate) fn output(&self) -> String {
        indented(&self.output.text())
    }

    /// A blank page in a browser context of its own.
    pub(crate) fn page(self: &Arc<Self>) -> Result<Page, String> {
        let id = |value: Value, key: &str| {
            value[key]
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| format!("the browser answered without a {key}"))
        };
        let context = id(
            self.call(None, "Target.createBrowserContext", json!({}))?,
            "browserContextId",
        )?;
        // Dropped on the way out, it removes the context again.
        let mut page = Page {
            browser: self.clone(),
            context,
            session: String::new(),
            closed: AtomicBool::new(false),
        };
        let target = id(
            self.call(
                None,
                "Target.createTarget",
                json!({ "url": "about:blank", "browserContextId": page.context }),
            )?,
            "targetId",
        )?;
        page.session = id(
            self.call(
                None,
                "Target.attachToTarget",
                json!({ "targetId": target, "flatten": true }),
            )?,
            "sessionId",
        )?;
        Ok(page)
    }

    /// Calls `method` with `params`, on the page of `session` or the
    /// browser: its result, or the browser's error.
    fn call(&self, session: Option<&str>, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let mut message = json!({ "id": id, "method": method, "params": params });
        if let Some(session) = session {
            message["sessionId"] = session.into();
        }
        let mut socket = self.socket.lock().unwrap_or_else(|e| e.into_inner());
        socket
            .send(Message::text(message.to_string()))
            .map_err(|e| format!("the browser is gone: {e}"))?;
        let deadline = Instant::now() + CALL;
        loop {
            match socket.read() {
                Ok(Message::Text(text)) => {
                    let Ok(reply) = serde_json::from_str::<Value>(&text) else {
                        continue;
                    };
                    // Events, and answers to calls that gave up waiting.
                    if reply.get("id").and_then(Value::as_u64) != Some(id) {
                        continue;
                    }
                    if let Some(error) = reply.get("error") {
                        let text = error["message"].as_str().unwrap_or("an error");
                        return Err(format!("the browser refused {method}: {text}"));
                    }
                    return Ok(reply.get("result").cloned().unwrap_or(Value::Null));
                }
                Ok(_) => {}
                Err(tungstenite::Error::Io(err))
                    if matches!(
                        err.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) =>
                {
                    if Instant::now() >= deadline {
                        return Err(format!(
                            "the browser did not answer {method} in {} s",
                            CALL.as_secs()
                        ));
                    }
                }
                Err(e) => return Err(format!("the browser is gone: {e}")),
            }
        }
    }

    fn lock_child(&self) -> std::sync::MutexGuard<'_, Child> {
        self.child.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Closes it and removes its profile, once; the pages left fail their
    /// calls.
    pub(crate) fn close(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        // Closed as a user closes it, so its helper processes go with it.
        let _ = self.call(None, "Browser.close", json!({}));
        let mut child = self.lock_child();
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if let Ok(Some(_)) = child.try_wait() {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = child.kill();
        let _ = child.wait();
        drop(child);
        let _ = std::fs::remove_dir_all(&self.profile);
    }
}

impl Drop for Browser {
    fn drop(&mut self) {
        self.close();
    }
}

/// The profiles started so far: each browser gets one of its own.
static NEXT_PROFILE: AtomicU64 = AtomicU64::new(0);

/// A page of the browser, in a browser context of its own: closing it
/// (or dropping it) removes the context and what the page kept.
pub(crate) struct Page {
    browser: Arc<Browser>,
    context: String,
    session: String,
    closed: AtomicBool,
}

impl Page {
    /// Calls `method` with `params` on this page.
    pub(crate) fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        self.browser.call(Some(&self.session), method, params)
    }

    /// The browser it is in.
    pub(crate) fn browser(&self) -> &Browser {
        &self.browser
    }

    /// Closes the page and its context.
    pub(crate) fn close(&self) {
        if !self.closed.swap(true, Ordering::Relaxed) {
            let _ = self.browser.call(
                None,
                "Target.disposeBrowserContext",
                json!({ "browserContextId": self.context }),
            );
        }
    }
}

impl Drop for Page {
    fn drop(&mut self) {
        self.close();
    }
}

/// `text` (the browser's output) on lines of its own, if there is any.
fn indented(text: &str) -> String {
    if text.trim().is_empty() {
        String::new()
    } else {
        format!(":\n{}", text.trim_end())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_browser_given_must_exist() {
        let missing = Path::new("/no/such/browser");
        let err = find(Some(missing)).unwrap_err().to_string();
        assert!(err.contains("--browser"), "{err}");
    }
}
