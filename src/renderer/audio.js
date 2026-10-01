// Plain Web Audio playback. Every envelope is scheduled on the AudioContext
// clock rather than with timers.
//
// Memory: decoded audio is 32-bit float PCM at the output rate, about
// 0.4 MB per second of stereo, so the full files would be some 90 MB. Only
// what is played is kept: each file is decoded, the parts that are used
// are copied into small buffers, and the full decode is dropped. Everything
// is released while the sounds are off (see release()) and decoded again
// when they come back on. The dial-up clip is decoded only when it is
// played, and dropped when it ends.

const CLICK_SECONDS = 0.3;
const RAMP_SECONDS = 0.01;

const IBM_FILE = '../../assets/sounds/hard-disk-drive-ibm-1999-48823.mp3';
const GENERIC_FILE = '../../assets/sounds/computer-hard-drive-access-fan-click-62422.mp3';
const MODEM_FILE = '../../assets/sounds/the-sound-of-dial-up-internet-6240.mp3';

// Click sets: 300 ms slices taken at random from [from, to) seconds of a
// file. Each decode picks a fresh bank of CLICK_BANK_SIZE slices and every
// click plays one of them at random.
export const CLICK_SETS = Object.freeze({
  generic: { file: GENERIC_FILE, from: 1, to: 40 }, // 0:01 to 0:40 of 0:42
  ibm: { file: IBM_FILE, from: 2, to: 100 } // 0:02 to 1:40 of 2:36
});
const CLICK_BANK_SIZE = 64;

const BACKGROUND = { file: IBM_FILE, from: 110, to: 130, fadeSeconds: 1 }; // loops 1:50 to 2:10
const STARTUP = { file: IBM_FILE, from: 3, to: 12, gain: 0.3, fadeSeconds: 1 }; // 0:03 to 0:12
const MODEM = { file: MODEM_FILE, duckTo: 0.15, duckSeconds: 0.5, restoreSeconds: 1 };

// Move an AudioParam smoothly from wherever it is now to `value`.
function rampTo(param, value, seconds, context) {
  const now = context.currentTime;
  param.cancelAndHoldAtTime(now);
  param.linearRampToValueAtTime(value, now + seconds);
}

/** Copy [from, to) seconds of `source` into a new buffer. */
function sliceBuffer(source, from, to) {
  return concatSlices(source, [[from, to]]);
}

/** Copy several [from, to) second ranges of `source`, back to back, into one new buffer. */
function concatSlices(source, ranges) {
  const rate = source.sampleRate;
  const frames = ranges.map(([from, to]) => {
    const start = Math.max(0, Math.min(source.length, Math.round(from * rate)));
    const end = Math.max(start, Math.min(source.length, Math.round(to * rate)));
    return [start, end];
  });
  const length = Math.max(1, frames.reduce((sum, [start, end]) => sum + end - start, 0));
  const out = new AudioBuffer({ length, numberOfChannels: source.numberOfChannels, sampleRate: rate });
  for (let channel = 0; channel < source.numberOfChannels; channel++) {
    const data = source.getChannelData(channel);
    let at = 0;
    for (const [start, end] of frames) {
      out.copyToChannel(data.subarray(start, end), channel, at);
      at += end - start;
    }
  }
  return out;
}

/** A bank of `count` random CLICK_SECONDS slices from [from, to) of `source`. */
function clickBank(source, { from, to }, count) {
  const ranges = Array.from({ length: count }, () => {
    const start = from + Math.random() * (to - from - CLICK_SECONDS);
    return [start, start + CLICK_SECONDS];
  });
  return { buffer: concatSlices(source, ranges), count };
}

const bufferBytes = (buffer) => (buffer ? buffer.length * buffer.numberOfChannels * 4 : 0);

export class AudioEngine {
  constructor() {
    this.context = new AudioContext();
    // Decoded audio we keep; null while released.
    this.sounds = null;
    // Bumped by release(), so a decode that finishes afterwards is dropped.
    this.loadToken = 0;
    // The decode under way, if any.
    this.loading = null;

    // background source -> backgroundGain (slider) -> duckGain (modem) -> out
    this.duckGain = new GainNode(this.context, { gain: 1 });
    this.duckGain.connect(this.context.destination);
    this.backgroundGain = new GainNode(this.context, { gain: 0 });
    this.backgroundGain.connect(this.duckGain);
    this.backgroundVolume = 0;
    this.backgroundSource = null;

    this.modemSource = null;
    this.modemLoading = false;
    this.enabled = true;
    this.enabledToken = 0;
  }

