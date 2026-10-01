const { ipcRenderer, shell } = require('electron');
const { Howl, Howler } = require('howler');

// Window focus handling
const mainWindow = document.getElementById('main-window');

// Listen for window focus/blur events
ipcRenderer.on('window-focus-change', (event, isFocused) => {
  if (isFocused) {
    mainWindow.classList.remove('inactive');
  } else {
    mainWindow.classList.add('inactive');
  }
});

// Window controls
document.querySelector('button[aria-label="Close"]').addEventListener('click', () => {
  ipcRenderer.send('window-control', 'close');
});

document.querySelector('button[aria-label="Resize"]').addEventListener('click', () => {
  ipcRenderer.send('window-control', 'minimize');
});

// Handle external links
document.addEventListener('click', (event) => {
  if (event.target.tagName === 'A' && event.target.href.startsWith('http')) {
    event.preventDefault();
    shell.openExternal(event.target.href);
  }
});

// Howler sprites are [offset, duration] in milliseconds, not [start, end].

// Background loop sound configuration
const backgroundSound = new Howl({
  src: ['sounds/hard-disk-drive-ibm-1999-48823.mp3'],
  volume: 0,
  sprite: {
    loop: [110000, 20000], // 1:50 to 2:10 of a 2:36 file
  },
  loop: true,
  onload: () => {
    console.log('Background loop loaded');
    const id = backgroundSound.play('loop');
    backgroundSound.fade(0, 0.2, 1000, id); // Fade in to 20% volume
  }
});

// Startup sound configuration
const startupSound = new Howl({
  src: ['sounds/hard-disk-drive-ibm-1999-48823.mp3'],
  volume: 0,
  sprite: {
    startup: [3000, 9000] // 0:03 to 0:12, a 9 second clip
  },
  onload: () => {
    console.log('Startup sound loaded');
    // Play startup sound with fade in/out
    const id = startupSound.play('startup');
    startupSound.fade(0, 0.3, 1000, id); // Fade in over 1 second

    // Fade out near the end
    setTimeout(() => {
      startupSound.fade(0.3, 0, 1000, id);
    }, 8000); // Start fade out 1 second before end
  }
});

// Helper function to create `count` random click sprites of `segmentLength`
// ms, each starting at or after `trimStart` and ending by `windowEnd` (ms).
function createSpriteRanges(windowEnd, segmentLength, count, trimStart = 0) {
  const sprites = {};
  const maxOffset = windowEnd - trimStart - segmentLength;

  for (let i = 0; i < count; i++) {
    const start = trimStart + Math.floor(Math.random() * maxOffset);
    sprites[`click${i}`] = [start, segmentLength];
  }
  return sprites;
}

// Our own copy of each click sprite map, so playback does not depend on
// Howler's private _sprite field.
const ibmSprites = createSpriteRanges(100000, 300, 8, 2000); // 0:02 to 1:40 of 2:36
const genericSprites = createSpriteRanges(40000, 300, 8, 1000); // 0:01 to 0:40 of 0:42

// Sound sets configuration
const soundSets = {
  ibm: {
    sprites: ibmSprites,
    read: new Howl({
      src: ['sounds/hard-disk-drive-ibm-1999-48823.mp3'],
      volume: 0,  // Start at 0 volume for fading
      sprite: ibmSprites,
      onload: () => {
        console.log('IBM sound loaded successfully');
      },
      onloaderror: (id, error) => {
        console.error('Error loading IBM sound:', error);
      },
      onplayerror: (id, error) => {
        console.error('Error playing IBM sound:', error);
      }
    })
  },
  generic: {
    sprites: genericSprites,
    read: new Howl({
      src: ['sounds/computer-hard-drive-access-fan-click-62422.mp3'],
      volume: 0,  // Start at 0 volume for fading
      sprite: genericSprites,
      onload: () => {
        console.log('Generic sound loaded successfully');
      },
      onloaderror: (id, error) => {
        console.error('Error loading generic sound:', error);
      },
      onplayerror: (id, error) => {
        console.error('Error playing generic sound:', error);
      }
    })
  }
};

