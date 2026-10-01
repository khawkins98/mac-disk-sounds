# Sound credits

The audio files in this directory are third-party works from
[Pixabay](https://pixabay.com/). They are **not** covered by this
repository's MIT licence. They are used under the
[Pixabay Content License](https://pixabay.com/service/license-summary/).
In short, that licence allows using them as part of this app, but not
redistributing them on their own as standalone audio files; see the
licence for the full terms.

Sprite ranges below are what `renderer.js` uses, written as Howler's
`[offset, duration]` in milliseconds. Lengths were measured from the
files; the original download dates were not recorded.

## hard-disk-drive-ibm-1999-48823.mp3

- Credited as: IBM HDD (1999)
- Author: viertelnachvier
- Source: https://pixabay.com/sound-effects/hard-disk-drive-ibm-1999-48823/
- Licence: Pixabay Content License
- Length: about 2:36
- Used for:
  - Startup sound: `[3000, 9000]` (0:03 to 0:12), faded in and out.
  - Background loop: `[110000, 20000]` (1:50 to 2:10), looped.
  - "IBM Hard Drive (1999)" click set: 8 random 300 ms slices,
    `[offset, 300]` with offsets between 2000 and 99700 (0:02 to 1:40),
    chosen at each launch.

## computer-hard-drive-access-fan-click-62422.mp3

- Credited as: HDD Access
- Author: martian
- Source: https://pixabay.com/sound-effects/computer-hard-drive-access-fan-click-62422/
- Licence: Pixabay Content License
- Length: about 0:42
- Used for: the default "Computer Hard Drive Access" click set: 8 random
  300 ms slices, `[offset, 300]` with offsets between 1000 and 39700
  (0:01 to 0:40), chosen at each launch.

## the-sound-of-dial-up-internet-6240.mp3

- Credited as: Dialup sound
- Author: wtermini
- Source: https://pixabay.com/sound-effects/the-sound-of-dial-up-internet-6240/
- Licence: Pixabay Content License
- Length: about 0:29
- Used for: the hidden easter egg, played in full (no sprite).
