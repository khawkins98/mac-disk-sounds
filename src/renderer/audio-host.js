// The hidden audio window. It shows nothing; it plays the clicks and the
// ambience for as long as the app runs, whether or not the settings window
// is open. It talks to main only through window.diskSounds (preload.cjs).
import { AudioEngine } from './audio.js';
import { nextInterval } from './clicks.js';

const bridge = window.diskSounds;

// How far ahead clicks are scheduled on the audio clock, and how often the
// schedule is topped up.
const LOOKAHEAD_SECONDS = 0.25;
const SCHEDULER_INTERVAL_MS = 100;

const audio = new AudioEngine();
let ready = false;
let settings = null;
let activity = { active: false, level: 0 };
let schedulerTimer = null;
let nextClickAt = 0;
let scheduledClicks = [];

const shouldClick = () => ready && settings.enabled && activity.active;

// While active, clicks are scheduled a little ahead on the audio clock at a
// density set by the level, with some jitter so it sounds like seeking.
function scheduleClicks() {
  if (!shouldClick()) return;
  const now = audio.currentTime;
  scheduledClicks = scheduledClicks.filter((click) => click.end > now);
  if (nextClickAt < now) nextClickAt = now;
  while (nextClickAt < now + LOOKAHEAD_SECONDS) {
    const click = audio.click(settings.soundSet, nextClickAt, settings.clickVolume);
    scheduledClicks.push(click);
    nextClickAt = click.start + nextInterval(activity.level);
  }
}

function cancelScheduledClicks() {
  scheduledClicks.forEach((click) => click.stop());
  scheduledClicks = [];
  nextClickAt = 0;
}

// Run the scheduler only while there is something to schedule.
function updateScheduler() {
  if (shouldClick()) {
    if (schedulerTimer === null) schedulerTimer = setInterval(scheduleClicks, SCHEDULER_INTERVAL_MS);
    scheduleClicks();
  } else if (schedulerTimer !== null) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

function applySettings(next) {
  const previous = settings;
  settings = next;
  if (!ready) return;
  // Drop clicks already scheduled from the old set, or when turned off.
  if (next.soundSet !== previous.soundSet || !next.enabled) cancelScheduledClicks();
  audio.setBackgroundVolume(next.ambienceVolume);
  if (next.enabled !== previous.enabled) audio.setEnabled(next.enabled);
  updateScheduler();
}

bridge.onActivity((state) => {
  activity = state;
  updateScheduler();
});

bridge.onSettings(applySettings);

bridge.onModemCommand(() => {
  if (!ready || !settings.enabled || audio.modemPlaying) return;
  // Same 0..1 scale as the clicks.
  if (audio.playModem(settings.clickVolume, () => bridge.reportModem(false))) {
    bridge.reportModem(true);
  }
});

// Start up: decode everything once, then (if enabled) the spin-up clip and
// the ambience.
async function start() {
  settings = await bridge.getSettings();
  audio.resumeWhenAllowed();
  await audio.load();
  ready = true;
  audio.setBackgroundVolume(settings.ambienceVolume);
  if (settings.enabled) {
    audio.playStartup();
    audio.startBackground();
  } else {
    audio.setEnabled(false);
  }
  updateScheduler();
  bridge.reportAudioStatus({ ok: true, buffers: audio.buffers.size });
}

start().catch((error) => {
  console.error('Could not load sounds:', error);
  bridge.reportAudioStatus({ ok: false, error: String(error?.message ?? error) });
});
