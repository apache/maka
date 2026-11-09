/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

//! Chrome's native-messaging protocol, with session-scoped tab identities.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Read, Write},
    os::unix::{
        fs::PermissionsExt,
        net::{UnixListener, UnixStream},
    },
    path::{Path, PathBuf},
    sync::{Arc, Mutex, Weak, mpsc},
    time::Duration,
};
use uuid::Uuid;
const MAX_MESSAGE: usize = 16 * 1024 * 1024;
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Tab {
    id: u32,
    window_id: i64,
    title: String,
    url: String,
    pinned: bool,
}
struct Peer {
    stream: Arc<Mutex<UnixStream>>,
    tabs: Vec<Tab>,
}
struct Pending {
    peer: Uuid,
    reply: mpsc::SyncSender<Result<(), String>>,
}
#[derive(Default)]
struct State {
    peers: HashMap<Uuid, Peer>,
    pending: HashMap<Uuid, Pending>,
}
struct Inner {
    directory: PathBuf,
    state: Mutex<State>,
    _lock: fs::File,
}
impl Drop for Inner {
    fn drop(&mut self) {
        if let Ok(state) = self.state.get_mut() {
            for peer in state.peers.values() {
                let _ = peer
                    .stream
                    .lock()
                    .map(|stream| stream.shutdown(std::net::Shutdown::Both));
            }
        }
        let _ = fs::remove_file(self.directory.join("bridge.sock"));
    }
}
#[derive(Clone)]
pub struct Bridge(Arc<Inner>);
fn bounded_line(reader: &mut impl BufRead) -> std::io::Result<Option<Vec<u8>>> {
    let mut bytes = Vec::new();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return if bytes.is_empty() {
                Ok(None)
            } else {
                Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "incomplete bridge message",
                ))
            };
        }
        let end = available.iter().position(|b| *b == b'\n').map(|i| i + 1);
        let count = end.unwrap_or(available.len());
        if bytes.len() + count > MAX_MESSAGE {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "bridge message too large",
            ));
        }
        bytes.extend_from_slice(&available[..count]);
        reader.consume(count);
        if end.is_some() {
            return Ok(Some(bytes));
        }
    }
}
impl Bridge {
    pub fn start(root: &Path) -> Result<Self, String> {
        use sha2::{Digest, Sha256};
        use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
        // Short path for Darwin's 104-byte sockaddr_un; never a shared socket directory.
        fs::create_dir_all(root).map_err(|e| e.to_string())?;
        let identity = Sha256::digest(root.as_os_str().as_encoded_bytes());
        let suffix: String = identity[..12].iter().map(|b| format!("{b:02x}")).collect();
        let directory = Path::new("/tmp").join(format!("maka-tabs-{suffix}"));
        match fs::DirBuilder::new().mode(0o700).create(&directory) {
            Ok(()) => (),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
            Err(e) => return Err(e.to_string()),
        }
        let metadata = fs::symlink_metadata(&directory).map_err(|e| e.to_string())?;
        if !metadata.is_dir()
            || metadata.uid() != fs::metadata(root).map_err(|e| e.to_string())?.uid()
            || metadata.mode() & 0o077 != 0
        {
            return Err("Unsafe Chrome bridge directory".into());
        }
        let lock = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .mode(0o600)
            .open(directory.join("owner.lock"))
            .map_err(|e| e.to_string())?;
        lock.try_lock()
            .map_err(|_| "Another Maka instance owns this Chrome bridge")?;
        match fs::remove_file(directory.join("bridge.sock")) {
            Ok(()) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(e.to_string()),
        }
        let listener =
            UnixListener::bind(directory.join("bridge.sock")).map_err(|e| e.to_string())?;
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let inner = Arc::new(Inner {
            directory,
            state: Mutex::new(State::default()),
            _lock: lock,
        });
        let weak = Arc::downgrade(&inner);
        std::thread::spawn(move || {
            while let Some(inner) = weak.upgrade() {
                match listener.accept() {
                    Ok((stream, _)) => {
                        if stream.set_nonblocking(false).is_err() {
                            continue;
                        }
                        let mut state = inner.state.lock().unwrap_or_else(|e| e.into_inner());
                        if state.peers.len() >= 8 {
                            continue;
                        }
                        let id = Uuid::new_v4();
                        let Ok(writer) = stream.try_clone() else {
                            continue;
                        };
                        let _ = writer.set_write_timeout(Some(Duration::from_secs(2)));
                        state.peers.insert(
                            id,
                            Peer {
                                stream: Arc::new(Mutex::new(writer)),
                                tabs: vec![],
                            },
                        );
                        let weak = weak.clone();
                        std::thread::spawn(move || receive(weak, id, stream));
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        drop(inner);
                        std::thread::sleep(Duration::from_millis(50));
                    }
                    Err(_) => break,
                }
            }
        });
        Ok(Self(inner))
    }
    pub fn list(&self) -> Value {
        let state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        let tabs: Vec<Value> = state.peers.iter().flat_map(|(id, p)| p.tabs.iter().map(move |t| json!({"key":format!("{id}:{}",t.id),"title":t.title,"url":t.url,"pinned":t.pinned,"windowId":t.window_id}))).collect();
        json!({"connected":!state.peers.is_empty(),"tabs":tabs})
    }
    pub fn run(&self, key: &str, action: &str) -> Result<(), String> {
        if !["activate", "close", "pin"].contains(&action) {
            return Err("Unknown tab action".into());
        }
        let (peer, id) = key.split_once(':').ok_or("Invalid tab key")?;
        let peer: Uuid = peer.parse().map_err(|_| "Invalid tab peer")?;
        let id: u32 = id.parse().map_err(|_| "Invalid tab ID")?;
        let request = Uuid::new_v4();
        let (reply, result) = mpsc::sync_channel(1);
        let stream = {
            let mut state = self.0.state.lock().map_err(|e| e.to_string())?;
            let connection = state
                .peers
                .get(&peer)
                .ok_or("Chrome disconnected; search again")?;
            if !connection.tabs.iter().any(|t| t.id == id) {
                return Err("This tab is no longer available".into());
            }
            if state.pending.len() >= 64 {
                return Err("Too many pending Chrome commands".into());
            }
            let stream = connection.stream.clone();
            state.pending.insert(request, Pending { peer, reply });
            stream
        };
        let message = format!(
            "{}\n",
            json!({"type":"command","request":request,"id":id,"action":action})
        );
        let sent = stream
            .lock()
            .map_err(|e| e.to_string())?
            .write_all(message.as_bytes())
            .map_err(|e| e.to_string());
        let answer = sent.and_then(|_| {
            result
                .recv_timeout(Duration::from_secs(4))
                .map_err(|_| "Chrome did not respond; reconnect the extension".to_owned())?
        });
        self.0
            .state
            .lock()
            .map_err(|e| e.to_string())?
            .pending
            .remove(&request);
        answer
    }
    pub fn setup(&self, storage: &Path, executable: &Path) -> Result<Value, String> {
        let extension = storage.join("chrome-extension");
        fs::create_dir_all(&extension).map_err(|e| e.to_string())?;
        let manifest: Value = serde_json::from_str(include_str!(
            "../../../../../plugins/application/quick-tools/chrome-extension/manifest.json"
        ))
        .map_err(|e| e.to_string())?;
        fs::write(
            extension.join("manifest.json"),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .map_err(|e| e.to_string())?;
        fs::write(
            extension.join("background.js"),
            include_str!(
                "../../../../../plugins/application/quick-tools/chrome-extension/background.js"
            ),
        )
        .map_err(|e| e.to_string())?;
        // The extension's immutable public key fixes this ID across old and native hosts.
        let id = extension_id(manifest["key"].as_str().ok_or("Extension has no key")?)?;
        let quote = |path: &Path| format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"));
        let launcher = storage.join("chrome-native-host");
        fs::write(
            &launcher,
            format!(
                "#!/bin/sh\nexec {} --quick-tabs-native-host {} \"$@\"\n",
                quote(executable),
                quote(&self.0.directory.join("bridge.sock"))
            ),
        )
        .map_err(|e| e.to_string())?;
        fs::set_permissions(&launcher, fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
        let home = std::env::var_os("HOME").ok_or("HOME is unavailable")?;
        let hosts = PathBuf::from(home)
            .join("Library/Application Support/Google/Chrome/NativeMessagingHosts");
        fs::create_dir_all(&hosts).map_err(|e| e.to_string())?;
        fs::write(hosts.join("org.maka.quick_tabs.json"), serde_json::to_vec_pretty(&json!({"name":"org.maka.quick_tabs","description":"Maka native tab bridge","path":launcher,"type":"stdio","allowed_origins":[format!("chrome-extension://{id}/")]})).unwrap()).map_err(|e| e.to_string())?;
        Ok(json!({"directory":extension,"extensionId":id}))
    }
}
fn extension_id(key: &str) -> Result<String, String> {
    use base64::Engine as _;
    use sha2::{Digest, Sha256};
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(key)
        .map_err(|e| e.to_string())?;
    Ok(Sha256::digest(bytes)[..16]
        .iter()
        .flat_map(|b| [(b >> 4) + b'a', (b & 15) + b'a'])
        .map(char::from)
        .collect())
}
fn receive(weak: Weak<Inner>, id: Uuid, stream: UnixStream) {
    let mut reader = BufReader::new(stream);
    while let Ok(Some(bytes)) = bounded_line(&mut reader) {
        let Some(inner) = weak.upgrade() else {
            break;
        };
        let Ok(message) = serde_json::from_slice::<Value>(&bytes) else {
            break;
        };
        let mut state = inner.state.lock().unwrap_or_else(|e| e.into_inner());
        match message["type"].as_str() {
            Some("tabs") => {
                let Ok(tabs) = serde_json::from_value::<Vec<Tab>>(message["tabs"].clone()) else {
                    break;
                };
                if tabs.len() > 2000
                    || tabs
                        .iter()
                        .any(|t| t.title.len() > 4000 || t.url.len() > 16000)
                {
                    break;
                }
                if let Some(peer) = state.peers.get_mut(&id) {
                    peer.tabs = tabs;
                }
            }
            Some("result") => {
                let Some(request) = message["request"]
                    .as_str()
                    .and_then(|s| s.parse::<Uuid>().ok())
                else {
                    break;
                };
                if let Some(pending) = state.pending.get(&request).filter(|p| p.peer == id) {
                    let result = message["error"]
                        .as_str()
                        .map(|s| Err(s.chars().take(500).collect()))
                        .unwrap_or(Ok(()));
                    let _ = pending.reply.try_send(result);
                }
            }
            _ => break,
        }
    }
    if let Some(inner) = weak.upgrade() {
        let mut state = inner.state.lock().unwrap_or_else(|e| e.into_inner());
        state.peers.remove(&id);
        state.pending.retain(|_, p| {
            if p.peer == id {
                let _ = p.reply.try_send(Err("Chrome disconnected".into()));
                false
            } else {
                true
            }
        });
    }
}
/// Called before GUI/Host admission when Chrome launches this executable.
pub fn native_host(socket: &Path) -> Result<(), String> {
    let stream = UnixStream::connect(socket).map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);
    let mut writer = stream.try_clone().map_err(|e| e.to_string())?;
    std::thread::spawn(move || {
        let mut input = std::io::stdin().lock();
        while let Ok(message) = read_native(&mut input) {
            if writer
                .write_all(&message)
                .and_then(|_| writer.write_all(b"\n"))
                .is_err()
            {
                break;
            }
        }
        let _ = writer.shutdown(std::net::Shutdown::Both);
    });
    let mut output = std::io::stdout().lock();
    while let Some(mut message) = bounded_line(&mut reader).map_err(|e| e.to_string())? {
        if message.last() == Some(&b'\n') {
            message.pop();
        }
        output
            .write_all(&(message.len() as u32).to_le_bytes())
            .and_then(|_| output.write_all(&message))
            .and_then(|_| output.flush())
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn read_native(input: &mut impl Read) -> std::io::Result<Vec<u8>> {
    let mut size = [0; 4];
    input.read_exact(&mut size)?;
    let length = u32::from_le_bytes(size) as usize;
    if length > MAX_MESSAGE {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "native message too large",
        ));
    }
    let mut message = vec![0; length];
    input.read_exact(&mut message)?;
    let value: Value = serde_json::from_slice(&message)?;
    serde_json::to_vec(&value).map_err(std::io::Error::other)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_frames_preserve_json_and_reject_oversized_input() {
        let message = br#"{"type":"tabs","title":"line\nnext"}"#;
        let mut framed = (message.len() as u32).to_le_bytes().to_vec();
        framed.extend_from_slice(message);
        assert_eq!(
            serde_json::from_slice::<Value>(&read_native(&mut &framed[..]).unwrap()).unwrap()["title"],
            "line\nnext"
        );
        assert!(read_native(&mut &((MAX_MESSAGE + 1) as u32).to_le_bytes()[..]).is_err());
        assert!(bounded_line(&mut BufReader::new(&b"unterminated"[..])).is_err());
    }
    #[test]
    fn tab_commands_round_trip_and_old_peers_cannot_address_new_tabs() {
        let root = tempfile::tempdir().unwrap();
        let bridge = Bridge::start(root.path()).unwrap();
        assert!(Bridge::start(root.path()).is_err());
        let mut chrome = UnixStream::connect(bridge.0.directory.join("bridge.sock")).unwrap();
        chrome
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        writeln!(chrome, "{}", json!({"type":"tabs","tabs":[{"id":7,"windowId":1,"title":"Example","url":"https://example.com","pinned":false}]})).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        let key = loop {
            if let Some(key) = bridge.list()["tabs"][0]["key"].as_str() {
                break key.to_owned();
            }
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        };
        let run = bridge.clone();
        let selected = key.clone();
        let action = std::thread::spawn(move || run.run(&selected, "pin"));
        let message = bounded_line(&mut BufReader::new(chrome.try_clone().unwrap()))
            .unwrap()
            .unwrap();
        let command: Value = serde_json::from_slice(&message).unwrap();
        assert_eq!(command["id"], 7);
        assert_eq!(command["action"], "pin");
        writeln!(
            chrome,
            "{}",
            json!({"type":"result","request":command["request"]})
        )
        .unwrap();
        action.join().unwrap().unwrap();
        chrome.shutdown(std::net::Shutdown::Both).unwrap();
        while bridge.list()["connected"] == true {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(bridge.run(&key, "close").is_err());
    }
}
