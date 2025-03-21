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
- 💻 Works in the background while you do actual work
- 🤓 Perfect for confusing your coworkers
- 🎮 Hidden surprises for the curious (hint: some dots like to be clicked...)
- 🪟 Cross-platform: Works on macOS, Windows, and Linux!
- 🏋️ Dozens or hundreds of MBs to download and make your SSD workout! Thanks Electron!

## Installation 🚀

### macOS

1. Download the latest `.dmg` from the releases page
2. Drag the app to your Applications folder
3. Open it and enjoy the sweet sounds of yesteryear!

#### Note for macOS Users

If you see a message saying the app "is damaged and can't be opened" this is because I don't have the $99 annual developer license from Apple, you workaround this by:

   ```bash
   xattr -cr "~/Downloads/Mac Disk Sounds.app"
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

## Building from Source 🛠️

```bash
# Clone this repository
git clone https://github.com/yourusername/mac-disk-sounds

# Navigate to the directory
cd mac-disk-sounds

# Install dependencies
npm install

# Start the app
npm start

# Build for your platform
npm run build        # Builds for all platforms (macOS, Windows, Linux)
npm run build:mac    # Builds for macOS only
npm run build:win    # Builds for Windows only
npm run build:linux  # Builds for Linux only
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

Note: You'll need a GitHub personal access token with `repo` permissions to publish releases.

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
- System 7 interface toolkit from [sakun/system.css](https://github.com/sakofchit/system.css)
- Built with Electron and too much free time
- Inspired by the golden age of spinning rust

## License 📜

MIT License - Feel free to make your computer sound as vintage as you want!

---

_Made with ❤️ and unnecessary disk activity_

P.S. Some say if you click things three times, magic happens... 🎵✨
