//! Per-view terminal services. Surface state decides permissions and local
//! interaction; host transports run on a bounded worker without reading stdin.

use std::{
    io::{Read, Write},
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

use base64::Engine as _;
use crossterm::event::{
    Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseEvent, MouseEventKind,
};
use nsh_core::{
    AccessibilityActionDef, AccessibilityRole, AccessibilityState, AccessibilityValue, Bounds,
    EventKind, EventPayload, NodeId, PayloadValue, Point, Points, ROOT_ID, ViewKind,
    access::Access,
    desktop::{DesktopCommand, MenuAction, MenuItem, MenuRole, Shortcut},
};
use ratatui::{
    buffer::Buffer,
    layout::Rect as CellRect,
    style::{Color, Modifier, Style},
    widgets::{Block, Borders, Clear, Widget},
};

use crate::{InputEdit, Surface, SurfaceEvent};

const COMMAND_TIMEOUT: Duration = Duration::from_secs(2);

/// A host operation requested by a terminal surface after capability checks.
#[derive(Debug, Clone)]
pub enum ServiceRequest {
    /// Write plain text to the host clipboard.
    ClipboardWrite(String),
    /// Read text, or inspect text formats without reading clipboard content.
    ClipboardRead {
        /// Callback identifier allocated by the runtime.
        id: u32,
        /// Inspect formats only.
        has_only: bool,
    },
    /// Paste into the exact input state captured by this edit token.
    ClipboardPaste(InputEdit),
    /// Update the host's title.
    Title(String),
    /// Announce text through the host's assistive technology transport.
    Announce(String),
}

impl ServiceRequest {
    fn clipboard(&self) -> bool {
        matches!(
            self,
            Self::ClipboardWrite(_) | Self::ClipboardRead { .. } | Self::ClipboardPaste(_)
        )
    }
}

/// Clipboard text or the result of inspecting offered text formats.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClipboardContent {
    /// Plain UTF-8 text, including an empty text selection.
    Text(String),
    /// Whether a text format is available, without exposing its contents.
    HasText(bool),
}

struct Control {
    epoch: AtomicU64,
    running: AtomicBool,
    access: RwLock<Access>,
}

/// Cooperative cancellation for a host service callback. Host implementations
/// use bounded IO and stop when the app unloads or its grant changes.
pub struct ServiceCancellation {
    control: Arc<Control>,
    epoch: u64,
    clipboard: bool,
}

impl ServiceCancellation {
    /// Whether this request was superseded, stopped or denied by current policy.
    pub fn is_cancelled(&self) -> bool {
        !self.control.running.load(Ordering::Acquire)
            || self.control.epoch.load(Ordering::Acquire) != self.epoch
            || (self.clipboard
                && !self
                    .control
                    .access
                    .read()
                    .unwrap_or_else(|e| e.into_inner())
                    .allows_clipboard())
    }
}

/// Explicit per-view services supplied by an embedding host. Callbacks run
/// serially on a worker, never on the terminal draw loop. Implementations
/// honor cancellation and bound their own IO. Defaults leave services local.
pub trait HostServices: Send + Sync + 'static {
    /// Reads clipboard text, or inspects formats when `has_only` is true.
    fn read_clipboard(
        &self,
        _has_only: bool,
        _cancel: &ServiceCancellation,
    ) -> Result<ClipboardContent, String> {
        Err("host clipboard reading is unavailable".into())
    }
    /// Writes text without interpreting it as terminal commands.
    fn write_clipboard(&self, _text: &str, _cancel: &ServiceCancellation) -> Result<(), String> {
        Err("host clipboard writing is unavailable".into())
    }
    /// Receives a sanitized title for the host's own chrome.
    fn set_title(&self, _title: &str, _cancel: &ServiceCancellation) {}
    /// Receives an explicit accessibility announcement.
    fn announce(&self, _text: &str, _cancel: &ServiceCancellation) {}
}

/// An explicit terminal transport effect. Embedding hosts choose whether to
/// write its encoded commands; ordinary `AppView` operations perform no IO.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServiceOutput {
    /// A sanitized terminal title.
    Title(String),
    /// Clipboard content authorized for an OSC 52 write.
    Clipboard(String),
    /// Plain text for an assistive transport; it has no automatic escape code.
    Announcement(String),
}

impl ServiceOutput {
    /// Encodes a title or clipboard write, with tmux passthrough when requested.
    /// Clipboard text is encoded in full as base64 data.
    pub fn terminal_sequence(&self, tmux: bool) -> String {
        let sequence = match self {
            Self::Title(title) => format!("\x1b]2;{}\x1b\\", plain(title, false)),
            Self::Clipboard(text) => format!(
                "\x1b]52;c;{}\x1b\\",
                base64::engine::general_purpose::STANDARD.encode(text)
            ),
            _ => return String::new(),
        };
        if tmux {
            format!("\x1bPtmux;{}\x1b\\", sequence.replace('\x1b', "\x1b\x1b"))
        } else {
            sequence
        }
    }
}

pub(crate) struct Completion {
    pub(crate) epoch: u64,
    pub(crate) request: ServiceRequest,
    pub(crate) result: Result<Option<ClipboardContent>, String>,
}
struct Job {
    epoch: u64,
    request: ServiceRequest,
}

