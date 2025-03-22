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

// Background loop sound configuration
const backgroundSound = new Howl({
  src: ['sounds/hard-disk-drive-ibm-1999-48823.mp3'],
  volume: 0,
  sprite: {
    loop: [110000, 130000], // 1:50 to 2:10 (in milliseconds)
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
    startup: [3000, 11000] // 9 second clip starting after the 2s trim
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

// Helper function to create sprite ranges
function createSpriteRanges(duration, segmentLength, count, trimStart = 0) {
  const sprites = {};
  const usableDuration = duration - trimStart;

  for (let i = 0; i < count; i++) {
    // Ensure we don't start before trimStart and have enough room for the segment
    const maxStart = usableDuration - segmentLength;
    const randomOffset = Math.floor(Math.random() * maxStart);
    const start = trimStart + randomOffset;
    sprites[`click${i}`] = [start, start + segmentLength];
  }
  return sprites;
}

// Sound sets configuration
const soundSets = {
  ibm: {
    read: new Howl({
      src: ['sounds/hard-disk-drive-ibm-1999-48823.mp3'],
      volume: 0,  // Start at 0 volume for fading
      sprite: createSpriteRanges(100000, 300, 8, 2000), // Skip first 2 seconds, 300ms segments
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
    read: new Howl({
      src: ['sounds/computer-hard-drive-access-fan-click-62422.mp3'],
      volume: 0,  // Start at 0 volume for fading
      sprite: createSpriteRanges(40000, 300, 8, 1000), // Skip first second, X00ms segments
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
    Object.values(set).forEach(sound => {
      sound.stop();
    });
  });
});

// Function to update activity indicators based on disk activity level
const updateActivityIndicators = (level) => {
  // level should be between 0 and 1
  const dotsToLight = Math.ceil(level * 5);
  console.log('Dots to light:', dotsToLight, level);
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
  const sound = soundSets[currentSoundSet].read;
  console.log('Attempting to play sound from set:', currentSoundSet);

  if (sound.state() !== 'loaded') {
    console.error('Sound not loaded yet!');
    return;
  }

  // Stop any currently playing sound
  if (currentSoundId !== null) {
    sound.fade(baseVolume, 0, 10, currentSoundId);
    sound.stop(currentSoundId);
  }

  // Randomly select a sprite
  const spriteKeys = Object.keys(sound._sprite);
  const randomSprite = spriteKeys[Math.floor(Math.random() * spriteKeys.length)];

  // Play the random sprite with fade in/out
  currentSoundId = sound.play(randomSprite);
  sound.fade(0, baseVolume, 10, currentSoundId); // Fade in

  console.log('Sound playback triggered:', randomSprite);

  // Show random activity level
  const activityLevel = Math.random() * 0.6 + 0.4; // Random level between 0.4 and 1.0
  updateActivityIndicators(activityLevel);

  // Get the duration from the sprite configuration
  const duration = sound._sprite[randomSprite][1] - sound._sprite[randomSprite][0];

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

// Handle disk activity
let isPlaying = false;
ipcRenderer.on('disk-activity', (event, data) => {
  console.log('Disk activity detected:', data, event);
  // Default to read operation if type not specified
  const type = data?.type || 'read';
  // Default to a moderate speed if not specified
  const speed = data?.speed || 11; // 512KB/s default

  console.log('Disk activity detected:', type, speed);

  // Update speed display
  const speedText = formatBytes(speed);
  diskSpeed.textContent = `${type === 'read' ? 'write' : 'read'} ${speedText}`;

  if (!isPlaying) {
    isPlaying = true;
    playSound();

    // Calculate activity level based on speed
    // Assuming typical SSD speeds max around 2GB/s
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

let clickCount = 0;
let clickTimer = null;

// Update click handler for all indicators
activityIndicators.forEach(indicator => {
  indicator.addEventListener('click', () => {
    clickCount++;

    console.log('🎮 Activity indicator clicked:', clickCount, 'times');

    // Reset click count after 1 second of no clicks
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => {
      clickCount = 0;
    }, 1000);

    // Easter egg: After 3 quick clicks
    if (clickCount === 3) {
      clickCount = 0;
      clearTimeout(clickTimer);

      console.log('🎵 Easter egg activated: Dialing into the 90s...');
      // Play the dial-up modem sound
      const modemSound = new Howl({
        src: ['sounds/the-sound-of-dial-up-internet-6240.mp3'],
        volume: volumeSlider.value / 100,
        preload: true,
        html5: true,
        onload: () => {
          console.log('Modem sound loaded');
        },
        onplay: () => {
          // Start the dialup animation
          const animation = animateDialup();

          // Stop the animation when the sound ends
          modemSound.once('end', () => {
            clearInterval(animation);
            // Reset all indicators
            activityIndicators.forEach(ind => {
              ind.classList.remove('active');
              ind.style.backgroundColor = '';
            });
            console.log('📞 Modem connection terminated');
          });
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
        }
      });

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
  const dialupAnimation = setInterval(() => {
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

  return dialupAnimation;
};