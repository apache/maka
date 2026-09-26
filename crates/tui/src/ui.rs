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

//! Component kernel. A presenter describes a keyed tree of semantic nodes each
//! frame; the kernel owns layout, hit testing, hover, keyboard focus, scroll
//! and popovers, so pages neither draw cells nor route raw input themselves.
mod boundary;
pub mod collection;
mod layout;
mod node;
mod sheet;
mod surface;
pub mod transcript;

pub use boundary::{Activity, Emphasis};
pub use collection::Collections;
/// A node's width at its natural size, before any sharing.
pub(crate) use layout::width as natural_width;
pub use node::{Align, Choice, Node, On, Role, Size, Tone};
pub use sheet::{Layer, Sheet, content_width};
pub use surface::reader::ReaderEffect;
pub use surface::{Context, Hover, Outcome, Splits, Surface};
