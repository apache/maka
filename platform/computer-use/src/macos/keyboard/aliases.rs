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

//! Mac key aliases. Parsing performs no input or layout lookup.

use maka_agent_facts::tools::ToolError;
use objc2::{
    msg_send,
    rc::Retained,
    runtime::{AnyClass, AnyObject},
};
use objc2_foundation::NSString;
use unicode_segmentation::UnicodeSegmentation;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct ParsedKeyPress {
    pub(super) key_code: u16,
    /// Carbon modifier bits accepted by the key-press initializer.
    pub(super) modifiers: u32,
}

#[derive(Clone, Copy)]
enum Alias {
    Modifier(u32),
    Key(ParsedKeyPress),
    Unsupported,
}

#[derive(Debug)]
enum ParseError<'a> {
    UnknownAlias { _token: &'a str },
    UnsupportedKey { _group: &'a str },
    OrdinaryBeforeFinal { _group: &'a str },
    MissingOrdinary { _group: &'a str },
}

impl ParseError<'_> {
    fn into_tool_error(self) -> ToolError {
        let (domain, code) = match self {
            Self::UnknownAlias { .. } => ("ComputerUse.XKeysym.Error", 0),
            Self::UnsupportedKey { .. } => ("ComputerUse.XKeysymString.Error", 0),
            Self::OrdinaryBeforeFinal { .. } => ("ComputerUse.XKeysymString.Error", 1),
            Self::MissingOrdinary { .. } => ("ComputerUse.XKeysymString.Error", 2),
        };
        default_swift_error(domain, code)
    }
}

// Swift.Error domains use the qualified type name and enum tag. Foundation
// supplies the localized presentation.
pub(in crate::macos) fn default_swift_error(domain: &str, code: isize) -> ToolError {
    let Some(error_class) = AnyClass::get(c"NSError") else {
        return ToolError::Failed(format!("NSError class unavailable for {domain} ({code})"));
    };
    let domain = NSString::from_str(domain);
    // SAFETY: Foundation's NSError factory accepts an NSString domain,
    // NSInteger code, and a nullable NSDictionary. No userInfo is supplied,
    // matching these native error types' default Swift.Error conformance.
    // msg_send! retains the returned object, including an autoreleased result.
    let error: Retained<AnyObject> = unsafe {
        msg_send![error_class, errorWithDomain: &*domain, code: code,
                  userInfo: std::ptr::null::<AnyObject>()]
    };
    // SAFETY: The factory returned an NSError; localizedDescription returns a
    // nonnull NSString retained by msg_send! while its bytes are copied.
    let description: Retained<NSString> = unsafe { msg_send![&*error, localizedDescription] };
    ToolError::Failed(description.to_string())
}

pub(super) fn parse_keys(input: &str) -> Result<Vec<ParsedKeyPress>, ToolError> {
    parse(input).map_err(ParseError::into_tool_error)
}

fn parse(input: &str) -> Result<Vec<ParsedKeyPress>, ParseError<'_>> {
    // Resolve every spelling before validating any group.
    // Thus a later unknown alias precedes an earlier invalid group structure.
    let groups = split(input, " ")
        .into_iter()
        .map(|group| {
            let aliases = split(group, "+")
                .into_iter()
                .map(|token| {
                    if token.is_ascii() {
                        lookup(token).ok_or(ParseError::UnknownAlias { _token: token })
                    } else {
                        let normalized = NSString::from_str(token)
                            .precomposedStringWithCanonicalMapping()
                            .to_string();
                        lookup(&normalized).ok_or(ParseError::UnknownAlias { _token: token })
                    }
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok::<_, ParseError<'_>>((group, aliases))
        })
        .collect::<Result<Vec<_>, _>>()?;

    groups
        .into_iter()
        .map(|(group, aliases)| {
            let mut modifiers = 0;
            let mut last_key = None;
            let mut previous_was_modifier = true;
            for alias in aliases {
                // Test unsupported keys before previous-key
                // ordering, and combine repeated modifiers with bitwise OR.
                let is_modifier = match alias {
                    Alias::Unsupported => return Err(ParseError::UnsupportedKey { _group: group }),
                    Alias::Modifier(flags) => {
                        modifiers |= flags;
                        true
                    }
                    Alias::Key(key) => {
                        modifiers |= key.modifiers;
                        last_key = Some(key);
                        false
                    }
                };
                if !previous_was_modifier {
                    return Err(ParseError::OrdinaryBeforeFinal { _group: group });
                }
                previous_was_modifier = is_modifier;
            }
            let Some(key) = last_key.filter(|_| !previous_was_modifier) else {
                return Err(ParseError::MissingOrdinary { _group: group });
            };
            Ok(ParsedKeyPress {
                key_code: key.key_code,
                modifiers,
            })
        })
        .collect()
}

fn split<'a>(input: &'a str, separator: &str) -> Vec<&'a str> {
    let mut parts = Vec::new();
    let mut start = 0;
    for (index, grapheme) in input.grapheme_indices(true) {
        if grapheme == separator {
            if start != index {
                parts.push(&input[start..index]);
            }
            start = index + grapheme.len();
        }
    }
    if start != input.len() {
        parts.push(&input[start..]);
    }
    parts
}

fn lookup(token: &str) -> Option<Alias> {
    // Case-sensitive spellings map to virtual key codes and Carbon modifier bits.
    Some(match token {
        "BackSpace" => Alias::Key(ParsedKeyPress {
            key_code: 51,
            modifiers: 0x0,
        }),
        "Tab" => Alias::Key(ParsedKeyPress {
            key_code: 48,
            modifiers: 0x0,
        }),
        "Linefeed" => Alias::Key(ParsedKeyPress {
            key_code: 36,
            modifiers: 0x0,
        }),
        "Clear" => Alias::Key(ParsedKeyPress {
            key_code: 71,
            modifiers: 0x0,
        }),
        "Return" => Alias::Key(ParsedKeyPress {
            key_code: 36,
            modifiers: 0x0,
        }),
        "Escape" => Alias::Key(ParsedKeyPress {
            key_code: 53,
            modifiers: 0x0,
        }),
        "Delete" => Alias::Key(ParsedKeyPress {
            key_code: 117,
            modifiers: 0x0,
        }),
        "Pause" => Alias::Unsupported,
        "Scroll_Lock" => Alias::Unsupported,
        "Sys_Req" => Alias::Unsupported,
        "Back" => Alias::Unsupported,
        "Home" => Alias::Key(ParsedKeyPress {
            key_code: 115,
            modifiers: 0x0,
        }),
        "Left" => Alias::Key(ParsedKeyPress {
            key_code: 123,
            modifiers: 0x0,
        }),
        "Up" => Alias::Key(ParsedKeyPress {
            key_code: 126,
            modifiers: 0x0,
        }),
        "Right" => Alias::Key(ParsedKeyPress {
            key_code: 124,
            modifiers: 0x0,
        }),
        "Down" => Alias::Key(ParsedKeyPress {
            key_code: 125,
            modifiers: 0x0,
        }),
        "Prior" => Alias::Key(ParsedKeyPress {
            key_code: 116,
            modifiers: 0x0,
        }),
        "Page_Up" => Alias::Key(ParsedKeyPress {
            key_code: 116,
            modifiers: 0x0,
        }),
        "Next" => Alias::Key(ParsedKeyPress {
            key_code: 121,
            modifiers: 0x0,
        }),
        "Page_Down" => Alias::Key(ParsedKeyPress {
            key_code: 121,
            modifiers: 0x0,
        }),
        "End" => Alias::Key(ParsedKeyPress {
            key_code: 119,
            modifiers: 0x0,
        }),
        "Begin" => Alias::Key(ParsedKeyPress {
            key_code: 115,
            modifiers: 0x0,
        }),
        "Menu" => Alias::Key(ParsedKeyPress {
            key_code: 110,
            modifiers: 0x0,
        }),
        "Help" => Alias::Key(ParsedKeyPress {
            key_code: 114,
            modifiers: 0x0,
        }),
        "Select" => Alias::Unsupported,
        "Print" => Alias::Unsupported,
        "Execute" => Alias::Unsupported,
        "Insert" => Alias::Unsupported,
        "Undo" => Alias::Unsupported,
        "Redo" => Alias::Unsupported,
        "Find" => Alias::Unsupported,
        "Cancel" => Alias::Unsupported,
        "Break" => Alias::Unsupported,
        "Mode_switch" => Alias::Unsupported,
        "script_switch" => Alias::Unsupported,
        "Num_Lock" => Alias::Unsupported,
        "KP_Delete" => Alias::Key(ParsedKeyPress {
            key_code: 71,
            modifiers: 0x0,
        }),
        "KP_Enter" => Alias::Key(ParsedKeyPress {
            key_code: 76,
            modifiers: 0x0,
        }),
        "KP_Equal" => Alias::Key(ParsedKeyPress {
            key_code: 81,
            modifiers: 0x0,
        }),
        "KP_Multiply" => Alias::Key(ParsedKeyPress {
            key_code: 67,
            modifiers: 0x0,
        }),
        "KP_Add" => Alias::Key(ParsedKeyPress {
            key_code: 69,
            modifiers: 0x0,
        }),
        "KP_Subtract" => Alias::Key(ParsedKeyPress {
            key_code: 78,
            modifiers: 0x0,
        }),
        "KP_Decimal" => Alias::Key(ParsedKeyPress {
            key_code: 65,
            modifiers: 0x0,
        }),
        "KP_Divide" => Alias::Key(ParsedKeyPress {
            key_code: 75,
            modifiers: 0x0,
        }),
        "KP_0" => Alias::Key(ParsedKeyPress {
            key_code: 82,
            modifiers: 0x0,
        }),
        "KP_1" => Alias::Key(ParsedKeyPress {
            key_code: 83,
            modifiers: 0x0,
        }),
        "KP_2" => Alias::Key(ParsedKeyPress {
            key_code: 84,
            modifiers: 0x0,
        }),
        "KP_3" => Alias::Key(ParsedKeyPress {
            key_code: 85,
            modifiers: 0x0,
        }),
        "KP_4" => Alias::Key(ParsedKeyPress {
            key_code: 86,
            modifiers: 0x0,
        }),
        "KP_5" => Alias::Key(ParsedKeyPress {
            key_code: 87,
            modifiers: 0x0,
        }),
        "KP_6" => Alias::Key(ParsedKeyPress {
            key_code: 88,
            modifiers: 0x0,
        }),
        "KP_7" => Alias::Key(ParsedKeyPress {
            key_code: 89,
            modifiers: 0x0,
        }),
        "KP_8" => Alias::Key(ParsedKeyPress {
            key_code: 91,
            modifiers: 0x0,
        }),
        "KP_9" => Alias::Key(ParsedKeyPress {
            key_code: 92,
            modifiers: 0x0,
        }),
        "KP_Space" => Alias::Unsupported,
        "KP_Tab" => Alias::Unsupported,
        "KP_F1" => Alias::Unsupported,
        "KP_F2" => Alias::Unsupported,
        "KP_F3" => Alias::Unsupported,
        "KP_F4" => Alias::Unsupported,
        "KP_Home" => Alias::Unsupported,
        "KP_Left" => Alias::Unsupported,
        "KP_Up" => Alias::Unsupported,
        "KP_Right" => Alias::Unsupported,
        "KP_Down" => Alias::Unsupported,
        "KP_Prior" => Alias::Unsupported,
        "KP_Page_Up" => Alias::Unsupported,
        "KP_Next" => Alias::Unsupported,
        "KP_Page_Down" => Alias::Unsupported,
        "KP_End" => Alias::Unsupported,
        "KP_Begin" => Alias::Unsupported,
        "KP_Insert" => Alias::Unsupported,
        "KP_Separator" => Alias::Unsupported,
        "F1" => Alias::Key(ParsedKeyPress {
            key_code: 122,
            modifiers: 0x0,
        }),
        "F2" => Alias::Key(ParsedKeyPress {
            key_code: 120,
            modifiers: 0x0,
        }),
        "F3" => Alias::Key(ParsedKeyPress {
            key_code: 99,
            modifiers: 0x0,
        }),
        "F4" => Alias::Key(ParsedKeyPress {
            key_code: 118,
            modifiers: 0x0,
        }),
        "F5" => Alias::Key(ParsedKeyPress {
            key_code: 96,
            modifiers: 0x0,
        }),
        "F6" => Alias::Key(ParsedKeyPress {
            key_code: 97,
            modifiers: 0x0,
        }),
        "F7" => Alias::Key(ParsedKeyPress {
            key_code: 98,
            modifiers: 0x0,
        }),
        "F8" => Alias::Key(ParsedKeyPress {
            key_code: 100,
            modifiers: 0x0,
        }),
        "F9" => Alias::Key(ParsedKeyPress {
            key_code: 101,
            modifiers: 0x0,
        }),
        "F10" => Alias::Key(ParsedKeyPress {
            key_code: 109,
            modifiers: 0x0,
        }),
        "F11" => Alias::Key(ParsedKeyPress {
            key_code: 103,
            modifiers: 0x0,
        }),
        "F12" => Alias::Key(ParsedKeyPress {
            key_code: 111,
            modifiers: 0x0,
        }),
        "F13" => Alias::Key(ParsedKeyPress {
            key_code: 105,
            modifiers: 0x0,
        }),
        "F14" => Alias::Key(ParsedKeyPress {
            key_code: 107,
            modifiers: 0x0,
        }),
        "F15" => Alias::Key(ParsedKeyPress {
            key_code: 113,
            modifiers: 0x0,
        }),
        "F16" => Alias::Key(ParsedKeyPress {
            key_code: 106,
            modifiers: 0x0,
        }),
        "F17" => Alias::Key(ParsedKeyPress {
            key_code: 64,
            modifiers: 0x0,
        }),
        "F18" => Alias::Key(ParsedKeyPress {
            key_code: 79,
            modifiers: 0x0,
        }),
        "F19" => Alias::Key(ParsedKeyPress {
            key_code: 80,
            modifiers: 0x0,
        }),
        "F20" => Alias::Key(ParsedKeyPress {
            key_code: 90,
            modifiers: 0x0,
        }),
        "Shift_L" => Alias::Modifier(0x200),
        "Shift_R" => Alias::Modifier(0x200),
        "Control_L" => Alias::Modifier(0x1000),
        "Control_R" => Alias::Modifier(0x1000),
        "Meta_L" => Alias::Modifier(0x100),
        "Meta_R" => Alias::Modifier(0x100),
        "Alt_L" => Alias::Modifier(0x800),
        "Alt_R" => Alias::Modifier(0x800),
        "Super_L" => Alias::Modifier(0x100),
        "Super_R" => Alias::Modifier(0x100),
        "Caps_Lock" => Alias::Key(ParsedKeyPress {
            key_code: 57,
            modifiers: 0x0,
        }),
        "Shift_Lock" => Alias::Key(ParsedKeyPress {
            key_code: 57,
            modifiers: 0x0,
        }),
        "Hyper_L" => Alias::Unsupported,
        "Hyper_R" => Alias::Unsupported,
        "alt" => Alias::Modifier(0x800),
        "ctrl" => Alias::Modifier(0x1000),
        "shift" => Alias::Modifier(0x200),
        "super" => Alias::Modifier(0x100),
        "meta" => Alias::Modifier(0x100),
        "command" => Alias::Modifier(0x100),
        "Command" => Alias::Modifier(0x100),
        "cmd" => Alias::Modifier(0x100),
        "space" => Alias::Key(ParsedKeyPress {
            key_code: 49,
            modifiers: 0x0,
        }),
        "exclam" => Alias::Key(ParsedKeyPress {
            key_code: 18,
            modifiers: 0x200,
        }),
        "quotedbl" => Alias::Key(ParsedKeyPress {
            key_code: 39,
            modifiers: 0x200,
        }),
        "numbersign" => Alias::Key(ParsedKeyPress {
            key_code: 20,
            modifiers: 0x200,
        }),
        "dollar" => Alias::Key(ParsedKeyPress {
            key_code: 21,
            modifiers: 0x200,
        }),
        "percent" => Alias::Key(ParsedKeyPress {
            key_code: 23,
            modifiers: 0x200,
        }),
        "ampersand" => Alias::Key(ParsedKeyPress {
            key_code: 26,
            modifiers: 0x200,
        }),
        "apostrophe" => Alias::Key(ParsedKeyPress {
            key_code: 39,
            modifiers: 0x0,
        }),
        "parenleft" => Alias::Key(ParsedKeyPress {
            key_code: 25,
            modifiers: 0x200,
        }),
        "parenright" => Alias::Key(ParsedKeyPress {
            key_code: 29,
            modifiers: 0x200,
        }),
        "asterisk" => Alias::Key(ParsedKeyPress {
            key_code: 28,
            modifiers: 0x200,
        }),
        "plus" => Alias::Key(ParsedKeyPress {
            key_code: 24,
            modifiers: 0x200,
        }),
        "comma" => Alias::Key(ParsedKeyPress {
            key_code: 43,
            modifiers: 0x0,
        }),
        "minus" => Alias::Key(ParsedKeyPress {
            key_code: 27,
            modifiers: 0x0,
        }),
        "period" => Alias::Key(ParsedKeyPress {
            key_code: 47,
            modifiers: 0x0,
        }),
        "slash" => Alias::Key(ParsedKeyPress {
            key_code: 44,
            modifiers: 0x0,
        }),
        "0" => Alias::Key(ParsedKeyPress {
            key_code: 29,
            modifiers: 0x0,
        }),
        "1" => Alias::Key(ParsedKeyPress {
            key_code: 18,
            modifiers: 0x0,
        }),
        "2" => Alias::Key(ParsedKeyPress {
            key_code: 19,
            modifiers: 0x0,
        }),
        "3" => Alias::Key(ParsedKeyPress {
            key_code: 20,
            modifiers: 0x0,
        }),
        "4" => Alias::Key(ParsedKeyPress {
            key_code: 21,
            modifiers: 0x0,
        }),
        "5" => Alias::Key(ParsedKeyPress {
            key_code: 23,
            modifiers: 0x0,
        }),
        "6" => Alias::Key(ParsedKeyPress {
            key_code: 22,
            modifiers: 0x0,
        }),
        "7" => Alias::Key(ParsedKeyPress {
            key_code: 26,
            modifiers: 0x0,
        }),
        "8" => Alias::Key(ParsedKeyPress {
            key_code: 28,
            modifiers: 0x0,
        }),
        "9" => Alias::Key(ParsedKeyPress {
            key_code: 25,
            modifiers: 0x0,
        }),
        "colon" => Alias::Key(ParsedKeyPress {
            key_code: 41,
            modifiers: 0x200,
        }),
        "semicolon" => Alias::Key(ParsedKeyPress {
            key_code: 41,
            modifiers: 0x0,
        }),
        "less" => Alias::Key(ParsedKeyPress {
            key_code: 43,
            modifiers: 0x200,
        }),
        "equal" => Alias::Key(ParsedKeyPress {
            key_code: 24,
            modifiers: 0x200,
        }),
        "greater" => Alias::Key(ParsedKeyPress {
            key_code: 47,
            modifiers: 0x200,
        }),
        "question" => Alias::Key(ParsedKeyPress {
            key_code: 44,
            modifiers: 0x200,
        }),
        "at" => Alias::Key(ParsedKeyPress {
            key_code: 19,
            modifiers: 0x200,
        }),
        "A" => Alias::Key(ParsedKeyPress {
            key_code: 0,
            modifiers: 0x200,
        }),
        "B" => Alias::Key(ParsedKeyPress {
            key_code: 11,
            modifiers: 0x200,
        }),
        "C" => Alias::Key(ParsedKeyPress {
            key_code: 8,
            modifiers: 0x200,
        }),
        "D" => Alias::Key(ParsedKeyPress {
            key_code: 2,
            modifiers: 0x200,
        }),
        "E" => Alias::Key(ParsedKeyPress {
            key_code: 14,
            modifiers: 0x200,
        }),
        "F" => Alias::Key(ParsedKeyPress {
            key_code: 3,
            modifiers: 0x200,
        }),
        "G" => Alias::Key(ParsedKeyPress {
            key_code: 5,
            modifiers: 0x200,
        }),
        "H" => Alias::Key(ParsedKeyPress {
            key_code: 4,
            modifiers: 0x200,
        }),
        "I" => Alias::Key(ParsedKeyPress {
            key_code: 34,
            modifiers: 0x200,
        }),
        "J" => Alias::Key(ParsedKeyPress {
            key_code: 38,
            modifiers: 0x200,
        }),
        "K" => Alias::Key(ParsedKeyPress {
            key_code: 40,
            modifiers: 0x200,
        }),
        "L" => Alias::Key(ParsedKeyPress {
            key_code: 37,
            modifiers: 0x200,
        }),
        "M" => Alias::Key(ParsedKeyPress {
            key_code: 46,
            modifiers: 0x200,
        }),
        "N" => Alias::Key(ParsedKeyPress {
            key_code: 45,
            modifiers: 0x200,
        }),
        "O" => Alias::Key(ParsedKeyPress {
            key_code: 31,
            modifiers: 0x200,
        }),
        "P" => Alias::Key(ParsedKeyPress {
            key_code: 35,
            modifiers: 0x200,
        }),
        "Q" => Alias::Key(ParsedKeyPress {
            key_code: 12,
            modifiers: 0x200,
        }),
        "R" => Alias::Key(ParsedKeyPress {
            key_code: 15,
            modifiers: 0x200,
        }),
        "S" => Alias::Key(ParsedKeyPress {
            key_code: 1,
            modifiers: 0x200,
        }),
        "T" => Alias::Key(ParsedKeyPress {
            key_code: 17,
            modifiers: 0x200,
        }),
        "U" => Alias::Key(ParsedKeyPress {
            key_code: 32,
            modifiers: 0x200,
        }),
        "V" => Alias::Key(ParsedKeyPress {
            key_code: 9,
            modifiers: 0x200,
        }),
        "W" => Alias::Key(ParsedKeyPress {
            key_code: 13,
            modifiers: 0x200,
        }),
        "X" => Alias::Key(ParsedKeyPress {
            key_code: 7,
            modifiers: 0x200,
        }),
        "Y" => Alias::Key(ParsedKeyPress {
            key_code: 16,
            modifiers: 0x200,
        }),
        "Z" => Alias::Key(ParsedKeyPress {
            key_code: 6,
            modifiers: 0x200,
        }),
        "bracketleft" => Alias::Key(ParsedKeyPress {
            key_code: 33,
            modifiers: 0x0,
        }),
        "backslash" => Alias::Key(ParsedKeyPress {
            key_code: 42,
            modifiers: 0x0,
        }),
        "bracketright" => Alias::Key(ParsedKeyPress {
            key_code: 30,
            modifiers: 0x0,
        }),
        "asciicircum" => Alias::Key(ParsedKeyPress {
            key_code: 22,
            modifiers: 0x200,
        }),
        "underscore" => Alias::Key(ParsedKeyPress {
            key_code: 27,
            modifiers: 0x200,
        }),
        "grave" => Alias::Key(ParsedKeyPress {
            key_code: 50,
            modifiers: 0x0,
        }),
        "a" => Alias::Key(ParsedKeyPress {
            key_code: 0,
            modifiers: 0x0,
        }),
        "b" => Alias::Key(ParsedKeyPress {
            key_code: 11,
            modifiers: 0x0,
        }),
        "c" => Alias::Key(ParsedKeyPress {
            key_code: 8,
            modifiers: 0x0,
        }),
        "d" => Alias::Key(ParsedKeyPress {
            key_code: 2,
            modifiers: 0x0,
        }),
        "e" => Alias::Key(ParsedKeyPress {
            key_code: 14,
            modifiers: 0x0,
        }),
        "f" => Alias::Key(ParsedKeyPress {
            key_code: 3,
            modifiers: 0x0,
        }),
        "g" => Alias::Key(ParsedKeyPress {
            key_code: 5,
            modifiers: 0x0,
        }),
        "h" => Alias::Key(ParsedKeyPress {
            key_code: 4,
            modifiers: 0x0,
        }),
        "i" => Alias::Key(ParsedKeyPress {
            key_code: 34,
            modifiers: 0x0,
        }),
        "j" => Alias::Key(ParsedKeyPress {
            key_code: 38,
            modifiers: 0x0,
        }),
        "k" => Alias::Key(ParsedKeyPress {
            key_code: 40,
            modifiers: 0x0,
        }),
        "l" => Alias::Key(ParsedKeyPress {
            key_code: 37,
            modifiers: 0x0,
        }),
        "m" => Alias::Key(ParsedKeyPress {
            key_code: 46,
            modifiers: 0x0,
        }),
        "n" => Alias::Key(ParsedKeyPress {
            key_code: 45,
            modifiers: 0x0,
        }),
        "o" => Alias::Key(ParsedKeyPress {
            key_code: 31,
            modifiers: 0x0,
        }),
        "p" => Alias::Key(ParsedKeyPress {
            key_code: 35,
            modifiers: 0x0,
        }),
        "q" => Alias::Key(ParsedKeyPress {
            key_code: 12,
            modifiers: 0x0,
        }),
        "r" => Alias::Key(ParsedKeyPress {
            key_code: 15,
            modifiers: 0x0,
        }),
        "s" => Alias::Key(ParsedKeyPress {
            key_code: 1,
            modifiers: 0x0,
        }),
        "t" => Alias::Key(ParsedKeyPress {
            key_code: 17,
            modifiers: 0x0,
        }),
        "u" => Alias::Key(ParsedKeyPress {
            key_code: 32,
            modifiers: 0x0,
        }),
        "v" => Alias::Key(ParsedKeyPress {
            key_code: 9,
            modifiers: 0x0,
        }),
        "w" => Alias::Key(ParsedKeyPress {
            key_code: 13,
            modifiers: 0x0,
        }),
        "x" => Alias::Key(ParsedKeyPress {
            key_code: 7,
            modifiers: 0x0,
        }),
        "y" => Alias::Key(ParsedKeyPress {
            key_code: 16,
            modifiers: 0x0,
        }),
        "z" => Alias::Key(ParsedKeyPress {
            key_code: 6,
            modifiers: 0x0,
        }),
        "braceleft" => Alias::Key(ParsedKeyPress {
            key_code: 33,
            modifiers: 0x200,
        }),
        "bar" => Alias::Key(ParsedKeyPress {
            key_code: 42,
            modifiers: 0x200,
        }),
        "braceright" => Alias::Key(ParsedKeyPress {
            key_code: 30,
            modifiers: 0x200,
        }),
        "asciitilde" => Alias::Key(ParsedKeyPress {
            key_code: 50,
            modifiers: 0x200,
        }),
        _ => return None,
    })
}
