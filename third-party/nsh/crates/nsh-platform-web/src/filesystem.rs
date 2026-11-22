//! App-private persistent files on the browser's Origin Private File System.

use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    future::Future,
    pin::Pin,
    rc::Rc,
    task::{Context, Poll, Waker},
};

use nsh_core::{
    element::JsError,
    filesystem::{FileEntry, FileMetadata, FileOperation, FileRequest, FileResponse, FileSystem},
};

use crate::ffi;

type Reply = Result<FileResponse, JsError>;
#[derive(Default)]
struct Pending {
    result: Option<Reply>,
    waker: Option<Waker>,
}
thread_local! {
    static REQUESTS: RefCell<HashMap<u32, Rc<RefCell<Pending>>>> = RefCell::new(HashMap::new());
    static NEXT: Cell<u32> = const { Cell::new(1) };
}
/// The files of one app, under its persistent browser namespace.
pub(crate) struct BrowserFileSystem {
    pub(crate) namespace: String,
}
impl FileSystem for BrowserFileSystem {
    fn execute(&self, request: FileRequest) -> Pin<Box<dyn Future<Output = Reply> + 'static>> {
        let id = NEXT.with(|n| n.replace(n.get().wrapping_add(1).max(1)));
        let mut json = serde_json::json!({"namespace":self.namespace,"path":request.path});
        let mut bytes = Vec::new();
        let op = match request.operation {
            FileOperation::Read { max_bytes } => {
                json["maxBytes"] = max_bytes.into();
                "read"
            }
            FileOperation::Write(data) => {
                bytes = data;
                "write"
            }
            FileOperation::Entries {
                max_entries,
                max_name_bytes,
            } => {
                json["maxEntries"] = max_entries.into();
                json["maxNameBytes"] = max_name_bytes.into();
                "entries"
            }
            FileOperation::Exists => "exists",
            FileOperation::Mkdir { recursive } => {
                json["recursive"] = recursive.into();
                "mkdir"
            }
            FileOperation::Unlink => "unlink",
            FileOperation::Rmdir => "rmdir",
            FileOperation::Stat { .. } => "stat",
            FileOperation::Rename { to } => {
                json["to"] = to.into();
                "rename"
            }
            FileOperation::Readlink => "readlink",
        };
        json["op"] = op.into();
        let pending = Rc::new(RefCell::new(Pending::default()));
        REQUESTS.with(|r| r.borrow_mut().insert(id, pending.clone()));
        ffi::filesystem_start(id, &json.to_string(), &bytes);
        Box::pin(Request { id, pending })
    }
}
struct Request {
    id: u32,
    pending: Rc<RefCell<Pending>>,
}
impl Future for Request {
    type Output = Reply;
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Reply> {
        let mut state = self.pending.borrow_mut();
        match state.result.take() {
            Some(value) => Poll::Ready(value),
            None => {
                state.waker = Some(cx.waker().clone());
                Poll::Pending
            }
        }
    }
}
impl Drop for Request {
    fn drop(&mut self) {
        REQUESTS.with(|r| r.borrow_mut().remove(&self.id));
        ffi::filesystem_cancel(self.id);
    }
}
/// Receives an OPFS operation result and resumes the engine.
///
/// # Safety
/// Both input regions are allocated by `nsh_alloc` and valid for their lengths.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_filesystem_reply(
    id: u32,
    p: *const u8,
    l: usize,
    bp: *const u8,
    bl: usize,
) -> f64 {
    // SAFETY: guaranteed by the caller.
    let json = unsafe { crate::string(p, l) };
    // SAFETY: guaranteed by the caller.
    let bytes = unsafe { crate::bytes(bp, bl) };
    let result = serde_json::from_str::<serde_json::Value>(&json)
        .map_err(|e| JsError::Error(e.to_string()))
        .and_then(|v| {
            if let Some(message) = v["error"].as_str() {
                return Err(JsError::Error(message.into())
                    .with_code(v["code"].as_str().unwrap_or("EIO"))
                    .with("syscall", v["syscall"].as_str().unwrap_or(""))
                    .with("path", v["path"].as_str().unwrap_or("")));
            }
            Ok(match v["kind"].as_str().unwrap_or("") {
                "bytes" => FileResponse::Bytes(bytes.to_vec()),
                "exists" => FileResponse::Exists(v["value"].as_bool().unwrap_or(false)),
                "entries" => FileResponse::Entries(
                    v["entries"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|e| FileEntry {
                            name: e["name"].as_str().unwrap_or("").into(),
                            directory: e["directory"].as_bool().unwrap_or(false),
                        })
                        .collect(),
                ),
                "metadata" => FileResponse::Metadata(FileMetadata {
                    size: v["size"].as_u64().unwrap_or(0),
                    mode: 0,
                    mtime_ms: v["mtime"].as_f64().unwrap_or(0.0),
                    atime_ms: 0.0,
                    birthtime_ms: 0.0,
                    file: v["file"].as_bool().unwrap_or(false),
                    directory: v["directory"].as_bool().unwrap_or(false),
                    symlink: false,
                }),
                _ => FileResponse::Unit,
            })
        });
    if let Some(state) = REQUESTS.with(|r| r.borrow_mut().remove(&id)) {
        let wake = {
            let mut state = state.borrow_mut();
            state.result = Some(result);
            state.waker.take()
        };
        if let Some(wake) = wake {
            wake.wake();
        }
    }
    crate::pump()
}
