# 🎶 Mac Disk Sounds 💾

_Because your modern computer deserves to sound like it's from 1999_

[![Download Now](https://img.shields.io/github/v/release/khawkins98/mac-disk-sounds?label=Download%20Now&style=for-the-badge)](https://github.com/khawkins98/mac-disk-sounds/releases)

## What is this madness? 🤔

Ever miss the satisfying sounds of a hard drive doing its thing? Feel like your fancy SSD is just too... quiet? Well, you're in luck! Mac Disk Sounds brings back that nostalgic whirring, clicking, and seeking of vintage hard drives to your modern computer.

## Features 🌟

- 🔊 Authentic retro HDD sound effects
- 🎚️ Adjustable volume controls
- 🎵 Background disk ambience option
- 🖥️ Classic Mac-style interface
- 💻 Lives in the menu bar / system tray and works in the background while you do actual work
- 💾 Remembers your settings, and can start at login
- 🤓 Perfect for confusing your coworkers
- 🎮 Hidden surprises for the curious (hint: some dots like to be clicked...)
- 🪟 Cross-platform: Linux is tested; disk activity detection on macOS and Windows is new and not yet tested on real machines, and on Windows it currently needs English performance counter names (an English-language Windows install)
- 🏋️ Dozens or hundreds of MBs to download and make your SSD workout! Thanks Electron!

## Installation 🚀

### macOS

1. Download the latest `.dmg` from the releases page
2. Drag the app to your Applications folder
3. Open it and enjoy the sweet sounds of yesteryear!

#### Note for macOS Users

If you see a message saying the app "is damaged and can't be opened" this is because I don't have the $99 annual developer license from Apple. After dragging the app to your Applications folder, you can work around this by removing the quarantine flag:

   ```bash
   xattr -dr com.apple.quarantine "/Applications/Mac Disk Sounds.app"
   ```
   Then try opening the app normally.

### Windows

1. Download the latest Windows installer (`.exe`) from the releases page
2. Run the installer (or use the portable version if you prefer)
3. Launch the app and pretend it's 1999 again!

### Linux

1. Download your preferred format:
   - `.AppImage`: Just make executable and run!
   - `.deb`: For Debian/Ubuntu-based systems
   - `.rpm`: For Red Hat/Fedora-based systems
2. Install using your package manager or run directly
3. Transport yourself back to the age of spinning platters!

## Using it 🖱️

Mac Disk Sounds runs from the menu bar (macOS) or the system tray (Windows and Linux); it has no Dock icon. The tray menu has:

- **Enabled**: turn the sounds on or off. Off stops the clicks, fades out the ambience and stops watching the disk.
- **Sound Set**: which recorded drive the clicks come from.
- **Open Settings…**: the System 7 window with the activity lights, the sound set and the click and ambience volumes.
- **Launch at Login** (installed builds only).
- **Quit**.

Clicking the icon opens or closes the settings window (on Linux most trays only show the menu, so use **Open Settings…**). Closing the window keeps the sounds going; only **Quit** stops the app. Starting the app by hand opens the settings window; starting at login does not. Settings are saved as `settings.json` in the app's user data folder. On Linux, Launch at Login writes `~/.config/autostart/mac-disk-sounds.desktop`.

On macOS, while the sounds are enabled the app asks the system not to put it to sleep (App Nap), so the clicks keep time with no window open. That also keeps the Mac from idle sleep (the display can still sleep); turn the sounds off from the menu bar if that matters to you.

## Building from Source 🛠️

```bash
# Clone this repository
git clone https://github.com/khawkins98/mac-disk-sounds

# Navigate to the directory
cd mac-disk-sounds

# Install dependencies
npm install

# Start the app
npm start

# Run the tests and the linter
npm test
npm run lint

# Check the disk monitor works on this machine (about 5 seconds)
node scripts/smoke-monitor.mjs

# Redraw the tray icons in assets/tray/ (only after changing the script)
node scripts/make-tray-icons.mjs

# Build for your platform
npm run build        # Builds for all platforms (macOS, Windows, Linux)
npm run build:mac    # Builds for macOS only
npm run build:win    # Builds for Windows only
npm run build:linux  # Builds for Linux only
```

### Project layout

```
src/main/        main process: app lifecycle and windows (index.js), tray,
                 settings, launch at login, disk monitor and activity model
src/preload.cjs  the bridge between the pages and main
src/renderer/    the settings window (index.html, renderer.js, styles.css),
                 the hidden audio window (audio.html, audio-host.js, audio.js)
                 and the vendored system.css
assets/sounds/   the sound files and their credits
assets/tray/     tray icons, drawn by scripts/make-tray-icons.mjs
build/           app icons used by electron-builder
scripts/         icon generator and the disk monitor smoke test
test/            node --test unit tests
```

## Publishing Releases 📦

When you want to create a new release, follow these steps:

- Update the version in your project's package.json file (e.g. 1.2.3)
- Commit that change (`git commit -am v1.2.3`)
- Tag your commit (`git tag v1.2.3`). Make sure your tag name's format is v*.*.\*.
  - Your workflow will use this tag to detect when to create a release
- Push your changes to GitHub (`git push && git push --tags`)

The release process will:

- Build packages for all platforms
- Create a GitHub release
- Upload all assets
- Tag the release with the version from package.json

The release workflow publishes with the repository's built-in `GITHUB_TOKEN`; no personal access token is needed.

## Why? 🤷‍♂️

Why not? Sometimes the best projects are the ones that make you smile. Plus, it's a great way to:

- Confuse your younger colleagues
- Pretend you're using a vintage computer
- Add some character to your silent machine
- Practice your "let me explain why my computer is making these sounds" speech
- Time travel back to the days of dial-up (maybe? 🤫)

## Seriously, Why? 🤷‍♂️

This project started as an experiment in two ways:

1. **Testing Cursor AI**: I was curious to see how helpful Cursor's AI assistant would be in building a complete application from scratch. The results were impressive - though I still needed to dive in with some key debugging, helping with image and sound files and guiding it towards things like [sakun/system.css](https://github.com/sakofchit/system.css).

2. **Missing Audio Feedback**: After switching to a fanless MacBook, I found myself missing the audio feedback that tells you when your computer is working hard. Modern computers are so quiet that you can't tell when they're under load.

## Credits 🙏

- IBM hard drive sounds from viertelnachvier on Pixabay
- Additional HDD sounds from martian on Pixabay
- [Dialup sound from wtermini on Pixabay](https://pixabay.com/sound-effects/the-sound-of-dial-up-internet-6240/)
- System 7 interface toolkit from [sakun/system.css](https://github.com/sakofchit/system.css) (MIT; v0.1.11 is bundled in `src/renderer/vendor/system.css/`)
- Built with Electron and too much free time
- Inspired by the golden age of spinning rust

## License 📜

MIT License - Feel free to make your computer sound as vintage as you want!

The sound files in `assets/sounds/` are **not** covered by the MIT licence. They are from Pixabay and used under the Pixabay Content License; see [assets/sounds/CREDITS.md](assets/sounds/CREDITS.md) for authors, sources and the ranges the app uses.

---

_Made with ❤️ and unnecessary disk activity_

P.S. Some say if you click things three times, magic happens... 🎵✨
