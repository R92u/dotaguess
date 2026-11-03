const STORAGE_KEY = 'dotaguess-audio-v1';
const defaults = { volume: 1, muted: false, playbackRate: 1 };

function readSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return {
      volume: Number.isFinite(saved?.volume) && saved.volume >= 0 && saved.volume <= 1
        ? saved.volume : defaults.volume,
      muted: typeof saved?.muted === 'boolean' ? saved.muted : defaults.muted,
      playbackRate: Number.isFinite(saved?.playbackRate) && saved.playbackRate >= 0.0625 && saved.playbackRate <= 16
        ? saved.playbackRate : defaults.playbackRate,
    };
  } catch {
    return { ...defaults };
  }
}

let settings = readSettings();

export function attachAudioSettings(audio) {
  audio.volume = settings.volume;
  audio.muted = settings.muted;
  audio.playbackRate = settings.playbackRate;
  audio.defaultPlaybackRate = settings.playbackRate;

  function save() {
    settings = {
      volume: audio.volume,
      muted: audio.muted,
      playbackRate: audio.playbackRate,
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Keep preferences for this session when browser storage is unavailable.
    }
  }

  audio.addEventListener('volumechange', save);
  audio.addEventListener('ratechange', save);
}
