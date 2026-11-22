use std::io::{self, Write as _};

use termina::{
    escape::{
        csi::{self, Csi},
        osc::{DynamicColorNumber, Osc},
    },
    style::RgbColor,
    PlatformTerminal, Terminal as _,
};

fn main() -> io::Result<()> {
    let mut terminal = PlatformTerminal::new()?;
    terminal.enter_raw_mode()?;

    write!(
        terminal,
        "{}{}{}{}Check the green background/blue foreground of your terminal. Press any key to exit.",
        Csi::Mode(csi::Mode::SetDecPrivateMode(csi::DecPrivateMode::Code(
            csi::DecPrivateModeCode::ClearAndEnableAlternateScreen
        ))),
        Osc::ChangeDynamicColors(DynamicColorNumber::TextForegroundColor, vec![RgbColor::new(128, 128, 255).into()]),
        Osc::ChangeDynamicColors(DynamicColorNumber::TextBackgroundColor, vec![RgbColor::new(0, 64, 0).into()]),
        Csi::Cursor(csi::Cursor::default_position()),
    )?;
    terminal.flush()?;
    let _ = terminal.read(|event| matches!(event, termina::Event::Key(_)));

    write!(
        terminal,
        "{}{}{}",
        Csi::Mode(csi::Mode::ResetDecPrivateMode(csi::DecPrivateMode::Code(
            csi::DecPrivateModeCode::ClearAndEnableAlternateScreen,
        ))),
        Osc::ResetDynamicColor(DynamicColorNumber::TextForegroundColor),
        Osc::ResetDynamicColor(DynamicColorNumber::TextBackgroundColor),
    )?;

    Ok(())
}
