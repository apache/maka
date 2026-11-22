//! Device Control String (DCS) escape sequences.
//!
//! Device Control String sequences are framed by [`DCS`] and [`ST`]. Termina currently models the
//! [DECRQSS] request and [DECRPSS] response forms used for terminal state queries, along with
//! the XTVERSION name-and-version response.
//!
//! # Examples
//!
//! ```
//! use termina::escape::dcs::{Dcs, DcsRequest};
//!
//! let request = Dcs::Request(DcsRequest::GraphicRendition);
//! assert_eq!(request.to_string(), "\x1bP$qm\x1b\\");
//! ```
//!
//! [`DCS`]: super::DCS
//! [DECRPSS]: https://vt100.net/docs/vt510-rm/DECRPSS.html
//! [DECRQSS]: https://vt100.net/docs/vt510-rm/DECRQSS.html
//! [`ST`]: super::ST

use std::fmt::{self, Display};

use crate::style::CursorStyle;

#[cfg(doc)]
use crate::escape::csi::Sgr;

/// A Device Control String command.
///
/// Termina uses DCS for terminal state queries that have structured request and response forms.
/// Formatting writes the DCS introducer, the request or response payload, and the string
/// terminator.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Dcs {
    /// The raw terminal name and version from an XTVERSION response (`DCS >|text ST`).
    ///
    /// The parser does not infer a terminal product or capabilities from this string.
    TerminalNameAndVersion(String),

    /// Request a terminal setting with [DECRQSS] using a [`DcsRequest`] selector.
    ///
    /// For example, [`DcsRequest::GraphicRendition`] asks for the current [`Sgr`] state.
    ///
    /// [DECRQSS]: https://vt100.net/docs/vt510-rm/DECRQSS.html
    Request(DcsRequest),

    /// Report a terminal setting with [DECRPSS] using a [`DcsResponse`] payload.
    ///
    /// Terminals use this response to answer a DECRQSS request. A valid response contains the
    /// setting encoded as the terminal would send it in the corresponding control sequence.
    ///
    /// [DECRPSS]: https://vt100.net/docs/vt510-rm/DECRPSS.html
    Response {
        /// Whether the terminal recognized the original request.
        is_request_valid: bool,

        /// The setting value returned by the terminal.
        value: DcsResponse,
    },
}

impl Display for Dcs {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // DCS
        f.write_str(super::DCS)?;
        match self {
            Self::TerminalNameAndVersion(value) => write!(f, ">|{value}")?,
            // DCS $ q D...D ST
            Self::Request(request) => write!(f, "$q{request}")?,
            // DCS Ps $ r D...D ST
            Self::Response {
                is_request_valid,
                value,
            } => write!(f, "{}$r{value}", if *is_request_valid { 1 } else { 0 })?,
        }
        // ST
        f.write_str(super::ST)
    }
}

/// Request selectors for [DECRQSS].
///
/// Each variant names the setting being queried and shows the selector bytes sent after `DCS $ q`.
/// The selector bytes come from [DECRQSS].
///
/// [DECRQSS]: https://vt100.net/docs/vt510-rm/DECRQSS.html
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DcsRequest {
    /// DECRQSS `$}`: request the active status display.
    ActiveStatusDisplay,
    /// DECRQSS `*x`: request the attribute change extent.
    AttributeChangeExtent,
    /// DECRQSS `"q`: request the character attribute.
    CharacterAttribute,
    /// DECRQSS `"p`: request the conformance level.
    ConformanceLevel,
    /// DECRQSS `$|`: request the number of columns per page.
    ColumnsPerPage,
    /// DECRQSS `t`: request the number of lines per page.
    LinesPerPage,
    /// DECRQSS `*|`: request the number of lines per screen.
    NumberOfLinesPerScreen,
    /// DECRQSS `$~`: request the status line type.
    StatusLineType,
    /// DECRQSS `s`: request the left and right margins.
    LeftAndRightMargins,
    /// DECRQSS `r`: request the top and bottom margins.
    TopAndBottomMargins,
    /// DECRQSS `m`: request [`Sgr`] state.
    GraphicRendition,
    /// DECRQSS `p`: request the setup language.
    SetUpLanguage,
    /// DECRQSS `$s`: request the printer type.
    PrinterType,
    /// DECRQSS `"t`: request the refresh rate.
    RefreshRate,
    /// DECRQSS `(p`: request the digital printed data type.
    DigitalPrintedDataType,
    /// DECRQSS `*p`: request the ProPrinter character set.
    ProPrinterCharacterSet,
    /// DECRQSS `*r`: request the communication speed.
    CommunicationSpeed,
    /// DECRQSS `*u`: request the communication port.
    CommunicationPort,
    /// DECRQSS ` p`: request the scroll speed.
    ScrollSpeed,
    /// DECRQSS ` q`: request the cursor style.
    CursorStyle,
    /// DECRQSS ` r`: request the key-click volume.
    KeyClickVolume,
    /// DECRQSS ` t`: request the warning-bell volume.
    WarningBellVolume,
    /// DECRQSS ` u`: request the margin-bell volume.
    MarginBellVolume,
    /// DECRQSS ` v`: request the lock-key style.
    LockKeyStyle,
    /// DECRQSS `*s`: request the flow-control type.
    FlowControlType,
    /// DECRQSS `$q`: request the disconnect delay time.
    DisconnectDelayTime,
    /// DECRQSS `"u`: request the transmit-rate limit.
    TransmitRateLimit,
    /// DECRQSS `+w`: request the port parameter.
    PortParameter,
}