  /**
   * Chromium can start an AudioContext suspended until a user gesture.
   * The audio window allows autoplay (autoplayPolicy in src/main/index.js),
   * but if that ever fails, resume on the first click or key press.
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

  async #decode(file) {
    const response = await fetch(file);
    if (!response.ok) throw new Error(`Could not load ${file}: HTTP ${response.status}`);
    return this.context.decodeAudioData(await response.arrayBuffer());
  }

  get loaded() {
    return this.sounds !== null;
  }

  /**
   * Decode the click banks and the background loop (and the start-up clip
   * if `startup`), one file at a time so only one full decode is in memory
   * at once. Does nothing if already loaded, and shares a decode already
   * under way. Resolves to false if release() was called meanwhile
   * (nothing is kept then).
   */
  load({ startup = false } = {}) {
    if (this.sounds) return Promise.resolve(true);
    if (!this.loading) {
      const loading = this.#load(startup).finally(() => {
        if (this.loading === loading) this.loading = null;
      });
      this.loading = loading;
    }
    return this.loading;
  }

  async #load(startup) {
    const token = this.loadToken;
    // Each full decode goes out of scope as soon as its parts are copied.
    const ibm = await this.#decodeParts(IBM_FILE, (full) => ({
      background: sliceBuffer(full, BACKGROUND.from, BACKGROUND.to),
      startup: startup ? sliceBuffer(full, STARTUP.from, STARTUP.to) : null,
      clicks: clickBank(full, CLICK_SETS.ibm, CLICK_BANK_SIZE)
    }));
    if (token !== this.loadToken) return false;
    const generic = await this.#decodeParts(GENERIC_FILE, (full) => clickBank(full, CLICK_SETS.generic, CLICK_BANK_SIZE));
    if (token !== this.loadToken) return false;
    this.sounds = {
      background: ibm.background,
      startup: ibm.startup,
      clicks: { ibm: ibm.clicks, generic }
    };
    return true;
  }

  /** Decode `file` and return what `pick` copies out of it. */
  async #decodeParts(file, pick) {
    return pick(await this.#decode(file));
  }

  /** Bytes of decoded audio held now. */
  get decodedBytes() {
    const s = this.sounds;
    if (!s) return 0;
    return bufferBytes(s.background) + bufferBytes(s.startup) +
      Object.values(s.clicks).reduce((sum, bank) => sum + bufferBytes(bank.buffer), 0) +
      bufferBytes(this.modemSource?.buffer);
  }

  /**
   * Drop every decoded buffer (and the sources playing them), so a
   * disabled app holds no PCM. load() brings them back.
   */
  release() {
    // A decode under way is abandoned; the next load() starts afresh.
    this.loadToken++;
    this.loading = null;
    this.stopModem();
    if (this.backgroundSource) {
      try {
        this.backgroundSource.stop();
      } catch {
        // Already stopped.
      }
      this.backgroundSource.disconnect();
      this.backgroundSource = null;
    }
    this.sounds = null;
  }

  get currentTime() {
    return this.context.currentTime;
  }

  /** Background volume, 0..1. */
  setBackgroundVolume(volume) {
    this.backgroundVolume = volume;
    if (this.backgroundSource && this.enabled) rampTo(this.backgroundGain.gain, volume, 0.05, this.context);
  }

  /**
   * Turn the engine on or off. Off fades the ambience out, stops the modem
   * clip, then suspends the AudioContext and releases the decoded audio, so
   * a disabled app does no audio work and holds no PCM. On resumes the
   * context and fades the ambience back in; call load() first if the audio
   * was released.
   */
  setEnabled(enabled) {
    this.enabled = enabled;
    const token = ++this.enabledToken;
    if (enabled) {
      this.context.resume().catch(() => {});
      if (this.backgroundSource) {
        rampTo(this.backgroundGain.gain, this.backgroundVolume, BACKGROUND.fadeSeconds, this.context);
      } else {
        this.startBackground();
      }
      return;
    }
    this.stopModem();
    if (this.backgroundSource) rampTo(this.backgroundGain.gain, 0, BACKGROUND.fadeSeconds, this.context);
    // Once the fade has finished, unless re-enabled in the meantime.
    setTimeout(() => {
      if (token !== this.enabledToken || this.enabled) return;
      this.release();
      this.context.suspend().catch(() => {});
    }, (BACKGROUND.fadeSeconds + 0.2) * 1000);
  }

  /** Start the looping background ambience with a fade in. */
  startBackground() {
    if (this.backgroundSource || !this.sounds) return;
    const source = new AudioBufferSourceNode(this.context, { buffer: this.sounds.background, loop: true });
    source.connect(this.backgroundGain);
    source.start(this.context.currentTime);
    this.backgroundSource = source;
    rampTo(this.backgroundGain.gain, this.backgroundVolume, BACKGROUND.fadeSeconds, this.context);
  }

  /**
   * The spin-up clip played once at launch, faded in and out. Needs
   * load({startup: true}); the clip is dropped once played.
   */
  playStartup() {
    const buffer = this.sounds?.startup;
    if (!buffer) return;
    this.sounds.startup = null;
    const now = this.context.currentTime;
    const { gain: level, fadeSeconds } = STARTUP;
    const duration = buffer.duration;
    const gain = new GainNode(this.context, { gain: 0 });
    gain.connect(this.context.destination);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(level, now + fadeSeconds);
    gain.gain.setValueAtTime(level, now + duration - fadeSeconds);
    gain.gain.linearRampToValueAtTime(0, now + duration);
    const source = new AudioBufferSourceNode(this.context, { buffer });
    source.connect(gain);
    source.onended = () => {
      source.disconnect();
      gain.disconnect();
    };
    source.start(now);
  }

  /**
   * Schedule one 300 ms click from `setName` at audio time `when`, with a
   * 10 ms attack and release. Returns {start, end, stop} with times in
   * audio time; stop() cancels the click, scheduled or playing. Returns
   * null if the sounds are not loaded.
   */
  click(setName, when, volume) {
    const bank = this.sounds?.clicks[setName] ?? this.sounds?.clicks.generic;
    if (!bank) return null;
    const start = Math.max(when, this.context.currentTime);
    const end = start + CLICK_SECONDS;
    const offset = Math.floor(Math.random() * bank.count) * CLICK_SECONDS;

    const gain = new GainNode(this.context, { gain: 0 });
    gain.connect(this.context.destination);
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(volume, start + RAMP_SECONDS);
    gain.gain.setValueAtTime(volume, end - RAMP_SECONDS);
    gain.gain.linearRampToValueAtTime(0, end);

    const source = new AudioBufferSourceNode(this.context, { buffer: bank.buffer });
    source.connect(gain);
    source.onended = () => {
      source.disconnect();
      gain.disconnect();
    };
    source.start(start, offset, CLICK_SECONDS);
    return {
      start,
      end,
      stop: () => {
        try {
          source.stop();
        } catch {
          // Already stopped.
        }
      }
    };
  }

  get modemPlaying() {
    return this.modemSource !== null || this.modemLoading;
  }

  stopModem() {
    try {
      this.modemSource?.stop();
    } catch {
      // Not started or already stopped.
    }
  }

  /**
   * Decode and play the full dial-up clip, ducking the background loop
   * while it plays; the clip is dropped when it ends. Resolves to false if
   * it is already playing, or the engine was turned off while decoding.
   */
  async playModem(volume, onEnded) {
    if (this.modemPlaying) return false;
    this.modemLoading = true;
    const token = this.enabledToken;
    let buffer;
    try {
      buffer = await this.#decode(MODEM.file);
    } finally {
      this.modemLoading = false;
    }
    if (token !== this.enabledToken || !this.enabled) return false;
    const gain = new GainNode(this.context, { gain: volume });
    gain.connect(this.context.destination);
    const source = new AudioBufferSourceNode(this.context, { buffer });
    source.connect(gain);
    source.onended = () => {
      source.disconnect();
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
