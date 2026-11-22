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

use super::{ApplicationClient, Client, Owner, execute};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use nsh_core::prelude::*;
#[cfg(target_os = "macos")]
use std::ffi::{CStr, CString, c_char, c_void};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
#[cfg(target_os = "macos")]
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

#[cfg(target_os = "macos")]
type Capture = Result<Option<String>, String>;
#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn maka_has_dictation_key() -> bool;
    fn maka_input_devices(
        context: *mut c_void,
        append: extern "C" fn(*mut c_void, *const c_char, *const c_char),
    );
    fn maka_record_stop(
        path: *const c_char,
        context: *mut c_void,
        done: Option<extern "C" fn(*mut c_void, f64)>,
    );
    fn maka_record_sample(
        path: *const c_char,
        context: *mut c_void,
        done: extern "C" fn(*mut c_void, f64),
    );
    fn maka_record_message(
        path: *const c_char,
        uid: *const c_char,
        chinese: bool,
        model_connection: bool,
        quick_launcher: bool,
        context: *mut c_void,
        done: extern "C" fn(*mut c_void, *const c_char, *const c_char),
    );
}

#[cfg(target_os = "macos")]
extern "C" fn captured(context: *mut c_void, key: *const c_char, error: *const c_char) {
    // The sheet calls back exactly once. Its strings stay alive for this call.
    unsafe {
        let sender = Box::from_raw(context.cast::<oneshot::Sender<Capture>>());
        let string = |p| CStr::from_ptr(p).to_string_lossy().into_owned();
        let _ = sender.send(if !error.is_null() {
            Err(string(error))
        } else {
            Ok((!key.is_null()).then(|| string(key)))
        });
    }
}

#[cfg(target_os = "macos")]
extern "C" fn sampled(context: *mut c_void, value: f64) {
    // Native calls once for each queued sample or stop, including after cancellation.
    let sender = unsafe { Box::from_raw(context.cast::<oneshot::Sender<f64>>()) };
    let _ = sender.send(value);
}

pub(super) fn microphones() -> Vec<serde_json::Value> {
    #[cfg(target_os = "macos")]
    {
        extern "C" fn append(context: *mut c_void, uid: *const c_char, name: *const c_char) {
            // The synchronous enumeration lends these two strings for the callback.
            unsafe {
                let devices = &mut *context.cast::<Vec<serde_json::Value>>();
                devices.push(serde_json::json!({
                    "id": CStr::from_ptr(uid).to_string_lossy(),
                    "name": CStr::from_ptr(name).to_string_lossy(),
                }));
            }
        }
        let mut devices = Vec::new();
        unsafe {
            maka_input_devices((&raw mut devices).cast(), append);
        }
        devices
    }
    #[cfg(not(target_os = "macos"))]
    Vec::new()
}

