// Renderer: plain browser JavaScript. It talks to the main process only
// through window.diskSounds (preload.cjs) and only renders and plays.
import { AudioEngine } from './audio.js';

const bridge = window.diskSounds;

// Clicks per second for each activity level (index 0 = idle).
const CLICKS_PER_SECOND = [0, 1.5, 2.5, 4, 6, 9];
// How far ahead clicks are scheduled on the audio clock, and how often the
// schedule is topped up.
const LOOKAHEAD_SECONDS = 0.25;
const SCHEDULER_INTERVAL_MS = 100;

// UI elements
const mainWindow = document.getElementById('main-window');
const volumeSlider = document.getElementById('volume');
const volumeValue = document.getElementById('volume-value');
const backgroundVolumeSlider = document.getElementById('background-volume');
const backgroundVolumeValue = document.getElementById('background-volume-value');
const soundSetSelect = document.getElementById('sound-set');
const activityIndicators = Array.from({ length: 5 }, (_, i) => document.getElementById(`activity-indicator-${i + 1}`));
const diskSpeed = document.getElementById('disk-speed');

// Sliders are 0-7.
const sliderVolume = (slider) => parseInt(slider.value, 10) / 7;

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

const audio = new AudioEngine();
let audioReady = false;

// Controls
let clickVolume = sliderVolume(volumeSlider);
let currentSoundSet = soundSetSelect.value;
audio.setBackgroundVolume(sliderVolume(backgroundVolumeSlider));

volumeSlider.addEventListener('input', () => {
  volumeValue.textContent = volumeSlider.value;
  clickVolume = sliderVolume(volumeSlider);
});

backgroundVolumeSlider.addEventListener('input', () => {
  backgroundVolumeValue.textContent = backgroundVolumeSlider.value;
  audio.setBackgroundVolume(sliderVolume(backgroundVolumeSlider));
});

soundSetSelect.addEventListener('change', () => {
  currentSoundSet = soundSetSelect.value;
});

// Activity indicators. One function owns the dots; it stands aside while the
// easter egg animation runs, so the two never fight over them.
let dialupAnimation = null;
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

// Click scheduling. Main says when the disk is active and how busy (level
// 1-5); while active, clicks are scheduled a little ahead on the audio clock
// at a density set by the level, with some jitter so it sounds like seeking.
let activity = { active: false, level: 0 };
let schedulerTimer = null;
let nextClickAt = 0;
let scheduledClicks = [];
let renderFrame = null;

const nextInterval = (level) => (1 / CLICKS_PER_SECOND[level]) * (0.4 + Math.random() * 1.2);

const scheduleClicks = () => {
  if (!activity.active || !audioReady) return;
  const now = audio.currentTime;
  // Also pruned here: animation frames do not run while the window is hidden.
  scheduledClicks = scheduledClicks.filter((click) => click.end > now);
  if (nextClickAt < now) nextClickAt = now;
  while (nextClickAt < now + LOOKAHEAD_SECONDS) {
    const click = audio.click(currentSoundSet, nextClickAt, clickVolume);
    scheduledClicks.push(click);
    nextClickAt = click.start + nextInterval(activity.level);
  }
  startRendering();
};

// Light the dots while a click is actually sounding.
const renderDots = () => {
  renderFrame = null;
  const now = audio.currentTime;
  scheduledClicks = scheduledClicks.filter((click) => click.end > now);
  const sounding = scheduledClicks.some((click) => click.start <= now);
  setLitDots(sounding ? Math.max(1, activity.level) : 0);
  if (activity.active || scheduledClicks.length > 0) startRendering();
};

function startRendering() {
  if (renderFrame === null) renderFrame = requestAnimationFrame(renderDots);
}

const onActivity = (state) => {
  activity = state;
  if (state.active) {
    // While winding down (active but quiet) keep the last busy reading.
    if (state.totalBps > 0) diskSpeed.textContent = describeSpeed(state);
    if (schedulerTimer === null) {
      schedulerTimer = setInterval(scheduleClicks, SCHEDULER_INTERVAL_MS);
    }
    scheduleClicks();
  } else {
    diskSpeed.textContent = '';
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
};

bridge.onActivity(onActivity);

// Easter egg: three quick clicks on the dots dial into the 90s.
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
    indicator.style.backgroundColor = pattern[i] ? '#32CD32' : '';
  });
};

const stopDialupAnimation = () => {
  clearInterval(dialupAnimation);
  dialupAnimation = null;
  activityIndicators.forEach((indicator) => {
    indicator.style.backgroundColor = '';
  });
  setLitDots(0);
};

const startDialupAnimation = () => {
  let patternIndex = 0;
  showDialupPattern(dialupPatterns[patternIndex]);
  // Change pattern every 800 ms, roughly the pace of a real handshake.
  dialupAnimation = setInterval(() => {
    patternIndex = (patternIndex + 1) % dialupPatterns.length;
    showDialupPattern(dialupPatterns[patternIndex]);
  }, 800);
};

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
    if (!audioReady || audio.modemPlaying) return;
    // Same 0-7 scale as the Activity slider.
    if (audio.playModem(clickVolume, stopDialupAnimation)) {
      startDialupAnimation();
    }
  });
});

// Start up: decode everything once, then the spin-up clip and the ambience.
audio.resumeWhenAllowed();
audio.load().then(() => {
  audioReady = true;
  audio.playStartup();
  audio.startBackground();
  if (activity.active) scheduleClicks();
}).catch((error) => {
  console.error('Could not load sounds:', error);
  activityIndicators.forEach((indicator) => {
    indicator.style.backgroundColor = 'red';
  });
});
