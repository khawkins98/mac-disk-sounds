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
// The sounds are decoded and the engine is on.
let ready = false;
// Bumped on every enable and disable, so a decode that finishes after the
// setting changed again is ignored.
let generation = 0;
// start() has read the settings; until then applySettings only records them.
let started = false;
let settings = null;
let activity = { active: false, level: 0 };
let schedulerTimer = null;
let nextClickAt = 0;
let scheduledClicks = [];

const shouldClick = () => ready && settings.enabled && activity.active && audio.loaded;

// While active, clicks are scheduled a little ahead on the audio clock at a
// density set by the level, with some jitter so it sounds like seeking.
function scheduleClicks() {
  if (!shouldClick()) return;
  const now = audio.currentTime;
  scheduledClicks = scheduledClicks.filter((click) => click.end > now);
  if (nextClickAt < now) nextClickAt = now;
  while (nextClickAt < now + LOOKAHEAD_SECONDS) {
    const click = audio.click(settings.soundSet, nextClickAt, settings.clickVolume);
    if (!click) return;
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

function reportLoaded() {
  bridge.reportAudioStatus({ ok: true, decodedBytes: audio.decodedBytes });
}

function reportError(error) {
  console.error('Could not load sounds:', error);
  bridge.reportAudioStatus({ ok: false, error: String(error?.message ?? error) });
}

// Turned off: stop clicking; the engine fades out, then suspends and
// releases its decoded audio.
function disable() {
  generation++;
  ready = false;
  cancelScheduledClicks();
  updateScheduler();
  audio.setEnabled(false);
}

// Turned back on: decode the sounds again if they were released, then fade
// the ambience back in. Turning the engine on first also cancels a release
// still pending from a quick off-and-on.
async function enable() {
  const current = ++generation;
  audio.setBackgroundVolume(settings.ambienceVolume);
  audio.setEnabled(true);
  try {
    if (!(await audio.load())) return;
  } catch (error) {
    if (current === generation) reportError(error);
    return;
  }
  if (current !== generation || !settings.enabled) return;
  audio.startBackground();
  ready = true;
  updateScheduler();
  reportLoaded();
}

function applySettings(next) {
  const previous = settings;
  settings = next;
  // Before start() has run, it picks up the latest settings itself.
  if (previous === null || !started) return;
  // Drop clicks already scheduled from the old set.
  if (next.soundSet !== previous.soundSet) cancelScheduledClicks();
  audio.setBackgroundVolume(next.ambienceVolume);
  if (next.enabled !== previous.enabled) {
    if (next.enabled) {
      enable();
    } else {
      disable();
    }
  }
  updateScheduler();
}

bridge.onActivity((state) => {
  activity = state;
  updateScheduler();
});

bridge.onSettings(applySettings);

bridge.onModemCommand(async () => {
  if (!ready || !settings.enabled || audio.modemPlaying) return;
  // Same 0..1 scale as the clicks. The clip is decoded on demand.
  try {
    if (await audio.playModem(settings.clickVolume, () => bridge.reportModem(false))) {
      bridge.reportModem(true);
    }
  } catch (error) {
    console.error('Could not play the dial-up clip:', error);
  }
});

// Start up: if enabled, decode the sounds, then the spin-up clip and the
// ambience. If disabled, decode nothing until the sounds are turned on.
async function start() {
  settings = await bridge.getSettings();
  audio.resumeWhenAllowed();
  started = true;
  if (!settings.enabled) {
    disable();
    bridge.reportAudioStatus({ ok: true, decodedBytes: 0 });
    return;
  }
  const current = ++generation;
  await audio.load({ startup: true });
  if (current !== generation) return;
  ready = true;
  audio.setBackgroundVolume(settings.ambienceVolume);
  audio.playStartup();
  audio.startBackground();
  updateScheduler();
  reportLoaded();
}

start().catch(reportError);
