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

use ratatui::style::Color;
#[derive(Default)]
pub struct Content {
    pub text: String,
    pub changes: Vec<super::layout::diff::Row>,
    pub file: Option<crate::files::Link>,
    /// Source bytes of the header's verb, emphasized like a label.
    pub emphasis: Option<std::ops::Range<usize>>,
}
impl From<String> for Content {
    fn from(text: String) -> Self {
        Self {
            text,
            changes: vec![],
            file: None,
            emphasis: None,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Activity {
    Read,
    Search,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ToolState {
    Pending,
    Waiting,
    Returned,
    Attention,
    Failed,
    TimedOut,
    Cancelled,
    Completed,
    Missing,
}
impl ToolState {
    pub fn color(self, colors: crate::theme::Palette) -> Color {
        match self {
            Self::Waiting | Self::TimedOut | Self::Cancelled | Self::Missing => colors.warning,
            Self::Attention | Self::Failed => colors.error,
            Self::Completed => colors.success,
            Self::Returned | Self::Pending => colors.subtle,
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Self::Pending => "tool-pending",
            Self::Waiting => "tool-waiting",
            Self::Returned => "tool-returned",
            Self::Attention => "tool-attention",
            Self::Failed => "tool-failed",
            Self::TimedOut => "tool-timed-out",
            Self::Cancelled => "tool-cancelled",
            Self::Completed => "tool-completed",
            Self::Missing => "tool-missing",
        }
    }
    pub fn problem(self) -> bool {
        matches!(
            self,
            Self::Attention | Self::Failed | Self::TimedOut | Self::Cancelled
        )
    }
}
