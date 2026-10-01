// Plain Web Audio playback: every file is decoded once, and every envelope
// is scheduled on the AudioContext clock rather than with timers.

const CLICK_SECONDS = 0.3;
const RAMP_SECONDS = 0.01;

const IBM_FILE = 'sounds/hard-disk-drive-ibm-1999-48823.mp3';
const GENERIC_FILE = 'sounds/computer-hard-drive-access-fan-click-62422.mp3';
const MODEM_FILE = 'sounds/the-sound-of-dial-up-internet-6240.mp3';

// Click sets: random 300 ms slices taken from [from, to) seconds of a file.
export const CLICK_SETS = Object.freeze({
  generic: { file: GENERIC_FILE, from: 1, to: 40 }, // 0:01 to 0:40 of 0:42
  ibm: { file: IBM_FILE, from: 2, to: 100 } // 0:02 to 1:40 of 2:36
});

const BACKGROUND = { file: IBM_FILE, loopStart: 110, loopEnd: 130, fadeSeconds: 1 }; // 1:50 to 2:10
const STARTUP = { file: IBM_FILE, offset: 3, duration: 9, gain: 0.3, fadeSeconds: 1 }; // 0:03 to 0:12
const MODEM = { file: MODEM_FILE, duckTo: 0.15, duckSeconds: 0.5, restoreSeconds: 1 };

// Move an AudioParam smoothly from wherever it is now to `value`.
function rampTo(param, value, seconds, context) {
  const now = context.currentTime;
  param.cancelAndHoldAtTime(now);
  param.linearRampToValueAtTime(value, now + seconds);
}

export class AudioEngine {
  constructor() {
    this.context = new AudioContext();
    this.buffers = new Map();

    // background source -> backgroundGain (slider) -> duckGain (modem) -> out
    this.duckGain = new GainNode(this.context, { gain: 1 });
    this.duckGain.connect(this.context.destination);
    this.backgroundGain = new GainNode(this.context, { gain: 0 });
    this.backgroundGain.connect(this.duckGain);
    this.backgroundVolume = 0;
    this.backgroundSource = null;

    this.modemSource = null;
  }

  /**
   * Chromium can start an AudioContext suspended until a user gesture.
   * Electron normally allows autoplay (see autoplayPolicy in main.js), but
   * if it does not, resume on the first click or key press.
   */
  resumeWhenAllowed() {
    if (this.context.state !== 'suspended') return;
    this.context.resume().catch(() => {});
    const resume = () => {
      this.context.resume().catch(() => {});
      if (this.context.state !== 'suspended') {
        window.removeEventListener('pointerdown', resume, true);
        window.removeEventListener('keydown', resume, true);
      }
    };
    window.addEventListener('pointerdown', resume, true);
    window.addEventListener('keydown', resume, true);
  }

  /** Fetch and decode every sound file once. */
  async load() {
    const files = [IBM_FILE, GENERIC_FILE, MODEM_FILE];
    await Promise.all(files.map(async (file) => {
      const response = await fetch(file);
      if (!response.ok) throw new Error(`Could not load ${file}: HTTP ${response.status}`);
      const data = await response.arrayBuffer();
      this.buffers.set(file, await this.context.decodeAudioData(data));
    }));
  }

  get currentTime() {
    return this.context.currentTime;
  }

  /** Background volume, 0..1. */
  setBackgroundVolume(volume) {
    this.backgroundVolume = volume;
    if (this.backgroundSource) rampTo(this.backgroundGain.gain, volume, 0.05, this.context);
  }

  /** Start the looping background ambience with a fade in. */
  startBackground() {
    if (this.backgroundSource) return;
    const source = new AudioBufferSourceNode(this.context, {
      buffer: this.buffers.get(BACKGROUND.file),
      loop: true,
      loopStart: BACKGROUND.loopStart,
      loopEnd: BACKGROUND.loopEnd
    });
    source.connect(this.backgroundGain);
    source.start(this.context.currentTime, BACKGROUND.loopStart);
    this.backgroundSource = source;
    rampTo(this.backgroundGain.gain, this.backgroundVolume, BACKGROUND.fadeSeconds, this.context);
  }

  /** The spin-up clip played once at launch, faded in and out. */
  playStartup() {
    const now = this.context.currentTime;
    const { offset, duration, gain: level, fadeSeconds } = STARTUP;
    const gain = new GainNode(this.context, { gain: 0 });
    gain.connect(this.context.destination);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(level, now + fadeSeconds);
    gain.gain.setValueAtTime(level, now + duration - fadeSeconds);
    gain.gain.linearRampToValueAtTime(0, now + duration);
    const source = new AudioBufferSourceNode(this.context, { buffer: this.buffers.get(STARTUP.file) });
    source.connect(gain);
    source.onended = () => gain.disconnect();
    source.start(now, offset, duration);
  }

  /**
   * Schedule one 300 ms click from `setName` at audio time `when`, with a
   * 10 ms attack and release. Returns {start, end} in audio time.
   */
  click(setName, when, volume) {
    const set = CLICK_SETS[setName] ?? CLICK_SETS.generic;
    const buffer = this.buffers.get(set.file);
    const start = Math.max(when, this.context.currentTime);
    const end = start + CLICK_SECONDS;
    const offset = set.from + Math.random() * (set.to - set.from - CLICK_SECONDS);

    const gain = new GainNode(this.context, { gain: 0 });
    gain.connect(this.context.destination);
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(volume, start + RAMP_SECONDS);
    gain.gain.setValueAtTime(volume, end - RAMP_SECONDS);
    gain.gain.linearRampToValueAtTime(0, end);

    const source = new AudioBufferSourceNode(this.context, { buffer });
    source.connect(gain);
    source.onended = () => gain.disconnect();
    source.start(start, offset, CLICK_SECONDS);
    return { start, end };
  }

  get modemPlaying() {
    return this.modemSource !== null;
  }

  /**
   * Play the full dial-up clip, ducking the background loop while it plays.
   * Returns false if it is already playing.
   */
  playModem(volume, onEnded) {
    if (this.modemSource) return false;
    const gain = new GainNode(this.context, { gain: volume });
    gain.connect(this.context.destination);
    const source = new AudioBufferSourceNode(this.context, { buffer: this.buffers.get(MODEM.file) });
    source.connect(gain);
    source.onended = () => {
      gain.disconnect();
      this.modemSource = null;
      rampTo(this.duckGain.gain, 1, MODEM.restoreSeconds, this.context);
      onEnded?.();
    };
    rampTo(this.duckGain.gain, MODEM.duckTo, MODEM.duckSeconds, this.context);
    source.start();
    this.modemSource = source;
    return true;
  }
}
