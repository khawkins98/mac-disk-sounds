const { ipcRenderer, shell } = require('electron');
const { Howl, Howler } = require('howler');

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
    startup: [2000, 11000] // 9 second clip starting after the 2s trim
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
const activityIndicator = document.getElementById('activity-indicator');
const testButton = document.getElementById('test-sound');

// Current sound set
let currentSoundSet = 'ibm';
let currentSoundId = null;
let baseVolume = 0.5; // Store base volume level
let backgroundBaseVolume = 0.2; // Store background volume level

// Update volume display and all sound volumes
volumeSlider.addEventListener('input', (e) => {
  const volume = e.target.value;
  volumeValue.textContent = volume;
  baseVolume = volume / 100;
});

// Update background volume
backgroundVolumeSlider.addEventListener('input', (e) => {
  const volume = e.target.value;
  backgroundVolumeValue.textContent = volume;
  backgroundBaseVolume = volume / 100;
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

  // Show activity indicator
  activityIndicator.classList.add('active');

  // Get the duration from the sprite configuration
  const duration = sound._sprite[randomSprite][1] - sound._sprite[randomSprite][0];

  setTimeout(() => {
    if (currentSoundId !== null) {
      sound.fade(baseVolume, 0, 10, currentSoundId);
    }
  }, duration - 10);

  // Reset indicator and cleanup
  setTimeout(() => {
    activityIndicator.classList.remove('active');
    currentSoundId = null;
  }, duration);
};

// Handle test button click
testButton.addEventListener('click', () => {
  console.log('Test button clicked');
  playSound();
});

// Handle disk activity
let isPlaying = false;
ipcRenderer.on('disk-activity', () => {
  console.log('Disk activity detected');
  if (!isPlaying) {
    isPlaying = true;
    playSound();
    const duration = currentSoundSet === 'ibm' ? 300 : 200;
    setTimeout(() => {
      isPlaying = false;
    }, duration);
  }
});

let clickCount = 0;
let clickTimer = null;

activityIndicator.addEventListener('click', () => {
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
      onloaderror: (id, error) => {
        console.error('Error loading modem sound:', error);
        // Show error in UI or fallback behavior
        activityIndicator.style.backgroundColor = 'red';
        setTimeout(() => {
          activityIndicator.style.backgroundColor = '';
        }, 1000);
      },
      onend: () => {
        console.log('📞 Modem connection terminated');
      }
    });

    // Flash the activity indicator rapidly
    let flashCount = 0;
    const flashInterval = setInterval(() => {
      activityIndicator.style.backgroundColor = flashCount % 2 ? '#32CD32' : '#333';
      flashCount++;
      if (flashCount > 10) {
        clearInterval(flashInterval);
        activityIndicator.style.backgroundColor = '#333';
        console.log('✨ Welcome to the information superhighway!');
      }
    }, 100);

    modemSound.play();
  }
});