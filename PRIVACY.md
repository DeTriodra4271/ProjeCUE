# Cue privacy notice

Cue is a Windows app for watching one video in sync with friends. This page says what data exists, where it goes, and who can see it. The same points appear in the app under "About and privacy".

## What Cue does not do

- There are no accounts and no sign-in.
- Cue has no analytics, tracking or advertising, and it sends nothing about you to the people who make it.

## What is stored on your PC

Your nickname, language, accent color, the last room name and description you typed, whether you accepted the voice and camera notices, and the volume you set for each person (by nickname) are stored locally by the app. Nothing else is saved. Uninstalling Cue does not delete them. To remove them, delete the `ProjeSun` folder inside `%APPDATA%` (that is Cue's internal name).

## Rooms, chat and sync

- A room is hosted by one person's computer. Chat messages, nicknames and the playback position of the video pass through that computer and through a tunnel from Cloudflare, Inc.
- **The host can see every message in their room.** Cloudflare's tunnel also carries the traffic. Nothing is end-to-end encrypted, so do not write anything private in the chat.
- A tunnel ends its encryption at Cloudflare's servers, so Cloudflare can technically see the traffic that passes through it.
- Removing someone from a room blocks their internet address from rejoining that room until the room closes. Cue does not show addresses in its interface, but the host's copy of Cue does receive them: it keeps a removed person's address in memory only until the room closes. People who join over the same local network connect directly, and the host's computer sees their local address.

## Voice chat and camera

Voice chat and camera exist only in rooms where the host switched them on. Voice starts only after you press "Join voice" and accept a notice. The camera is a separate step: you must already be in voice, and you accept a second notice the first time.

- Voice and video do not pass through the host or the server. They flow directly between the people in voice (peer to peer, encrypted in transit).
- **Everyone in voice can see each other's internet address.** This is the price of a direct connection, and it is why the host chooses per room whether voice and camera are allowed. The tunnel that hides addresses in chat does not apply to voice or video.
- **If you turn your camera on, everyone in voice sees your video.** Anyone can hide your video on their own screen, and the host can switch your camera off.
- Each person can set the volume of every other person from silent to 200%, and hide their video. These settings apply only on their own computer. Volume settings are stored on your PC under the other person's nickname.
- To set up the connection Cue contacts the public STUN servers of Cloudflare and Google. These learn that your address is trying to connect, and nothing else.
- Cue does not record or store audio or video. Your microphone is only opened while you are in voice, and your camera only while it is switched on. Both are released when you leave voice, are removed, or quit.
- Use headphones. Without them the film plays out of your speakers into your microphone and everyone hears it twice.

## Public rooms

When a host makes a room public, the room name, description, the host's nickname, the number of people and the tunnel address are published to public MQTT servers (hivemq.com, emqx.io and mosquitto.org) so other copies of Cue can list the room. **Anyone on the internet can read this information.** Private rooms are never published. The entry is removed when the room closes.

## The sites you watch

The host opens a video website inside Cue. That site runs in its own window with its own cookies, separate from the app. Sites see you the way they see any web browser. Guests only follow web addresses that start with `http` or `https`, and the address of the current site is always shown to them.

## Third parties

| Service | Used for | Their policy |
|---|---|---|
| Cloudflare (quick tunnels) | Letting friends reach the host without changing the router | cloudflare.com/privacypolicy |
| Cloudflare and Google public STUN servers | Setting up voice connections between people | Each operator's own policy |
| HiveMQ, EMQX, Mosquitto public MQTT servers | The public room list | Each operator's own policy |

Cloudflare's free quick tunnels are offered for testing and development. They can change or stop working without notice.

## Children

Cue is not directed at children. Public rooms can contain strangers.

## Contact

- Email: detriodra42@gmail.com
- Discord: mrfox42
