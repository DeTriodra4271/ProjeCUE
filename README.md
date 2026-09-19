# Cue

Watch one video in sync with friends, on Windows. One person hosts and opens any video website; everyone else joins and sees the same moment, with live chat, optional voice and camera, and small-room moderation. No accounts, no port forwarding.

Cue is an Electron app. Every copy can host: it starts a small room server on the host's PC and opens a free Cloudflare quick tunnel so friends can reach it.

## What it does

- **Sync:** the host's play, pause and seek reach guests in about 50 ms on a local link. Guests keep their own clock and only correct when they drift more than 1 second, first by gently changing playback speed and only for large gaps by seeking, so the video does not rebuffer.
- **Works across sites:** it finds the real player even inside iframes from other sites or shadow DOM, and ignores small ad videos.
- **Rooms:** public rooms appear in a live list without typing a code; private rooms use a short room code or a full invite. The host can mute, remove and block people. Anyone can hide a person's messages or video for themselves.
- **Voice and camera:** optional per room, peer to peer, with a per-person volume from 0 to 200%. Everyone in voice can see each other's internet address, so the host decides per room and there is a notice before anyone joins. See [PRIVACY.md](PRIVACY.md).
- **Five languages:** Türkçe, English, Español, Français, Deutsch.

## Run it

Needs Windows and Node.js.

```
npm install
npm run setup      # downloads cloudflared.exe (checked for Cloudflare's signature) and generates the license notices
npm start
```

## Build

```
npm run release            # installer + portable exe in release/  (unsigned is allowed)
npm run release:signed     # same, but fails unless every exe is validly signed
```

See [RELEASE.md](RELEASE.md) for signing options and what to do before a public release.

## Project layout

| Path | What it is |
|---|---|
| `main.js` | Electron main process: window, room server startup, tunnel, permissions |
| `roomServer.js` | Room server logic (rooms, chat, moderation, voice signalling), also usable standalone via `server.js` |
| `directory.js` | Public room list over public MQTT brokers |
| `public/` | The app UI (`index.html`, `app.css`, `app.js`, `i18n.js`) and the Archivo font |
| `scripts/` | Release, notices and tunnel-download scripts |

## Status and limits

- **Tests are not in this repository yet.** The app was verified with a large set of scripted end-to-end tests that still live outside the repo.
- **Unsigned by default.** Windows shows a SmartScreen warning until a signing certificate is set up.
- **Free third-party services.** The tunnel (Cloudflare quick tunnels) and the public room list (public MQTT servers) are free with no guarantee.
- **Voice and camera** connect directly between people, and roughly 1 in 5 pairs may fail to connect on strict networks until a relay server exists.
- **License:** not chosen yet.
