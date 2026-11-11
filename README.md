# woufy 🎵

An autonomous, 100% offline iOS audio player with a Liquid Glass dark aesthetic, built with React Native and Expo SDK 58.

## ✨ Features

- **100% Offline Playback:** Scans and plays audio files (`.mp3`, `.wav`) directly from the app's local Documents folder (accessible via the iOS "Files" app).
- **Background Playback & Lock Screen:** Full lock screen controls with album artwork and iOS Now Playing info center integration.
- **In-Memory ID3 Parser:** Extracts title, artist, album art, and synchronized lyrics directly from audio tags in memory.
- **Dynamic Waveform Visualizer:** 60 FPS real-time PCM audio spectrum analyzer mask overlaid on album artwork.
- **Liquid Glass Dark UI:** Glassmorphism design with ambient neon glow, blur views, and fully rounded capsules.
- **Gesture-Driven Navigation:**
  - Swipe down on artwork to open the Queue.
  - Interactive rotary bottom slider to transition between Lyrics and Queue.
  - 1:1 finger tracking dismiss and pull-up mini-player expansion.
  - Smooth card-stack transitions.
- **DJ Crossfade & Transitions:** Configurable 1–15s track crossfade, volume fade in/out, and tempo transitions.
- **Synchronized Lyrics:** Karaoke-style scrolling lyrics with tap-to-seek functionality.

## 🚀 Getting Started

```bash
# Start development server
npx expo start -c
```
