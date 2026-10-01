// The settings window: plain browser JavaScript. It talks to the main
// process only through window.diskSounds (preload.cjs). It plays nothing
// itself; the hidden audio window does, so sounds carry on when this window
// is closed.
import { nextInterval } from './clicks.js';

const bridge = window.diskSounds;

// How long a dot stays lit for one click, in ms (a click is 300 ms long).
const BLINK_MS = 150;

// UI elements
const mainWindow = document.getElementById('main-window');
const enabledCheckbox = document.getElementById('enabled');
const clickVolumeSlider = document.getElementById('click-volume');
const ambienceVolumeSlider = document.getElementById('ambience-volume');
const soundSetSelect = document.getElementById('sound-set');
const activityIndicators = Array.from({ length: 5 }, (_, i) => document.getElementById(`activity-indicator-${i + 1}`));
const diskSpeed = document.getElementById('disk-speed');

// Sliders are 0-7; settings store volumes as 0..1.
const SLIDER_STEPS = 7;
const toSlider = (volume) => String(Math.round(volume * SLIDER_STEPS));
const fromSlider = (slider) => parseInt(slider.value, 10) / SLIDER_STEPS;

// Window focus styling
const setFocused = (focused) => mainWindow.classList.toggle('inactive', !focused);
window.addEventListener('focus', () => setFocused(true));
window.addEventListener('blur', () => setFocused(false));
setFocused(document.hasFocus());

// Window controls
document.querySelector('button[aria-label="Close"]').addEventListener('click', () => {
  bridge.windowControl('close');
});
document.querySelector('button[aria-label="Resize"]').addEventListener('click', () => {
  bridge.windowControl('minimize');
});

// External links open in the browser (main checks them against an allowlist).
document.addEventListener('click', (event) => {
  const link = event.target.closest('a[href]');
  if (!link) return;
  event.preventDefault();
  bridge.openExternal(link.href);
});

// Settings. Main validates and stores them and pushes every change back
// (including ones made from the tray menu), so the controls only ever show
// what main has.
let settings = null;

function showSettings(next) {
  settings = next;
  enabledCheckbox.checked = next.enabled;
  soundSetSelect.value = next.soundSet;
  // Leave a slider alone while it is being dragged.
  if (document.activeElement !== clickVolumeSlider) clickVolumeSlider.value = toSlider(next.clickVolume);
  if (document.activeElement !== ambienceVolumeSlider) ambienceVolumeSlider.value = toSlider(next.ambienceVolume);
  mainWindow.classList.toggle('disabled', !next.enabled);
  updateActivityDisplay();
}

enabledCheckbox.addEventListener('change', () => bridge.setSettings({ enabled: enabledCheckbox.checked }));
soundSetSelect.addEventListener('change', () => bridge.setSettings({ soundSet: soundSetSelect.value }));
clickVolumeSlider.addEventListener('input', () => bridge.setSettings({ clickVolume: fromSlider(clickVolumeSlider) }));
ambienceVolumeSlider.addEventListener('input', () => bridge.setSettings({ ambienceVolume: fromSlider(ambienceVolumeSlider) }));

// Activity display. The dots blink at the same pace as the clicks (the
// audio window schedules the real ones); one function owns the dots and
// stands aside while the easter egg animation runs.
let activity = { active: false, level: 0 };
let dialupAnimation = null;
let blinkTimer = null;
let blinkOffTimer = null;

const setLitDots = (count) => {
  if (dialupAnimation) return;
  activityIndicators.forEach((indicator, i) => indicator.classList.toggle('active', i < count));
};

const formatBytes = (bytes) => {
  if (!(bytes > 0)) return '0 B/s';
  const k = 1024;
  const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
};

const describeSpeed = ({ readBps, writeBps, totalBps }) => {
  if (readBps === null || writeBps === null) return formatBytes(totalBps);
  return `${readBps >= writeBps ? 'read' : 'write'} ${formatBytes(totalBps)}`;
};

const isBusy = () => Boolean(settings?.enabled && activity.active);

function blink() {
  blinkTimer = null;
  if (!isBusy()) return;
  setLitDots(Math.max(1, activity.level));
  clearTimeout(blinkOffTimer);
  blinkOffTimer = setTimeout(() => setLitDots(0), BLINK_MS);
  blinkTimer = setTimeout(blink, nextInterval(activity.level) * 1000);
}

function updateActivityDisplay() {
  if (isBusy()) {
    diskSpeed.textContent = describeSpeed(activity);
    if (blinkTimer === null) blink();
  } else {
    diskSpeed.textContent = settings && !settings.enabled ? 'Disabled' : '';
    clearTimeout(blinkTimer);
    blinkTimer = null;
    setLitDots(0);
  }
}

// Called on every state or level change and, while active, about once a
// second with fresh rates for the readout.
bridge.onActivity((state) => {
  activity = state;
  updateActivityDisplay();
});

bridge.onAudioStatus(({ ok }) => {
  activityIndicators.forEach((indicator) => indicator.classList.toggle('error', !ok));
});

// Easter egg: three quick clicks on the dots dial into the 90s. The audio
// window plays the clip and says when it starts and ends.
const dialupPatterns = [
  [1, 0, 0, 0, 0], // Initial connection
  [1, 1, 0, 0, 0], // Handshake start
  [1, 1, 1, 0, 0], // Negotiating
  [0, 1, 1, 1, 0], // Synchronizing
  [0, 0, 1, 1, 1], // Almost there
  [1, 0, 1, 0, 1], // Final handshake
  [1, 1, 1, 1, 1] // Connected!
];

const showDialupPattern = (pattern) => {
  activityIndicators.forEach((indicator, i) => {
    indicator.classList.toggle('active', Boolean(pattern[i]));
    indicator.classList.toggle('dialup', Boolean(pattern[i]));
  });
};

const stopDialupAnimation = () => {
  if (!dialupAnimation) return;
  clearInterval(dialupAnimation);
  dialupAnimation = null;
  activityIndicators.forEach((indicator) => indicator.classList.remove('dialup'));
  setLitDots(0);
};

const startDialupAnimation = () => {
  if (dialupAnimation) return;
  let patternIndex = 0;
  showDialupPattern(dialupPatterns[patternIndex]);
  // Change pattern every 800 ms, roughly the pace of a real handshake.
  dialupAnimation = setInterval(() => {
    patternIndex = (patternIndex + 1) % dialupPatterns.length;
    showDialupPattern(dialupPatterns[patternIndex]);
  }, 800);
};

bridge.onModem(({ playing }) => {
  if (playing) {
    startDialupAnimation();
  } else {
    stopDialupAnimation();
  }
});

let clickCount = 0;
let clickTimer = null;
activityIndicators.forEach((indicator) => {
  indicator.addEventListener('click', () => {
    clickCount++;
    clearTimeout(clickTimer);
    // Reset the count after a second without clicks.
    clickTimer = setTimeout(() => {
      clickCount = 0;
    }, 1000);

    if (clickCount < 3) return;
    clickCount = 0;
    clearTimeout(clickTimer);
    bridge.playModem();
  });
});

bridge.onSettings(showSettings);
bridge.getSettings().then(showSettings);