pub(crate) struct ServiceManager {
    sender: mpsc::SyncSender<Job>,
    receiver: mpsc::Receiver<Completion>,
    control: Arc<Control>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl ServiceManager {
    pub(crate) fn new(host: Arc<dyn HostServices>) -> std::io::Result<Self> {
        let (sender, jobs) = mpsc::sync_channel::<Job>(32);
        let (completed, receiver) = mpsc::channel();
        let control = Arc::new(Control {
            epoch: AtomicU64::new(1),
            running: AtomicBool::new(true),
            access: RwLock::new(Access::all()),
        });
        let worker = control.clone();
        let thread = std::thread::Builder::new()
            .name("nsh-terminal-services".into())
            .spawn(move || {
                while worker.running.load(Ordering::Acquire) {
                    let job = match jobs.recv_timeout(Duration::from_millis(25)) {
                        Ok(job) => job,
                        Err(mpsc::RecvTimeoutError::Timeout) => continue,
                        Err(_) => break,
                    };
                    let cancel = ServiceCancellation {
                        control: worker.clone(),
                        epoch: job.epoch,
                        clipboard: job.request.clipboard(),
                    };
                    if cancel.is_cancelled() {
                        continue;
                    }
                    let result = match &job.request {
                        ServiceRequest::ClipboardWrite(text) => {
                            host.write_clipboard(text, &cancel).map(|()| None)
                        }
                        ServiceRequest::ClipboardRead { has_only, .. } => {
                            host.read_clipboard(*has_only, &cancel).map(Some)
                        }
                        ServiceRequest::ClipboardPaste(_) => {
                            host.read_clipboard(false, &cancel).map(Some)
                        }
                        ServiceRequest::Title(title) => {
                            host.set_title(title, &cancel);
                            Ok(None)
                        }
                        ServiceRequest::Announce(text) => {
                            host.announce(text, &cancel);
                            Ok(None)
                        }
                    };
                    if !cancel.is_cancelled() {
                        let _ = completed.send(Completion {
                            epoch: job.epoch,
                            request: job.request,
                            result,
                        });
                    }
                }
            })?;
        Ok(Self {
            sender,
            receiver,
            control,
            thread: Some(thread),
        })
    }
    pub(crate) fn reset(&self, access: Access) {
        self.control.epoch.fetch_add(1, Ordering::AcqRel);
        *self
            .control
            .access
            .write()
            .unwrap_or_else(|e| e.into_inner()) = access;
    }
    pub(crate) fn sync_access(&self, access: Access) {
        if *self
            .control
            .access
            .read()
            .unwrap_or_else(|e| e.into_inner())
            != access
        {
            self.reset(access);
        }
    }
    pub(crate) fn submit(&self, request: ServiceRequest) -> Result<(), ServiceRequest> {
        let request = match request {
            ServiceRequest::Title(title) => ServiceRequest::Title(plain(&title, false)),
            ServiceRequest::Announce(text) => ServiceRequest::Announce(plain(&text, true)),
            request => request,
        };
        let epoch = self.control.epoch.load(Ordering::Acquire);
        self.sender
            .try_send(Job { epoch, request })
            .map_err(|error| match error {
                mpsc::TrySendError::Full(job) | mpsc::TrySendError::Disconnected(job) => {
                    job.request
                }
            })
    }
    pub(crate) fn poll(&self) -> impl Iterator<Item = Completion> + '_ {
        let epoch = self.control.epoch.load(Ordering::Acquire);
        self.receiver
            .try_iter()
            .filter(move |completion| completion.epoch == epoch)
    }
}

