use std::{
    io::{self, Write as _},
    time::Duration,
};

use termina::{
    escape::{
        csi::{self, Csi},
        dcs::{self, Dcs},
    },
    style::RgbColor,
    Event, PlatformTerminal, Terminal,
};

const TEST_COLOR: RgbColor = RgbColor::new(150, 150, 150);

#[derive(Debug, Default, Clone, Copy)]
struct Features {
    kitty_keyboard: bool,
    sychronized_output: bool,
    true_color: bool,
    extended_underlines: bool,
}

fn main() -> io::Result<()> {
    let mut terminal = PlatformTerminal::new()?;
    terminal.enter_raw_mode()?;

    write!(
        terminal,
        "{}{}{}{}{}{}{}",
        // Kitty keyboard
        Csi::Keyboard(csi::Keyboard::QueryFlags),
        // Synchronized output
        Csi::Mode(csi::Mode::QueryDecPrivateMode(csi::DecPrivateMode::Code(
            csi::DecPrivateModeCode::SynchronizedOutput
        ))),
        // True color and while we're at it, extended underlines:
        // <https://github.com/termstandard/colors?tab=readme-ov-file#querying-the-terminal>
        Csi::Sgr(csi::Sgr::Background(TEST_COLOR.into())),
        Csi::Sgr(csi::Sgr::UnderlineColor(TEST_COLOR.into())),
        Dcs::Request(dcs::DcsRequest::GraphicRendition),
        Csi::Sgr(csi::Sgr::Reset),
        // Finally request the primary device attributes
        Csi::Device(csi::Device::RequestPrimaryDeviceAttributes),
    )?;
    terminal.flush()?;

    let mut features = Features::default();
    loop {
        if !terminal.poll(Event::is_escape, Some(Duration::from_millis(100)))? {
            eprintln!("Did not receive any responses to queries in 100ms\r");
            break;
        }

        match terminal.read(Event::is_escape)? {
            Event::Csi(Csi::Keyboard(csi::Keyboard::ReportFlags(_))) => {
                features.kitty_keyboard = true
            }
            Event::Csi(Csi::Mode(csi::Mode::ReportDecPrivateMode {
                mode: csi::DecPrivateMode::Code(csi::DecPrivateModeCode::SynchronizedOutput),
                setting,
            })) => {
                features.sychronized_output = matches!(
                    setting,
                    csi::DecModeSetting::Set | csi::DecModeSetting::Reset
                );
            }
            Event::Dcs(Dcs::Response {
                value: dcs::DcsResponse::GraphicRendition(sgrs),
                ..
            }) => {
                features.true_color = sgrs.contains(&csi::Sgr::Background(TEST_COLOR.into()));
                features.extended_underlines =
                    sgrs.contains(&csi::Sgr::UnderlineColor(TEST_COLOR.into()));
            }
            Event::Csi(Csi::PrimaryDeviceAttributes(_)) => break,
            other => eprintln!("unexpected event: {other:?}\r"),
        }
    }
    println!("Detected features: {features:?}");

    Ok(())
}