pub(super) fn legacy_key() -> bool {
    #[cfg(target_os = "macos")]
    unsafe {
        maka_has_dictation_key()
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

#[class]
pub struct MessageDictation {
    owner: Arc<Owner>,
    source: ApplicationClient,
    model: OnceLock<(Client, serde_json::Value)>,
    directory: Arc<tempfile::TempDir>,
    #[cfg(target_os = "macos")]
    path: CString,
    key: OnceLock<String>,
    cancelled: CancellationToken,
}

impl MessageDictation {
    pub(super) fn new(owner: Arc<Owner>, source: ApplicationClient) -> Result<Self, String> {
        let directory = tempfile::tempdir().map_err(|e| e.to_string())?;
        #[cfg(target_os = "macos")]
        let path = CString::new(
            directory
                .path()
                .join("speech.wav")
                .as_os_str()
                .as_encoded_bytes(),
        )
        .map_err(|e| e.to_string())?;
        Ok(Self {
            owner,
            source,
            model: OnceLock::new(),
            directory: Arc::new(directory),
            #[cfg(target_os = "macos")]
            path,
            key: OnceLock::new(),
            cancelled: CancellationToken::new(),
        })
    }
    fn stop(&self) {
        #[cfg(target_os = "macos")]
        unsafe {
            maka_record_stop(self.path.as_ptr(), std::ptr::null_mut(), None)
        };
    }
}

impl Drop for MessageDictation {
    fn drop(&mut self) {
        self.cancel();
    }
}

#[class]
impl MessageDictation {
    pub async fn start(
        this: Instance<Self>,
        chinese: bool,
        connection: Option<serde_json::Value>,
        quick_launcher: Option<bool>,
    ) -> Result<bool, String> {
        #[cfg(target_os = "macos")]
        {
            // NSH installs the storage context for async engine tasks.
            let prefix =
                this.with(|r| format!("dictation.{}.", r.owner.client.source().state_domain));
            if nsh_core::storage::Storage::get_item(&format!("{prefix}enabled")).as_deref()
                != Some("true")
            {
                return Err("Dictation is off".into());
            }
            let device = CString::new(
                nsh_core::storage::Storage::get_item(&format!("{prefix}microphone"))
                    .unwrap_or_default(),
            )
            .map_err(|_| "Invalid microphone identifier")?;
            let model_connection = connection.is_some();
            if let Some(connection) = connection {
                let (owner, source) = this.with(|r| (r.owner.clone(), r.source.clone()));
                let client =
                    execute(owner.clone(), async move { source.resolve(&owner).await }).await?;
                this.with(|r| {
                    r.model
                        .set((client, connection))
                        .map_err(|_| "Already recording")
                })?;
            }
            let (tx, rx) = oneshot::channel::<Capture>();
            this.with(|recording| {
                if recording.cancelled.is_cancelled() {
                    return Err("Dictation cancelled".to_string());
                }
                // The native callback owns tx until the permission or recording request resolves.
                unsafe {
                    maka_record_message(
                        recording.path.as_ptr(),
                        device.as_ptr(),
                        chinese,
                        model_connection,
                        quick_launcher.unwrap_or(false),
                        Box::into_raw(Box::new(tx)).cast(),
                        captured,
                    )
                };
                Ok(())
            })?;
            let key = rx.await.map_err(|e| e.to_string())??;
            this.with(|recording| {
                let Some(key) = key else { return Ok(false) };
                if recording.cancelled.is_cancelled() {
                    return Ok(false);
                }
                recording
                    .key
                    .set(key)
                    .map_err(|_| "Already recording".to_string())?;
                Ok(true)
            })
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (this, chinese, connection, quick_launcher);
            Err("Dictation requires macOS".into())
        }
    }

    pub async fn level(this: Instance<Self>) -> Result<f64, String> {
        #[cfg(target_os = "macos")]
        {
            let (tx, rx) = oneshot::channel::<f64>();
            this.with(|r| unsafe {
                maka_record_sample(r.path.as_ptr(), Box::into_raw(Box::new(tx)).cast(), sampled)
            });
            rx.await.map_err(|e| e.to_string())
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = this;
            Ok(-1.0)
        }
    }

    pub fn cancel(&self) {
        self.cancelled.cancel();
        self.stop();
    }

    pub async fn finish(this: Instance<Self>) -> Result<String, String> {
        #[cfg(target_os = "macos")]
        {
            // Wait until the input queue has stopped and the WAV is finalized.
            let (tx, rx) = oneshot::channel::<f64>();
            this.with(|r| unsafe {
                maka_record_stop(
                    r.path.as_ptr(),
                    Box::into_raw(Box::new(tx)).cast(),
                    Some(sampled),
                )
            });
            if rx.await.map_err(|e| e.to_string())? < 0.0 {
                return Err("No microphone audio was recorded.".into());
            }
        }
        let (owner, directory, key, model, cancelled) = this.with(|r| {
            (
                r.owner.clone(),
                r.directory.clone(),
                r.key.get().cloned(),
                r.model.get().cloned(),
                r.cancelled.clone(),
            )
        });
        let key = key.ok_or("Recording has not started")?;
        execute(owner, async move {
            tokio::select! {
                biased;
                _ = cancelled.cancelled() => Err("Dictation cancelled".into()),
                result = async {
                    let wav = tokio::fs::read(directory.path().join("speech.wav")).await.map_err(|e|e.to_string())?;
                    if let Some((client, connection)) = model {
                        let result = client.query("settings", "transcribeDictation",
                            serde_json::json!({"connection": connection, "audio": STANDARD.encode(wav)})).await.map_err(|e| e.to_string())?;
                        result.as_str().map(str::to_owned).ok_or_else(|| "Missing transcript".into())
                    } else {
                        transcribe(wav, &key).await
                    }
                } => result
            }
        }).await
    }
}

async fn transcribe(wav: Vec<u8>, key: &str) -> Result<String, String> {
    use reqwest::{
        Client,
        multipart::{Form, Part},
        redirect::Policy,
    };
    let file = Part::bytes(wav)
        .file_name("speech.wav")
        .mime_str("audio/wav")
        .map_err(|e| e.to_string())?;
    let response = Client::builder()
        .timeout(Duration::from_secs(90))
        .redirect(Policy::none())
        .build()
        .map_err(|e| e.to_string())?
        .post("https://api.deepseek.com/v1/tools/asr")
        .bearer_auth(key)
        .multipart(Form::new().part("file", file))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    #[derive(serde::Deserialize)]
    struct Transcript {
        text: String,
    }
    let result: Transcript =
        serde_json::from_slice(&response.bytes().await.map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    Ok(result.text)
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore = "uses a DeepSeek key and a short, billable synthetic recording"]
    async fn recognizes_synthesized_speech() {
        let directory = tempfile::tempdir().unwrap();
        let wav = directory.path().join("sample.wav");
        let result = std::process::Command::new("/usr/bin/say")
            .args([
                "-v",
                "Samantha",
                "--file-format=WAVE",
                "--data-format=LEI16@16000",
                "-o",
            ])
            .arg(&wav)
            .arg("The meeting starts on Friday at noon.")
            .status()
            .unwrap();
        assert!(result.success());
        let key = std::env::var("DEEPSEEK_API_KEY").unwrap();
        let text = transcribe(std::fs::read(wav).unwrap(), &key).await.unwrap();
        assert!(text.to_lowercase().contains("friday"), "{text:?}");
    }
}