impl Drop for ServiceManager {
    fn drop(&mut self) {
        self.control.running.store(false, Ordering::Release);
        // Joining after cancellation also drops the clipboard's retained
        // selection owner before the process can exit and orphan it.
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// Host clipboard transport for the standalone runner, or an embedding host
/// that explicitly opts in. Helpers are supervised and never read terminal
/// stdin; Linux retains one foreground selection owner until replacement/drop.
#[derive(Default)]
pub struct SystemServices {
    clipboard: Mutex<SystemClipboard>,
}

impl HostServices for SystemServices {
    fn read_clipboard(
        &self,
        has_only: bool,
        cancel: &ServiceCancellation,
    ) -> Result<ClipboardContent, String> {
        self.clipboard
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .read(has_only, cancel)
    }
    fn write_clipboard(&self, text: &str, cancel: &ServiceCancellation) -> Result<(), String> {
        self.clipboard
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .write(text, cancel)
    }
}

#[derive(Default)]
struct SystemClipboard {
    owner: Option<ManagedChild>,
}

impl SystemClipboard {
    fn read(
        &mut self,
        has_only: bool,
        cancel: &ServiceCancellation,
    ) -> Result<ClipboardContent, String> {
        let mut last = "system clipboard helper is unavailable".to_owned();
        for (program, args) in clipboard_commands(false, has_only) {
            match run_helper(program, &args, None, false, cancel) {
                Ok((bytes, _)) => {
                    let text = String::from_utf8(bytes)
                        .map_err(|_| "clipboard helper returned invalid UTF-8")?;
                    return Ok(if has_only {
                        ClipboardContent::HasText(text_format(&text))
                    } else {
                        ClipboardContent::Text(text)
                    });
                }
                Err(error) => last = error,
            }
            if cancel.is_cancelled() {
                break;
            }
        }
        Err(last)
    }
    fn write(&mut self, text: &str, cancel: &ServiceCancellation) -> Result<(), String> {
        let mut last = "system clipboard helper is unavailable".to_owned();
        for (program, args) in clipboard_commands(true, false) {
            let retain = cfg!(target_os = "linux");
            match run_helper(
                program,
                &args,
                Some(text.as_bytes().to_vec()),
                retain,
                cancel,
            ) {
                Ok((_, owner)) => {
                    self.owner = owner;
                    return Ok(());
                }
                Err(error) => last = error,
            }
            if cancel.is_cancelled() {
                break;
            }
        }
        Err(last)
    }
}

fn clipboard_commands(write: bool, has_only: bool) -> Vec<(&'static str, Vec<&'static str>)> {
    if cfg!(target_os = "macos") {
        if write {
            vec![("/usr/bin/pbcopy", vec![])]
        } else if has_only {
            vec![("/usr/bin/osascript", vec!["-e", "clipboard info"])]
        } else {
            vec![("/usr/bin/pbpaste", vec!["-Prefer", "txt"])]
        }
    } else if cfg!(windows) {
        let script = if write {
            "[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false); Set-Clipboard -Value ([Console]::In.ReadToEnd()) -ErrorAction Stop"
        } else if has_only {
            "Add-Type -AssemblyName System.Windows.Forms; [Console]::Write([System.Windows.Forms.Clipboard]::ContainsText())"
        } else {
            "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); [Console]::Write([string](Get-Clipboard -Raw -ErrorAction Stop))"
        };
        vec![(
            "powershell.exe",
            vec![
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-STA",
                "-Command",
                script,
            ],
        )]
    } else {
        let mut commands = Vec::new();
        if std::env::var_os("WAYLAND_DISPLAY").is_some() {
            commands.push(if write {
                (
                    "wl-copy",
                    vec!["--foreground", "--type", "text/plain;charset=utf-8"],
                )
            } else if has_only {
                ("wl-paste", vec!["--list-types"])
            } else {
                ("wl-paste", vec!["--no-newline", "--type", "text"])
            });
        }
        if std::env::var_os("DISPLAY").is_some() {
            commands.push(if write {
                ("xclip", vec!["-selection", "clipboard", "-in", "-quiet"])
            } else if has_only {
                (
                    "xclip",
                    vec!["-selection", "clipboard", "-out", "-target", "TARGETS"],
                )
            } else {
                (
                    "xclip",
                    vec!["-selection", "clipboard", "-out", "-target", "UTF8_STRING"],
                )
            });
        }
        commands
    }
}

fn text_format(output: &str) -> bool {
    output.lines().any(|line| {
        let line = line.trim().to_ascii_lowercase();
        line == "true"
            || line == "utf8_string"
            || line == "string"
            || line == "text"
            || line.starts_with("text/")
            || line.contains("«class utf8»")
            || line.contains("«class text»")
    })
}

struct ManagedChild(Child);
impl Drop for ManagedChild {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_some() {
            return;
        }
        #[cfg(unix)]
        // SAFETY: this child was placed in its own process group before
        // spawning; only that helper and its descendants are signalled.
        unsafe {
            libc::kill(-(self.0.id() as i32), libc::SIGKILL);
        }
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn run_helper(
    program: &str,
    args: &[&str],
    input: Option<Vec<u8>>,
    retain: bool,
    cancel: &ServiceCancellation,
) -> Result<(Vec<u8>, Option<ManagedChild>), String> {
    if cancel.is_cancelled() {
        return Err("clipboard request was cancelled".into());
    }
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    if cfg!(target_os = "macos") {
        command.env("LC_CTYPE", "UTF-8");
    }
    let mut child = ManagedChild(
        command
            .spawn()
            .map_err(|_| format!("cannot start clipboard helper {program}"))?,
    );
    let mut stdout = child.0.stdout.take().expect("piped helper output");
    let (read_tx, read_rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout
            .read_to_end(&mut bytes)
            .map(|_| bytes)
            .map_err(|_| "cannot read clipboard helper output".to_owned());
        let _ = read_tx.send(result);
    });
    let mut written = input.is_none();
    let (write_tx, write_rx) = mpsc::channel();
    if let Some(input) = input {
        let mut stdin = child.0.stdin.take().expect("piped helper input");
        std::thread::spawn(move || {
            let result = stdin
                .write_all(&input)
                .map_err(|_| "cannot write clipboard helper input".to_owned());
            drop(stdin);
            let _ = write_tx.send(result);
        });
    }
    let deadline = Instant::now() + COMMAND_TIMEOUT;
    loop {
        if cancel.is_cancelled() {
            return Err("clipboard request was cancelled".into());
        }
        if Instant::now() >= deadline {
            return Err("clipboard helper timed out".into());
        }
        if !written && let Ok(result) = write_rx.try_recv() {
            result?;
            written = true;
        }
        if retain && written {
            // Foreground selection owners remain supervised. They must
            // stay alive to serve another process's paste request on X11/Wayland.
            if let Some(status) = child
                .0
                .try_wait()
                .map_err(|_| "cannot inspect clipboard helper")?
            {
                if !status.success() {
                    return Err("clipboard helper failed".into());
                }
                return Ok((Vec::new(), None));
            }
            return Ok((Vec::new(), Some(child)));
        }
        if let Some(status) = child
            .0
            .try_wait()
            .map_err(|_| "cannot inspect clipboard helper")?
        {
            if !status.success() {
                return Err("clipboard helper failed".into());
            }
            let bytes = read_rx
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .map_err(|_| "clipboard helper output timed out")??;
            return Ok((bytes, None));
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

pub(crate) fn plain(text: &str, lines: bool) -> String {
    text.chars()
        .filter(|ch| !ch.is_control() || (lines && matches!(ch, '\n' | '\t')))
        .collect()
}

pub(crate) struct MenuPopup {
    items: Arc<[MenuItem]>,
    path: Vec<usize>,
    selected: usize,
    at: Option<Point<Points>>,
}
impl MenuPopup {
    fn items(&self) -> &[MenuItem] {
        let mut items = &*self.items;
        for &index in &self.path {
            if let Some(MenuItem::Submenu { items: child, .. }) = items.get(index) {
                items = child;
            }
        }
        items
    }
}

#[derive(Default)]
pub(crate) struct SurfaceServices {
    pub(crate) enabled: bool,
    menu: Option<Arc<[MenuItem]>>,
    popup: Option<MenuPopup>,
    pointer: Option<Point<Points>>,
}

/// One accessible element in paint/tree order, scoped to the active modal.
#[derive(Debug, Clone, PartialEq)]
pub struct AccessibleNode {
    /// Mounted node identifier.
    pub id: NodeId,
    /// Shared point geometry.
    pub frame: Bounds<Points>,
    /// Semantic role, independent of terminal glyphs.
    pub role: AccessibilityRole,
    /// Accessible label, with secure input content omitted.
    pub label: String,
    /// Optional interaction hint.
    pub hint: Option<String>,
    /// Current interaction state.
    pub state: AccessibilityState,
    /// Range or descriptive value; secure fields omit it.
    pub value: Option<AccessibilityValue>,
    /// Whether the terminal assigned keyboard focus.
    pub focused: bool,
    /// Actions available through [`Surface::perform_accessibility_action`].
    pub actions: Vec<AccessibilityActionDef>,
}

impl Surface {
    /// Routes host-service requests through [`SurfaceEvent::Service`].
    ///
    /// Disabled surfaces keep an in-memory clipboard. Enabling this performs
    /// no IO: the embedding host transports writes and completes reads with
    /// [`Self::complete_clipboard`] or [`Self::complete_paste`]. Mounted
    /// capability checks still apply before requests and completions.
    pub fn set_host_services_enabled(&mut self, enabled: bool) {
        self.services.enabled = enabled;
    }

    pub(crate) fn write_clipboard(&mut self, text: String) {
        if !self.access.allows_clipboard() {
            return;
        }
        self.clipboard = text.clone();
        if self.services.enabled {
            self.events
                .push(SurfaceEvent::Service(ServiceRequest::ClipboardWrite(text)));
        }
    }
    pub(crate) fn read_clipboard(&mut self, id: u32, has_only: bool) {
        if self.access.allows_clipboard() && self.services.enabled {
            self.events
                .push(SurfaceEvent::Service(ServiceRequest::ClipboardRead {
                    id,
                    has_only,
                }));
        } else {
            let value = if has_only {
                ClipboardContent::HasText(
                    self.access.allows_clipboard() && !self.clipboard.is_empty(),
                )
            } else {
                ClipboardContent::Text(if self.access.allows_clipboard() {
                    self.clipboard.clone()
                } else {
                    String::new()
                })
            };
            self.complete_clipboard(id, has_only, Ok(value));
        }
    }
    pub(crate) fn request_paste(&mut self, id: NodeId) {
        if !self.access.allows_clipboard() {
            return;
        }
        let Some(context) = self
            .input_context()
            .filter(|context| context.node == id && context.editable)
        else {
            return;
        };
        let edit = InputEdit {
            node: id,
            expected_event_count: context.event_count,
            selection: context.selection,
            replacement: String::new(),
        };
        if self.services.enabled {
            self.events
                .push(SurfaceEvent::Service(ServiceRequest::ClipboardPaste(edit)));
        } else {
            self.complete_paste(edit, Ok(ClipboardContent::Text(self.clipboard.clone())));
        }
    }
    /// Completes a host clipboard read. Denied or failed results
    /// become empty content through the existing clipboard event protocol.
    pub fn complete_clipboard(
        &mut self,
        id: u32,
        has_only: bool,
        result: Result<ClipboardContent, String>,
    ) {
        let allowed = self.access.allows_clipboard();
        let (text, has) = match result {
            Ok(ClipboardContent::Text(text)) if allowed => {
                let has = !text.is_empty();
                (text, has)
            }
            Ok(ClipboardContent::HasText(has)) if allowed => (String::new(), has),
            _ => (String::new(), false),
        };
        let mut fields = vec![
            ("id", PayloadValue::Number(id as f64)),
            ("has", PayloadValue::Bool(has)),
        ];
        if !has_only {
            fields.push(("text", PayloadValue::Str(text)));
        }
        self.emit(ROOT_ID, EventKind::Clipboard, EventPayload::Map(fields));
    }
    /// Completes a host paste only if its input, selection and edit count
    /// still match the request and its clipboard capability remains granted.
    pub fn complete_paste(&mut self, edit: InputEdit, result: Result<ClipboardContent, String>) {
        if self.input_paused {
            return;
        }
        if !self.access.allows_clipboard() {
            return;
        }
        if !self.input_context().is_some_and(|context| {
            context.node == edit.node
                && context.selection == edit.selection
                && context.event_count == edit.expected_event_count
        }) {
            return;
        }
        if let Ok(ClipboardContent::Text(text)) = result {
            self.paste_input(edit.node, text);
        }
    }
    pub(crate) fn announce(&mut self, text: String) {
        let text = plain(&text, true);
        self.toast = Some((text.clone(), self.now + 5.0));
        if self.services.enabled {
            self.events
                .push(SurfaceEvent::Service(ServiceRequest::Announce(text)));
        }
    }
    pub(crate) fn desktop_command(&mut self, command: DesktopCommand) {
        match command {
            DesktopCommand::SetTitle(title) => {
                self.events
                    .push(SurfaceEvent::Service(ServiceRequest::Title(plain(
                        &title, false,
                    ))))
            }
            DesktopCommand::SetMenu(items) => {
                self.close_menu();
                self.services.menu = items;
                self.services.popup = None;
            }
            DesktopCommand::PopupMenu { items, at } => {
                self.close_menu();
                self.services.popup = Some(MenuPopup {
                    items,
                    path: Vec::new(),
                    selected: 0,
                    at: at.or(self.services.pointer),
                })
            }
            DesktopCommand::Close => self.quit = true,
            _ => {}
        }
    }

    /// Semantic snapshot for a host's screen reader or accessibility bridge.
    /// Hidden descendants, grouped children and secure input values are omitted.
    pub fn accessibility_snapshot(&self) -> Vec<AccessibleNode> {
        let visible = self.visible_ids();
        let mut exposed = vec![false; self.nodes.len()];
        for &id in &visible {
            if let Some(slot) = exposed.get_mut(id as usize) {
                *slot = true;
            }
        }
        visible
            .into_iter()
            .filter_map(|id| {
                if let Some((owner, link)) = self.text_link(id) {
                    let a = &link.props.accessibility;
                    if a.hidden || a.accessible == Some(false) {
                        return None;
                    }
                    for ancestor in self.ancestors(owner) {
                        let props = &self.node(ancestor)?.props.accessibility;
                        if props.hidden || props.accessible == Some(true) {
                            return None;
                        }
                    }
                    let (text, ..) = self.node(owner)?.text.as_ref()?;
                    let mut offset = 0;
                    let fallback: String = text
                        .text
                        .chars()
                        .filter(|ch| {
                            let start = offset;
                            offset += ch.len_utf16() as u32;
                            start < link.end && offset > link.start
                        })
                        .collect();
                    return Some(AccessibleNode {
                        id,
                        frame: self.global_frame(id)?,
                        role: if a.role == AccessibilityRole::None {
                            AccessibilityRole::Link
                        } else {
                            a.role
                        },
                        label: plain(a.label.as_deref().unwrap_or(&fallback), true),
                        hint: a.hint.as_deref().map(|hint| plain(hint, true)),
                        state: a.state,
                        value: a.value.clone(),
                        focused: self.focus == Some(id),
                        actions: a.actions.clone(),
                    });
                }
                let node = self.node(id)?;
                let a = &node.props.accessibility;
                if a.hidden || a.accessible == Some(false) {
                    return None;
                }
                let mut parent = node.parent;
                while let Some(id) = parent {
                    let ancestor = self.node(id)?;
                    if ancestor.props.accessibility.hidden
                        || ancestor.props.accessibility.accessible == Some(true)
                    {
                        return None;
                    }
                    parent = ancestor.parent;
                }
                let fallback = node
                    .text
                    .as_ref()
                    .map(|(text, ..)| text.text.clone())
                    .unwrap_or_else(|| {
                        if node.kind == ViewKind::Input {
                            node.input.placeholder.clone()
                        } else {
                            String::new()
                        }
                    });
                let label = a.label.as_deref().map(str::to_owned).unwrap_or(fallback);
                let label = if label.is_empty() && a.accessible == Some(true) {
                    semantic_text(self, id, 0, &exposed)
                } else {
                    label
                };
                if label.is_empty()
                    && a.role == AccessibilityRole::None
                    && node.kind != ViewKind::Input
                    && !node.events.contains(EventKind::Press)
                {
                    return None;
                }
                Some(AccessibleNode {
                    id,
                    frame: self.global_frame(id).unwrap_or(node.frame),
                    role: a.role,
                    label: plain(&label, true),
                    hint: a.hint.as_deref().map(|hint| plain(hint, true)),
                    state: a.state,
                    value: (!node.input.secure).then(|| a.value.clone()).flatten(),
                    focused: self.focus == Some(id),
                    actions: a.actions.clone(),
                })
            })
            .collect()
    }

    /// Delivers a declared semantic action to an accessible, visible node.
    pub fn perform_accessibility_action(&mut self, id: NodeId, name: &str) -> bool {
        if !self.accessibility_snapshot().iter().any(|node| {
            node.id == id
                && node
                    .actions
                    .iter()
                    .any(|action| action.name.as_ref() == name)
        }) {
            return false;
        }
        self.emit(
            id,
            EventKind::AccessibilityAction,
            EventPayload::Map(vec![("actionName", PayloadValue::Str(name.into()))]),
        );
        true
    }

    pub(crate) fn service_overlay_open(&self) -> bool {
        self.services.popup.is_some()
    }

    pub(crate) fn service_wheel(&mut self, mouse: MouseEvent, steps: u16) -> bool {
        if !self.service_event(&Event::Mouse(mouse)) {
            return false;
        }
        let direction = match mouse.kind {
            MouseEventKind::ScrollUp => -1,
            MouseEventKind::ScrollDown => 1,
            _ => return true,
        };
        for _ in 1..steps {
            self.move_menu(direction);
        }
        true
    }

    pub(crate) fn service_event(&mut self, event: &Event) -> bool {
        if let Event::Mouse(mouse) = event {
            self.services.pointer = Some(Point::new(
                self.metrics.width() * (f32::from(mouse.column) + 0.5),
                self.metrics.height() * (f32::from(mouse.row) + 0.5),
            ));
        }
        if self.dialog.is_some() {
            return false;
        }
        if let Event::Key(key) = event {
            if key.kind == KeyEventKind::Release {
                return self.services.popup.is_some();
            }
            if key.modifiers.contains(KeyModifiers::CONTROL)
                && matches!(key.code, KeyCode::Char('q' | 'Q'))
            {
                self.close_menu();
                return false;
            }
            if key.code == KeyCode::F(10) {
                if key.kind == KeyEventKind::Repeat {
                    return true;
                }
                if self.services.popup.is_some() {
                    self.close_menu();
                } else if let Some(items) = self.services.menu.clone() {
                    self.services.popup = Some(MenuPopup {
                        items,
                        path: Vec::new(),
                        selected: 0,
                        at: None,
                    });
                } else {
                    return false;
                }
                return true;
            }
            if self.services.popup.is_none() {
                let editing = self.focus.is_some_and(|id| {
                    self.node(id).is_some_and(|node| {
                        node.kind == ViewKind::Input
                            || node.native.is_some()
                            || node.kind == ViewKind::WebView
                            || node
                                .text
                                .as_ref()
                                .is_some_and(|(text, _, _)| text.is_selectable())
                    })
                });
                let action = key_shortcut(*key)
                    .and_then(|shortcut| {
                        self.services
                            .menu
                            .as_deref()
                            .and_then(|menu| MenuItem::find_shortcut(menu, &shortcut))
                            .filter(|action| !editing || action.fires_while_editing())
                    })
                    .cloned();
                if let Some(action) = action {
                    self.choose_menu(action);
                    return true;
                }
                return false;
            }
            match key.code {
                KeyCode::Esc | KeyCode::Left => {
                    if let Some(popup) = &mut self.services.popup {
                        if let Some(index) = popup.path.pop() {
                            popup.selected = index;
                        } else {
                            self.close_menu();
                        }
                    }
                }
                KeyCode::Up | KeyCode::BackTab => self.move_menu(-1),
                KeyCode::Down | KeyCode::Tab => self.move_menu(1),
                KeyCode::Home => {
                    if let Some(popup) = &mut self.services.popup {
                        popup.selected = 0;
                    }
                }
                KeyCode::End => {
                    if let Some(popup) = &mut self.services.popup {
                        popup.selected = popup.items().len().saturating_sub(1);
                    }
                }
                KeyCode::Enter | KeyCode::Right | KeyCode::Char(' ') => self.activate_menu(),
                _ => {}
            }
            return true;
        }
        if let Event::Mouse(mouse) = event
            && self.services.popup.is_some()
        {
            if mouse.kind == MouseEventKind::ScrollDown {
                self.move_menu(1);
                return true;
            }
            if mouse.kind == MouseEventKind::ScrollUp {
                self.move_menu(-1);
                return true;
            }
            let area = self.menu_area(CellRect::new(0, 0, self.columns, self.rows));
            let inside = mouse.column > area.x
                && mouse.column.saturating_add(1) < area.right()
                && mouse.row > area.y
                && mouse.row.saturating_add(1) < area.bottom();
            if inside && let Some(popup) = &mut self.services.popup {
                let top = popup
                    .selected
                    .saturating_sub(area.height.saturating_sub(3) as usize);
                popup.selected = top + usize::from(mouse.row - area.y - 1);
            }
            if matches!(mouse.kind, MouseEventKind::Down(_)) {
                if inside {
                    self.activate_menu();
                } else {
                    self.close_menu();
                }
            }
            return true;
        }
        self.services.popup.is_some()
    }

    fn move_menu(&mut self, direction: isize) {
        if let Some(popup) = &mut self.services.popup {
            let len = popup.items().len();
            for _ in 0..len {
                popup.selected =
                    (popup.selected as isize + direction).rem_euclid(len as isize) as usize;
                if menu_enabled(&popup.items()[popup.selected]) {
                    break;
                }
            }
        }
    }
    fn activate_menu(&mut self) {
        let item = self
            .services
            .popup
            .as_ref()
            .and_then(|popup| popup.items().get(popup.selected))
            .cloned();
        match item {
            Some(MenuItem::Action(action)) if action.enabled => {
                self.services.popup = None;
                self.choose_menu(action);
                self.menu_closed();
            }
            Some(MenuItem::Submenu { enabled: true, .. }) => {
                if let Some(popup) = &mut self.services.popup {
                    popup.path.push(popup.selected);
                    popup.selected = popup.items().iter().position(menu_enabled).unwrap_or(0);
                }
            }
            _ => {}
        }
    }
    fn choose_menu(&mut self, action: MenuAction) {
        if let Some(role) = action.role {
            let key = match role {
                MenuRole::Quit | MenuRole::Close => {
                    self.quit = true;
                    return;
                }
                MenuRole::Undo => Some('z'),
                MenuRole::Redo => Some('y'),
                MenuRole::Cut => Some('x'),
                MenuRole::Copy => Some('c'),
                MenuRole::Paste => Some('v'),
                MenuRole::SelectAll => Some('a'),
                _ => None,
            };
            if let Some(key) = key {
                self.handle_event(Event::Key(KeyEvent::new(
                    KeyCode::Char(key),
                    KeyModifiers::CONTROL,
                )));
            }
        } else if action.id != 0 {
            self.emit(
                ROOT_ID,
                EventKind::Menu,
                EventPayload::Map(vec![("id", PayloadValue::Number(action.id as f64))]),
            );
        }
    }
    fn close_menu(&mut self) {
        if self.services.popup.take().is_some() {
            self.menu_closed();
        }
    }
    fn menu_closed(&mut self) {
        self.emit(
            ROOT_ID,
            EventKind::Menu,
            EventPayload::Map(vec![
                ("id", PayloadValue::Number(0.0)),
                ("closed", PayloadValue::Bool(true)),
            ]),
        );
    }
    fn menu_area(&self, area: CellRect) -> CellRect {
        let Some(popup) = &self.services.popup else {
            return CellRect::default();
        };
        let width = popup
            .items()
            .iter()
            .map(|item| {
                unicode_width::UnicodeWidthStr::width(menu_label(item).as_str())
                    .min(u16::MAX as usize) as u16
            })
            .max()
            .unwrap_or(12)
            .saturating_add(4)
            .min(area.width);
        let height = (popup.items().len().min(u16::MAX as usize) as u16)
            .saturating_add(2)
            .min(area.height);
        let (x, y) = popup
            .at
            .map(|position| {
                (
                    (position.x / self.metrics.width()).max(0.0) as u16,
                    (position.y / self.metrics.height()).max(0.0) as u16,
                )
            })
            .unwrap_or((1, 1));
        CellRect::new(
            area.x + x.min(area.width.saturating_sub(width)),
            area.y + y.min(area.height.saturating_sub(height)),
            width,
            height,
        )
    }
    pub(crate) fn render_service_overlay(&self, area: CellRect, buffer: &mut Buffer) {
        let Some(popup) = &self.services.popup else {
            return;
        };
        let bounds = self.menu_area(area);
        Clear.render(bounds, buffer);
        Block::default()
            .borders(Borders::ALL)
            .style(Style::default().fg(Color::White).bg(Color::DarkGray))
            .render(bounds, buffer);
        let top = popup
            .selected
            .saturating_sub(bounds.height.saturating_sub(3) as usize);
        for (row, (index, item)) in popup
            .items()
            .iter()
            .enumerate()
            .skip(top)
            .take(bounds.height.saturating_sub(2) as usize)
            .enumerate()
        {
            let mut style = Style::default()
                .fg(if menu_enabled(item) {
                    Color::White
                } else {
                    Color::Gray
                })
                .bg(Color::DarkGray);
            if index == popup.selected {
                style = style.bg(Color::Blue).add_modifier(Modifier::BOLD);
            }
            buffer.set_stringn(
                bounds.x + 1,
                bounds.y + 1 + row as u16,
                menu_label(item),
                bounds.width.saturating_sub(2) as usize,
                style,
            );
        }
    }
}

fn menu_enabled(item: &MenuItem) -> bool {
    match item {
        MenuItem::Separator => false,
        MenuItem::Action(action) => action.enabled,
        MenuItem::Submenu { enabled, .. } => *enabled,
    }
}

fn semantic_text(surface: &Surface, id: NodeId, depth: usize, exposed: &[bool]) -> String {
    if depth > 128 || !exposed.get(id as usize).copied().unwrap_or(false) {
        return String::new();
    }
    let Some(node) = surface.node(id) else {
        return String::new();
    };
    if node.props.accessibility.hidden || node.input.secure {
        return String::new();
    }
    let mut text = node
        .text
        .as_ref()
        .map(|(text, ..)| text.text.clone())
        .unwrap_or_default();
    for child in &node.children {
        let child = semantic_text(surface, *child, depth + 1, exposed);
        if !child.is_empty() {
            if !text.is_empty() {
                text.push(' ');
            }
            text.push_str(&child);
        }
    }
    text
}
fn menu_label(item: &MenuItem) -> String {
    match item {
        MenuItem::Separator => "────────".into(),
        MenuItem::Action(action) => format!(
            "{}{}{}",
            if action.checked == Some(true) {
                "✓ "
            } else {
                "  "
            },
            plain(&action.label, false),
            action
                .shortcut
                .map(|shortcut| format!("  {}", shortcut.label()))
                .unwrap_or_default()
        ),
        MenuItem::Submenu { label, .. } => format!("  {}  ›", plain(label, false)),
    }
}
fn key_shortcut(key: KeyEvent) -> Option<Shortcut> {
    use nsh_core::desktop::Key;
    let code = match key.code {
        KeyCode::Char(' ') => Key::Space,
        KeyCode::Char(ch) => Key::Char(ch.to_ascii_lowercase()),
        KeyCode::Enter => Key::Enter,
        KeyCode::Esc => Key::Escape,
        KeyCode::Tab | KeyCode::BackTab => Key::Tab,
        KeyCode::Backspace => Key::Backspace,
        KeyCode::Delete => Key::Delete,
        KeyCode::Insert => Key::Insert,
        KeyCode::Home => Key::Home,
        KeyCode::End => Key::End,
        KeyCode::PageUp => Key::PageUp,
        KeyCode::PageDown => Key::PageDown,
        KeyCode::Left => Key::Left,
        KeyCode::Right => Key::Right,
        KeyCode::Up => Key::Up,
        KeyCode::Down => Key::Down,
        KeyCode::F(n) => Key::F(n),
        _ => return None,
    };
    Some(Shortcut {
        key: code,
        ctrl: key.modifiers.contains(KeyModifiers::CONTROL),
        alt: key.modifiers.contains(KeyModifiers::ALT),
        shift: key.modifiers.contains(KeyModifiers::SHIFT),
        meta: key.modifiers.contains(KeyModifiers::SUPER),
    })
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;

    use nsh_core::{MountBatch, MountItem, access::Capabilities};

    use super::*;

    fn surface() -> Surface {
        Surface::new(40, 12, crate::CellMetrics::default())
    }
    fn denied() -> Access {
        Access {
            declared: Capabilities::from_json(&serde_json::json!({})).unwrap(),
            granted: None,
        }
    }

    #[test]
    fn clipboard_is_local_by_default_and_denial_never_emits_a_transport_write() {
        let mut surface = surface();
        surface.write_clipboard("first".into());
        assert_eq!(surface.clipboard, "first");
        assert!(surface.drain_events().next().is_none());
        let large = "复制内容\n".repeat(100_000);
        surface.write_clipboard(large.clone());
        surface.read_clipboard(6, false);
        assert!(matches!(
            surface.drain_events().next(),
            Some(SurfaceEvent::Event(ROOT_ID, EventKind::Clipboard, EventPayload::Map(fields)))
                if fields.iter().any(|(key, value)| *key == "text" && matches!(value, PayloadValue::Str(text) if text == &large))
        ));
        surface.set_host_services_enabled(true);
        surface.write_clipboard(large.clone());
        assert!(matches!(
            surface.drain_events().next(),
            Some(SurfaceEvent::Service(ServiceRequest::ClipboardWrite(text))) if text == large
        ));
        surface.complete_clipboard(8, false, Ok(ClipboardContent::Text(large.clone())));
        assert!(matches!(
            surface.drain_events().next(),
            Some(SurfaceEvent::Event(ROOT_ID, EventKind::Clipboard, EventPayload::Map(fields)))
                if fields.iter().any(|(key, value)| *key == "text" && matches!(value, PayloadValue::Str(text) if text == &large))
        ));
        surface.set_access(denied());
        surface.write_clipboard("secret".into());
        surface.read_clipboard(7, false);
        let events: Vec<_> = surface.drain_events().collect();
        assert_eq!(surface.clipboard, large);
        assert!(
            matches!(&events[..], [SurfaceEvent::Event(ROOT_ID, EventKind::Clipboard, EventPayload::Map(fields))] if fields.iter().any(|(key,value)| *key == "text" && *value == PayloadValue::Str(String::new())))
        );
    }

    #[test]
    fn terminal_effects_encode_data_without_accepting_control_injection() {
        let raw = "copied\u{1b}]52;c;attack\u{7}\n你好";
        let sequence = ServiceOutput::Clipboard(raw.into()).terminal_sequence(false);
        assert!(sequence.starts_with("\u{1b}]52;c;"));
        assert!(sequence.ends_with("\u{1b}\\"));
        assert!(!sequence.contains("attack"));
        let encoded = sequence
            .strip_prefix("\u{1b}]52;c;")
            .unwrap()
            .strip_suffix("\u{1b}\\")
            .unwrap();
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .unwrap(),
            raw.as_bytes()
        );
        assert_eq!(
            ServiceOutput::Title("title\u{1b}]52;bad\u{7}".into()).terminal_sequence(false),
            "\u{1b}]2;title]52;bad\u{1b}\\"
        );
        let large = "复制内容\n".repeat(100_000);
        for tmux in [false, true] {
            let sequence = ServiceOutput::Clipboard(large.clone()).terminal_sequence(tmux);
            let sequence = if tmux {
                sequence
                    .strip_prefix("\x1bPtmux;")
                    .unwrap()
                    .strip_suffix("\x1b\\")
                    .unwrap()
                    .replace("\x1b\x1b", "\x1b")
            } else {
                sequence
            };
            let encoded = sequence
                .strip_prefix("\x1b]52;c;")
                .unwrap()
                .strip_suffix("\x1b\\")
                .unwrap();
            assert_eq!(
                base64::engine::general_purpose::STANDARD
                    .decode(encoded)
                    .unwrap(),
                large.as_bytes()
            );
        }
    }

    #[test]
    fn popup_reports_selection_before_close_and_can_render_in_an_embedding_region() {
        let mut surface = surface();
        surface.desktop_command(DesktopCommand::PopupMenu {
            items: vec![MenuItem::Action(MenuAction {
                id: 42,
                label: "Deploy 服务".into(),
                shortcut: None,
                enabled: true,
                checked: Some(true),
                role: None,
                when: nsh_core::keymap::When::Always,
            })]
            .into(),
            at: None,
        });
        let area = CellRect::new(5, 3, 30, 8);
        let mut buffer = Buffer::empty(CellRect::new(0, 0, 50, 20));
        surface.render_service_overlay(area, &mut buffer);
        assert!(buffer.content.iter().any(|cell| cell.symbol() == "D"));
        assert_eq!(buffer[(0, 0)].symbol(), " ");
        assert!(surface.service_event(&Event::Key(KeyEvent::new(
            KeyCode::Enter,
            KeyModifiers::NONE
        ))));
        let events: Vec<_> = surface.drain_events().collect();
        assert!(
            matches!(&events[..], [SurfaceEvent::Event(ROOT_ID,EventKind::Menu,EventPayload::Map(chosen)),SurfaceEvent::Event(ROOT_ID,EventKind::Menu,EventPayload::Map(closed))] if chosen.contains(&("id",PayloadValue::Number(42.0))) && closed.contains(&("closed",PayloadValue::Bool(true))))
        );
    }

    #[test]
    fn menu_shortcuts_respect_the_focused_fields_editing_keys() {
        use nsh_core::keymap::When;
        let mut surface = surface();
        surface.apply(MountBatch {
            items: vec![MountItem::Create {
                id: 2,
                kind: ViewKind::Input,
            }],
        });
        surface.focus = Some(2);
        for (when, fires) in [
            (When::Auto, false),
            (When::NotEditing, false),
            (When::Always, true),
        ] {
            surface.services.menu = Some(
                vec![MenuItem::Action(MenuAction {
                    id: 42,
                    label: "Move".into(),
                    shortcut: Some(Shortcut::parse("left", false).unwrap()),
                    enabled: true,
                    checked: None,
                    role: None,
                    when,
                })]
                .into(),
            );
            assert_eq!(
                surface.service_event(&Event::Key(KeyEvent::new(
                    KeyCode::Left,
                    KeyModifiers::NONE
                ))),
                fires
            );
            surface.drain_events().for_each(drop);
        }
        surface.focus = None;
        surface.services.menu = Some(
            vec![MenuItem::Action(MenuAction {
                id: 42,
                label: "Move".into(),
                shortcut: Some(Shortcut::parse("left", false).unwrap()),
                enabled: true,
                checked: None,
                role: None,
                when: When::NotEditing,
            })]
            .into(),
        );
        assert!(surface.service_event(&Event::Key(KeyEvent::new(
            KeyCode::Left,
            KeyModifiers::NONE
        ))));
    }

    #[test]
    fn wheel_burst_moves_each_menu_detent_past_disabled_entries() {
        let mut surface = surface();
        let items = (0..5)
            .map(|id| {
                MenuItem::Action(MenuAction {
                    id,
                    label: format!("Item {id}"),
                    shortcut: None,
                    enabled: id != 1,
                    checked: None,
                    role: None,
                    when: nsh_core::keymap::When::Always,
                })
            })
            .collect::<Vec<_>>();
        surface.desktop_command(DesktopCommand::PopupMenu {
            items: items.into(),
            at: None,
        });
        assert_eq!(
            surface.handle_wheel(
                MouseEvent {
                    kind: MouseEventKind::ScrollDown,
                    column: 2,
                    row: 2,
                    modifiers: KeyModifiers::NONE,
                },
                3
            ),
            3
        );
        assert_eq!(surface.services.popup.as_ref().unwrap().selected, 4);
        assert!(surface.handle_event(Event::Key(KeyEvent::new(
            KeyCode::Enter,
            KeyModifiers::NONE
        ))));
        let chosen = surface.drain_events().find_map(|event| match event {
            SurfaceEvent::Event(ROOT_ID, EventKind::Menu, EventPayload::Map(fields)) => fields
                .into_iter()
                .find_map(|(key, value)| (key == "id").then_some(value)),
            _ => None,
        });
        assert_eq!(chosen, Some(PayloadValue::Number(4.0)));
    }

    #[test]
    fn semantic_snapshot_omits_hidden_descendants_and_secure_field_values() {
        let mut surface = surface();
        let mut props = nsh_core::ViewProps::default();
        props.accessibility.label = Some("Password".into());
        props.accessibility.value = Some(AccessibilityValue {
            text: Some("never expose".into()),
            ..Default::default()
        });
        let input = nsh_core::InputConfig {
            secure: true,
            ..Default::default()
        };
        surface.apply(MountBatch {
            items: vec![
                MountItem::Create {
                    id: 2,
                    kind: ViewKind::Input,
                },
                MountItem::Insert {
                    parent: ROOT_ID,
                    child: 2,
                    before: None,
                },
                MountItem::Frame {
                    id: 2,
                    frame: Bounds::new(
                        nsh_core::Point::new(
                            nsh_core::geometry::px(0.0),
                            nsh_core::geometry::px(0.0),
                        ),
                        nsh_core::Size::new(
                            nsh_core::geometry::px(100.0),
                            nsh_core::geometry::px(32.0),
                        ),
                    ),
                },
                MountItem::Input {
                    id: 2,
                    config: Box::new(input),
                },
                MountItem::ViewProps {
                    id: 2,
                    props: Box::new(props),
                },
            ],
        });
        let snapshot = surface.accessibility_snapshot();
        assert_eq!(snapshot.len(), 1);
        assert_eq!(snapshot[0].label, "Password");
        assert!(snapshot[0].value.is_none());
    }

    #[test]
    fn asynchronous_paste_does_not_replace_a_selection_that_the_user_moved() {
        let mut surface = surface();
        surface.apply(MountBatch {
            items: vec![
                MountItem::Create {
                    id: 2,
                    kind: ViewKind::Input,
                },
                MountItem::Insert {
                    parent: ROOT_ID,
                    child: 2,
                    before: None,
                },
                MountItem::Frame {
                    id: 2,
                    frame: Bounds::new(
                        nsh_core::Point::new(
                            nsh_core::geometry::px(0.0),
                            nsh_core::geometry::px(0.0),
                        ),
                        nsh_core::Size::new(
                            nsh_core::geometry::px(120.0),
                            nsh_core::geometry::px(32.0),
                        ),
                    ),
                },
                MountItem::InputValue {
                    id: 2,
                    text: "abc".into(),
                    count: 0,
                },
            ],
        });
        surface.set_focus(Some(2));
        surface.selection(2, 0, 0);
        let context = surface.input_context().unwrap();
        let edit = InputEdit {
            node: 2,
            expected_event_count: context.event_count,
            selection: context.selection,
            replacement: String::new(),
        };
        surface.selection(2, 1, 1);
        surface.complete_paste(edit, Ok(ClipboardContent::Text("late".into())));
        assert_eq!(
            surface.input_context().unwrap().text.as_deref(),
            Some("abc")
        );
        let context = surface.input_context().unwrap();
        let edit = InputEdit {
            node: 2,
            expected_event_count: context.event_count,
            selection: context.selection,
            replacement: String::new(),
        };
        let large = "复制内容".repeat(100_000);
        surface.complete_paste(edit, Ok(ClipboardContent::Text(large.clone())));
        assert_eq!(
            surface.input_context().unwrap().text,
            Some(format!("a{large}bc"))
        );
    }

    struct FakeHost(Arc<AtomicUsize>);
    impl HostServices for FakeHost {
        fn read_clipboard(
            &self,
            has_only: bool,
            _: &ServiceCancellation,
        ) -> Result<ClipboardContent, String> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(if has_only {
                ClipboardContent::HasText(true)
            } else {
                ClipboardContent::Text("host text".into())
            })
        }
    }

    #[test]
    fn asynchronous_host_reads_return_typed_results_and_obey_current_access() {
        let calls = Arc::new(AtomicUsize::new(0));
        let manager = ServiceManager::new(Arc::new(FakeHost(calls.clone()))).unwrap();
        manager
            .submit(ServiceRequest::ClipboardRead {
                id: 5,
                has_only: true,
            })
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        let completion = loop {
            if let Some(completion) = manager.poll().next() {
                break completion;
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(2));
        };
        assert!(matches!(
            completion.result,
            Ok(Some(ClipboardContent::HasText(true)))
        ));
        manager.reset(denied());
        manager
            .submit(ServiceRequest::ClipboardRead {
                id: 6,
                has_only: false,
            })
            .unwrap();
        std::thread::sleep(Duration::from_millis(40));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[cfg(unix)]
    #[test]
    fn clipboard_helper_cancellation_kills_and_reaps_the_owned_process_group() {
        let control = Arc::new(Control {
            epoch: AtomicU64::new(1),
            running: AtomicBool::new(true),
            access: RwLock::new(Access::all()),
        });
        let cancel = ServiceCancellation {
            control: control.clone(),
            epoch: 1,
            clipboard: true,
        };
        let large = "复制内容\n".repeat(100_000).into_bytes();
        let (copied, owner) =
            run_helper("/bin/cat", &[], Some(large.clone()), false, &cancel).unwrap();
        assert_eq!(copied, large);
        assert!(owner.is_none());
        let worker = std::thread::spawn(move || {
            run_helper("/bin/sh", &["-c", "sleep 30"], None, false, &cancel)
        });
        std::thread::sleep(Duration::from_millis(30));
        let stopped = Instant::now();
        control.running.store(false, Ordering::Release);
        assert!(worker.join().unwrap().is_err());
        assert!(stopped.elapsed() < Duration::from_secs(1));
    }
}
