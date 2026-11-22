# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!-- ## [Unreleased] -->

## [v0.4.0] - 2026-08-31

### Added

* Expose the `PlatformWaker` type (`UnixWaker` on Unix, `WindowsWaker` on Windows) returned by `EventReader::waker` ([b635826b27](https://github.com/helix-editor/termina/commit/b635826b27))

### Changed

* `EventReader::read` now returns `Err` with `io::ErrorKind::Interrupted` when it is woken up by a waker, instead of continuing to block ([ae7d2cb817](https://github.com/helix-editor/termina/commit/ae7d2cb817))
* Avoid re-parsing the read buffer from the start on each read, greatly speeding up large reads such as bracketed pastes ([#24](https://github.com/helix-editor/termina/pull/24))
* Increase the Unix read buffer size from 64 to 1024 bytes ([22ede115e5](https://github.com/helix-editor/termina/commit/22ede115e5))

### Fixed

* Fix parsing of the curly underline SGR (`4:3`) ([05db4b09fe](https://github.com/helix-editor/termina/commit/05db4b09fe))
* Fix a spurious leading SGR reset when writing `SgrAttributes` with a `parameter_chunk_size` smaller than a single parameter group ([c5a7a6a156](https://github.com/helix-editor/termina/commit/c5a7a6a156))
* Fix underflowing subtraction on SGR and rxvt mouse coordinates at coordinate zero ([38047a2491](https://github.com/helix-editor/termina/commit/38047a2491))
* Fix `RgbColor`'s `FromStr` implementation panicking on non-ASCII hexadecimal input ([d98151988c](https://github.com/helix-editor/termina/commit/d98151988c))
* Return an `UnexpectedEof` error instead of busy looping when the Unix event source reaches end-of-file ([309350ba54](https://github.com/helix-editor/termina/commit/309350ba54))
* Fix the input-ready signal being treated as a timeout on Windows ([005da445dd](https://github.com/helix-editor/termina/commit/005da445dd))
* Drain the console input buffer during teardown on Windows ([bddc60917a](https://github.com/helix-editor/termina/commit/bddc60917a))
* Roll back the console state when setting up the terminal fails partway on Windows ([4efcdc689e](https://github.com/helix-editor/termina/commit/4efcdc689e))
* Fix a handle leak in `windows::legacy::screen_buffer` ([3adf9e7d04](https://github.com/helix-editor/termina/commit/3adf9e7d04))
* Fix an undersized UTF-16 buffer used when translating legacy Windows key events ([09558746af](https://github.com/helix-editor/termina/commit/09558746af))
* Fix underflowing subtraction on mouse and cursor row calculations on Windows ([0ec68c2f0c](https://github.com/helix-editor/termina/commit/0ec68c2f0c))

## [v0.3.3] - 2026-05-30

### Added

* Improved public rustdocs ([#23](https://github.com/helix-editor/termina/pull/23))

### Fixed

* Fix Kitty Keyboard `Modifiers` bitflags representation ([c04c2c7672](https://github.com/helix-editor/termina/commit/c04c2c7672))

## [v0.3.2] - 2026-05-07

### Fixed

* Fixed parsing of OSC sequences terminated by BEL (0x07) ([#22](https://github.com/helix-editor/termina/pull/22))

## [v0.3.1] - 2026-04-06

### Added

* Add parsing of DECRPM for mode 2026 (grapheme clustering)

## [v0.3.0] - 2026-03-26

### Added

* Add parsing of OSC dynamic color sequences from the terminal. ([980077903880](https://github.com/helix-editor/termina/commit/980077903880))
* Add CSI sequences for the Kitty Multiple Cursor protocol. ([#14](https://github.com/helix-editor/termina/pull/14))

### Fixed

* Catch OSC sequences in the `Event::is_escape` predicate. ([3c1e399b8dd1](https://github.com/helix-editor/termina/commit/3c1e399b8dd1))

## [v0.2.0] - 2026-03-14

### Added

* Implement legacy console API for Windows ([#16](https://github.com/helix-editor/termina/pull/16))
* Add OSC sequences for changing and resetting terminal colors ([#17](https://github.com/helix-editor/termina/pull/17))

### Fixed

* Fix reading VT data which includes non-ASCII characters from Windows ([#15](https://github.com/helix-editor/termina/pull/15))

## [v0.1.1] - 2025-09-12

### Added

* Expose the `Parser` type ([#12](https://github.com/helix-editor/termina/pull/12))

### Fixed

* Fix overflowing subtraction on large mouse positions without SGRMouse enabled ([#11](https://github.com/helix-editor/termina/pull/11))
* Fix Illumos build by avoiding compiling macOS-specific polling functions ([#13](https://github.com/helix-editor/termina/pull/13))

## [v0.1.0] - 2025-08-31

### Added

* Initial publish
