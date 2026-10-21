# Face Worms

A multiplayer worm game for Android: every player's face is on their worm's head.

- **Internet games**: one player creates a room and shares the 4-digit code.
- **Hotspot games** (no internet): the host turns on their phone's hotspot, friends connect to it and join.
- 2–10 players, 2/5/10-minute rounds, worms come back 3 seconds after dying, computer worms fill empty seats.

## Download

The latest APK is built automatically on every push:
**Releases → latest → FaceWorms.apk**

## Folders

- `client/` — the game (one HTML file). Runs in the Android app and in any browser.
- `android/` — the Android app: a WebView around the game, plus a small WebSocket server for hotspot games.
- `server/` — the room server for internet games (Node, no dependencies). Deploy on Render with `render.yaml`.

The relay address used by the game is set at the top of `client/index.html` (`RELAY_URL`).