// UI elements
const volumeSlider = document.getElementById('volume');
const volumeValue = document.getElementById('volume-value');
const backgroundVolumeSlider = document.getElementById('background-volume');
const backgroundVolumeValue = document.getElementById('background-volume-value');
const soundSetSelect = document.getElementById('sound-set');
const activityIndicators = Array.from({ length: 5 }, (_, i) => document.getElementById(`activity-indicator-${i + 1}`));
const diskSpeed = document.getElementById('disk-speed');

// Current sound set
let currentSoundSet = 'generic';
let currentSoundId = null;
let baseVolume = 0.5; // Store base volume level
let backgroundBaseVolume = 0.2; // Store background volume level

// Update volume display and all sound volumes
volumeSlider.addEventListener('input', (e) => {
  const volumeLevel = parseInt(e.target.value);
  volumeValue.textContent = volumeLevel;
  // Convert 0-7 scale to 0-1 for Howler
  baseVolume = volumeLevel / 7;
});

// Update background volume
backgroundVolumeSlider.addEventListener('input', (e) => {
  const volumeLevel = parseInt(e.target.value);
  backgroundVolumeValue.textContent = volumeLevel;
  // Convert 0-7 scale to 0-1 for Howler
  backgroundBaseVolume = volumeLevel / 7;
  backgroundSound.volume(backgroundBaseVolume);
});

// Handle sound set selection
soundSetSelect.addEventListener('change', (e) => {
  currentSoundSet = e.target.value;
  console.log('Switched to sound set:', currentSoundSet);

  // Stop any playing sounds
  Object.values(soundSets).forEach(set => {
    set.read.stop();
  });
});

// Function to update activity indicators based on disk activity level
const updateActivityIndicators = (level) => {
  // level should be between 0 and 1
  const dotsToLight = Math.ceil(level * 5);
  activityIndicators.forEach((indicator, index) => {
    if (index < dotsToLight) {
      indicator.classList.add('active');
    } else {
      // Add small delay before removing active class
      setTimeout(() => {
        indicator.classList.remove('active');
      }, 100); // 100ms delay
    }
  });
};

// Function to play sound and show indicator
const playSound = () => {
  const { read: sound, sprites } = soundSets[currentSoundSet];

  // Still decoding at startup; skip this click rather than queue it.
  if (sound.state() !== 'loaded') return;

  // Stop any currently playing sound
  if (currentSoundId !== null) {
    sound.fade(baseVolume, 0, 10, currentSoundId);
    sound.stop(currentSoundId);
  }

  // Randomly select a sprite
  const spriteKeys = Object.keys(sprites);
  const randomSprite = spriteKeys[Math.floor(Math.random() * spriteKeys.length)];

  // Play the random sprite with fade in/out
  currentSoundId = sound.play(randomSprite);
  sound.fade(0, baseVolume, 10, currentSoundId); // Fade in

  // Show random activity level
  const activityLevel = Math.random() * 0.6 + 0.4; // Random level between 0.4 and 1.0
  updateActivityIndicators(activityLevel);

  // Sprites are [offset, duration]
  const duration = sprites[randomSprite][1];

  setTimeout(() => {
    if (currentSoundId !== null) {
      sound.fade(baseVolume, 0, 10, currentSoundId);
    }
  }, duration - 10);

  // Reset indicators and cleanup
  setTimeout(() => {
    updateActivityIndicators(0);
    currentSoundId = null;
  }, duration);
};

// Handle test button click
// testButton.addEventListener('click', () => {
//   console.log('Test button clicked');
//   playSound();
// });

// Function to format bytes to human readable
const formatBytes = (bytes) => {
  if (bytes === 0) return '0 B/s';
  const k = 1024;
  const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
};

// Combined read+write throughput below which the disk counts as idle.
// Background housekeeping (logs, caches) rarely exceeds this, so an idle
// machine stays silent.
const ACTIVITY_THRESHOLD_BPS = 64 * 1024;

