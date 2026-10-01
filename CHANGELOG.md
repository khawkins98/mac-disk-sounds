# Changelog

All notable changes to Mac Disk Sounds are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

The release workflow uses the section for the version being released as the
GitHub release notes, so add your changes under **Unreleased** as you go.

## [Unreleased]

## [1.1.0] - 2026-10-01

A ground-up overhaul. The app now actually listens to your disk, runs from the
menu bar or system tray, and works on Windows for the first time. The work was
tracked in [#3](https://github.com/khawkins98/mac-disk-sounds/issues/3) and
landed in [#4](https://github.com/khawkins98/mac-disk-sounds/pull/4) to
[#8](https://github.com/khawkins98/mac-disk-sounds/pull/8).

### Added

- Tray and menu bar app: sounds keep playing with no window open. The menu has
  Enabled, Sound Set, Open Settings…, Launch at Login, the current version,
  Check for Updates… and Quit. There is no Dock icon on macOS.
- Settings are saved between launches: enabled, sound set, click volume,
  ambience volume and launch at login.
- Launch at login on macOS, Windows (including the portable build) and Linux
  (an XDG autostart entry, kept up to date when an AppImage is replaced).
- Windows support. Disk activity is read from Windows' performance counters
  through CIM, which works in any Windows language, with `typeperf` as a
  fallback.
- A universal macOS build that runs natively on Apple silicon and Intel Macs.
- A proper app icon for macOS, Windows and Linux.
- "Check for Updates…" opens the releases page. The app is still unsigned, and
  the README explains the macOS workaround.
- On Linux desktops without a system tray, the window stays reachable: closing
  it minimises it, and it has its own Quit button.

### Changed

- Clicks now follow real disk activity. The speed of the clicking scales with
  how busy the disk is, and the app stays silent when the disk is idle.
  Previously it clicked once a second regardless.
- Short, regular background writes (a service saving every few seconds, for
  example) no longer keep the app clicking.
- Disk activity is measured by the app itself instead of the
  `systeminformation` package: `/proc/diskstats` on Linux, one long-running
  `iostat` on macOS and CIM on Windows. Mounted disk images are not counted
  twice on macOS.
- Audio is played with the Web Audio API instead of Howler. Only the parts of
  each sound that are played stay in memory, and nothing is held while the
  sounds are off (about 16 MB of decoded audio instead of 69 MB).
- On macOS the app only keeps App Nap away while the disk is busy, so your Mac
  can idle-sleep when the ambience is set to 0.
- The "Activity" slider is now labelled "Clicks", and the window shows whether
  the sounds are enabled.
- Updated to Electron 44 and electron-builder 26.

### Fixed

- The app clicked every second even when the disk was idle.
- No sound at all on Windows.
- Clicks kept playing silently in the background for up to a minute each, and
  the ambience loop ran past the end of its sound file.
- The read and write labels were swapped, and the dial-up easter egg played at
  under 7% volume.
- The window looked unstyled when offline, because its stylesheet was loaded
  from the internet.
- Closing the window stopped the sounds.

### Security

- The window runs sandboxed with context isolation, behind a small preload
  bridge. Messages from the page are checked in the main process.
- Web security is back on, and there is a strict Content Security Policy with
  no inline scripts or styles.
- Links only open https URLs on github.com and pixabay.com.
- The app makes no network requests at startup; Chromium's spell check
  dictionary download is disabled.
- `npm audit` is clean, and the app ships with no runtime dependencies.

### Build and release

- One draft GitHub release per tag. It is published only after macOS, Windows
  and Linux have all built, and the tag must match the version in
  `package.json`.
- CI runs lint, 124 unit tests, a check that the build config points at real
  files, and an AppImage build on every pull request. It also runs the real
  disk monitor on macOS and Windows runners, and builds and checks the
  universal macOS app.

## [1.0.1-alpha.3] - 2025-03-22

### Fixed

- Release build fixes.

## [1.0.1-alpha.2] - 2025-03-21

### Changed

- Switched the main process to ES modules and reduced the build size.
- Added a note for macOS users about the "damaged app" warning.

## [1.0.1-alpha.1] - 2025-03-21

### Fixed

- Release workflow fixes.

## [1.0.0] - 2025-03-21

### Added

- First release: a System 7 styled window that plays retro hard drive sounds,
  with two sound sets, a background ambience and a hidden dial-up easter egg.

[Unreleased]: https://github.com/khawkins98/mac-disk-sounds/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/khawkins98/mac-disk-sounds/compare/v1.0.1-alpha.3...v1.1.0
[1.0.1-alpha.3]: https://github.com/khawkins98/mac-disk-sounds/compare/v1.0.1-alpha.2...v1.0.1-alpha.3
[1.0.1-alpha.2]: https://github.com/khawkins98/mac-disk-sounds/compare/v1.0.1-alpha.1...v1.0.1-alpha.2
[1.0.1-alpha.1]: https://github.com/khawkins98/mac-disk-sounds/compare/v1.0.0...v1.0.1-alpha.1
[1.0.0]: https://github.com/khawkins98/mac-disk-sounds/releases/tag/v1.0.0