impl Display for DcsRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ActiveStatusDisplay => f.write_str("$}"),
            Self::AttributeChangeExtent => write!(f, "*x"),
            Self::CharacterAttribute => write!(f, "\"q"),
            Self::ConformanceLevel => write!(f, "\"p"),
            Self::ColumnsPerPage => write!(f, "$|"),
            Self::LinesPerPage => write!(f, "t"),
            Self::NumberOfLinesPerScreen => write!(f, "*|"),
            Self::StatusLineType => write!(f, "$~"),
            Self::LeftAndRightMargins => write!(f, "s"),
            Self::TopAndBottomMargins => write!(f, "r"),
            Self::GraphicRendition => write!(f, "m"),
            Self::SetUpLanguage => write!(f, "p"),
            Self::PrinterType => write!(f, "$s"),
            Self::RefreshRate => write!(f, "\"t"),
            Self::DigitalPrintedDataType => write!(f, "(p"),
            Self::ProPrinterCharacterSet => write!(f, "*p"),
            Self::CommunicationSpeed => write!(f, "*r"),
            Self::CommunicationPort => write!(f, "*u"),
            // NOTE: space char is intentional - written as SP in
            // <https://vt100.net/docs/vt510-rm/DECRPSS.html>
            Self::ScrollSpeed => write!(f, " p"),
            Self::CursorStyle => write!(f, " q"),
            Self::KeyClickVolume => write!(f, " r"),
            Self::WarningBellVolume => write!(f, " t"),
            Self::MarginBellVolume => write!(f, " u"),
            Self::LockKeyStyle => write!(f, " v"),
            Self::FlowControlType => write!(f, "*s"),
            Self::DisconnectDelayTime => write!(f, "$q"),
            Self::TransmitRateLimit => write!(f, "\"u"),
            Self::PortParameter => write!(f, "+w"),
        }
    }
}

/// Response payloads from [DECRPSS] parsed by Termina.
///
/// [DECRPSS] is the response form terminals use for [DECRQSS] status-string queries.
///
/// [DECRPSS]: https://vt100.net/docs/vt510-rm/DECRPSS.html
/// [DECRQSS]: https://vt100.net/docs/vt510-rm/DECRQSS.html
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DcsResponse {
    /// A DECRPSS response containing [`Sgr`] attributes.
    ///
    /// [`DcsRequest::GraphicRendition`] produces this response. The payload carries the same
    /// values that would appear in a [`Sgr`] sequence.
    ///
    /// [`Sgr`]: crate::escape::csi::Sgr
    GraphicRendition(Vec<super::csi::Sgr>),

    /// A DECRPSS response containing the terminal's current cursor style.
    ///
    /// [`DcsRequest::CursorStyle`] produces this response. The payload corresponds to the
    /// [`CursorStyle`] setting.
    CursorStyle(CursorStyle),
    // There are others but adding them would mean adding a lot of parsing code...
}

impl Display for DcsResponse {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::GraphicRendition(sgrs) => {
                let mut first = true;
                for sgr in sgrs {
                    if !first {
                        write!(f, ";")?;
                    }
                    first = false;
                    write!(f, "{sgr}")?;
                }
                Ok(())
            }
            Self::CursorStyle(style) => write!(f, "{style} q"),
        }
    }
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn encoding() {
        assert_eq!(
            Dcs::Request(DcsRequest::GraphicRendition).to_string(),
            "\x1bP$qm\x1b\\"
        );
        assert_eq!(
            Dcs::Request(DcsRequest::CursorStyle).to_string(),
            "\x1bP$q q\x1b\\"
        );
    }
}