// Handle disk activity
let isPlaying = false;
ipcRenderer.on('disk-activity', (event, data) => {
  const readBps = data?.readBps ?? 0;
  const writeBps = data?.writeBps ?? 0;
  const speed = readBps + writeBps;

  // Silence means silence: no click unless the disk is actually busy.
  if (speed < ACTIVITY_THRESHOLD_BPS) return;

  const type = readBps >= writeBps ? 'read' : 'write';

  // Update speed display
  diskSpeed.textContent = `${type} ${formatBytes(speed)}`;

  if (!isPlaying) {
    isPlaying = true;
    playSound();

    // Calculate activity level based on speed
    const maxSpeed = .1 * 1024 * 1024 * 1024; // 100MB/s in bytes
    const activityLevel = Math.min(speed / maxSpeed + 0.2, 1);
    updateActivityIndicators(activityLevel);

    const duration = currentSoundSet === 'generic' ? 300 : 200;
    setTimeout(() => {
      isPlaying = false;
      // Don't clear the speed display immediately
      setTimeout(() => {
        if (!isPlaying) {
          diskSpeed.textContent = '';
          updateActivityIndicators(0);
        }
      }, 1000);
    }, duration);
  }
});

// Easter egg: the dial-up modem sound, created once and reused
const resetIndicatorColours = () => {
  activityIndicators.forEach(ind => {
    ind.classList.remove('active');
    ind.style.backgroundColor = '';
  });
};

let dialupAnimation = null;
const modemSound = new Howl({
  src: ['sounds/the-sound-of-dial-up-internet-6240.mp3'],
  preload: true,
  html5: true,
  onplay: () => {
    // Start the dialup animation
    dialupAnimation = animateDialup();
  },
  onend: () => {
    clearInterval(dialupAnimation);
    dialupAnimation = null;
    resetIndicatorColours();
    console.log('📞 Modem connection terminated');
  },
  onloaderror: (id, error) => {
    console.error('Error loading modem sound:', error);
    // Show error in UI
    activityIndicators.forEach(ind => {
      ind.style.backgroundColor = 'red';
      setTimeout(() => {
        ind.style.backgroundColor = '';
      }, 1000);
    });
  },
  onplayerror: (id, error) => {
    console.error('Error playing modem sound:', error);
  }
});

let clickCount = 0;
let clickTimer = null;

// Update click handler for all indicators
activityIndicators.forEach(indicator => {
  indicator.addEventListener('click', () => {
    clickCount++;

    // Reset click count after 1 second of no clicks
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => {
      clickCount = 0;
    }, 1000);

    // Easter egg: After 3 quick clicks
    if (clickCount === 3) {
      clickCount = 0;
      clearTimeout(clickTimer);

      // Already connecting; don't stack a second copy
      if (modemSound.playing()) return;

      console.log('🎵 Easter egg activated: Dialing into the 90s...');
      // Same 0-7 scale as the Activity slider
      modemSound.volume(volumeSlider.value / 7);
      modemSound.play();
    }
  });
});

// Function to animate lights during dialup
const animateDialup = () => {
  const patterns = [
    [1,0,0,0,0], // Initial connection
    [1,1,0,0,0], // Handshake start
    [1,1,1,0,0], // Negotiating
    [0,1,1,1,0], // Synchronizing
    [0,0,1,1,1], // Almost there
    [1,0,1,0,1], // Final handshake
    [1,1,1,1,1], // Connected!
  ];

  let patternIndex = 0;
  const interval = setInterval(() => {
    // Update indicators based on current pattern
    activityIndicators.forEach((indicator, i) => {
      if (patterns[patternIndex][i]) {
        indicator.classList.add('active');
        indicator.style.backgroundColor = '#32CD32';
      } else {
        indicator.classList.remove('active');
        indicator.style.backgroundColor = '';
      }
    });

    patternIndex = (patternIndex + 1) % patterns.length;
  }, 800); // Change pattern every 800ms to match typical dialup timing

  return interval;
};