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

//! GTK persists the normal window size and maximized/fullscreen state.
//! The compositor owns window coordinates, including monitor placement.

use crate::shell::{MIN_SIZE, SIZE};
use nsh_platform_linux::gtk4::{self as gtk, prelude::*};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, PartialEq, Serialize, Deserialize)]
struct Saved {
    width: f32,
    height: f32,
    state: State,
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum State {
    Windowed,
    Maximized,
    Fullscreen,
}

pub struct Placement {
    path: PathBuf,
}

impl Placement {
    pub fn new(directory: &Path) -> Self {
        Self {
            path: directory.join("desktop-window.json"),
        }
    }

    pub fn restore(&self, window: &gtk::ApplicationWindow) {
        let saved = match std::fs::read(&self.path) {
            Ok(bytes) => match serde_json::from_slice::<Saved>(&bytes) {
                Ok(saved) => saved,
                Err(error) => {
                    eprintln!("maka-desktop-shell: {}: {error}", self.path.display());
                    return;
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
            Err(error) => {
                eprintln!("maka-desktop-shell: {}: {error}", self.path.display());
                return;
            }
        };
        let (width, height) = normal_size(&saved);
        window.set_default_size(width, height);
        window.set_maximized(saved.state == State::Maximized);
        window.set_fullscreened(saved.state == State::Fullscreen);
    }

    pub fn save(&self, window: &gtk::ApplicationWindow) {
        // GTK keeps the unmaximized size in default-width/default-height.
        let (width, height) = window.default_size();
        let saved = Saved {
            width: width as f32,
            height: height as f32,
            state: if window.is_fullscreen() {
                State::Fullscreen
            } else if window.is_maximized() {
                State::Maximized
            } else {
                State::Windowed
            },
        };
        let partial = self.path.with_extension("json.partial");
        let write = || -> std::io::Result<()> {
            std::fs::write(&partial, serde_json::to_vec_pretty(&saved)?)?;
            std::fs::rename(&partial, &self.path)
        };
        if let Err(error) = write() {
            eprintln!("maka-desktop-shell: {}: {error}", self.path.display());
        }
    }
}

fn normal_size(saved: &Saved) -> (i32, i32) {
    let dimension = |value: f32, min: f32, default: i32| {
        if value.is_finite() && value > 0.0 {
            value.max(min).min(i32::MAX as f32) as i32
        } else {
            default
        }
    };
    (
        dimension(saved.width, MIN_SIZE.0, SIZE.0),
        dimension(saved.height, MIN_SIZE.1, SIZE.1),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_placement_reads_existing_desktop_sizes() {
        let saved: Saved = serde_json::from_str(
            r#"{"display":"unused","x":12,"y":20,"width":900,"height":650,"state":"maximized"}"#,
        )
        .unwrap();
        assert_eq!(normal_size(&saved), (900, 650));
        assert_eq!(saved.state, State::Maximized);
    }
    #[test]
    fn invalid_or_small_sizes_keep_the_window_usable() {
        assert_eq!(
            normal_size(&Saved {
                width: 1.0,
                height: 2.0,
                state: State::Windowed
            }),
            (640, 480)
        );
        assert_eq!(
            normal_size(&Saved {
                width: f32::NAN,
                height: -1.0,
                state: State::Windowed
            }),
            SIZE
        );
    }
}
