# PB Man for Price Bailey events

Two-screen browser game. The big screen shows the game and a QR code. The player scans it and plays from their phone. The game can also be played on the big screen itself. Both routes show a details form first, and details go straight to HubSpot.

## Structure

```
index.html              big screen (game, QR code, big-screen form, end screen)
controller/index.html   phone controller (form, game pad, end screen)
lib/link.js             connection between the two screens (MQTT + BroadcastChannel)
lib/hubspot.js          HubSpot settings and submission, shared by both screens
lib/screen-kit.js       big-screen kit: QR code, details form, pause banner, end screen
lib/mqtt.min.js         bundled messaging library (mqtt.js 5.16.1)
lib/qrcode.js           bundled QR code library (qrcode-generator 1.5.2)
lib/react*.min.js        bundled React 18.2.0
src/game.jsx            editable game source (see below)
src/compile.mjs         recompiles the source into index.html
assets/                 logo
```

## How to play

- **Controls:** Phone: four arrow buttons (up, down, left, right). Big screen: arrow keys or the on-screen pad.
- **Scoring:** 10 per dot, 150 per service node, 500 for the R&D power up, 300 per risk caught while powered up. Win by collecting all 11 service nodes. A risk catching you ends the game.
- The end screen shows the score, a message and **New game**, with no high score. It returns to a fresh QR code after 45 seconds.

## Settings to check before an event

- `lib/hubspot.js`: `EVENT_NAME` (must be set, it is recorded against every lead), `GAME_NAME` (currently `PB Man`), `PRIVACY_URL`, consent wording.
- `lib/screen-kit.js` settings block: `FORM_IDLE_CLOSE_MS`, `END_AUTO_RESET_MS`, `CONTROLLER_TIMEOUT_MS`, `CONTROLLER_LOST_RESET_MS`.
- `index.html`: `PBScreen.init({...})` at the end of the game script holds the title copy, the phone HUD and the colour theme.
- `controller/index.html` settings block: send rate and button hold timings. Brand colours are CSS variables at the top.

## How the connection works

The big screen creates a four-character room code and shows a QR code to `controller/?room=CODE`. Both pages relay messages over `wss://broker.emqx.io:8084/mqtt` and `wss://broker.hivemq.com:8884/mqtt` together, de-duplicated by message id. Topics are `pricebailey/pb-man/ROOM/screen` and `.../controller`. BroadcastChannel is also used, so two tabs in one browser work as a desk test.

- Phone to screen: `hb`, `start`, `in` (held buttons every 150 ms plus cumulative tap counters, so repeats are harmless), `newgame`.
- Screen to phone: `hb`, `st` (state, score, pad name, HUD line, end title and message), `bye`.
- Heartbeat every 2 seconds, other side treated as gone after 6 seconds. The game pauses while the phone is away and is abandoned after 30 seconds.
- Only the first controller is accepted. Others see "Game in use".
- Add `?broker=ws://host:port` to either address to test against a local broker.

Both devices need internet. The public brokers have no uptime guarantee. For important events, move to a private broker or Firebase.

## Editing the game (React)

The game is written in React. The page runs plain compiled JavaScript, so nothing loads from a CDN and there is no Babel in the browser.

- Source: `src/game.jsx`. The compiled copy sits inline in `index.html`.
- After editing the source: `npm install @babel/core @babel/preset-react`, then `node src/compile.mjs` from the repository root. This rewrites the game script in `index.html`.
- React 18.2.0 is bundled in `lib/` (`react.production.min.js`, `react-dom.production.min.js`).

## Testing

1. Open `index.html` in one tab, then the controller address shown under the QR code in a second tab (desk test).
2. Add `&debug` to the controller address to show HubSpot's replies on the phone.
3. Play one full game on a real phone and check the test contact in HubSpot.

## Data protection

Personal details are held in memory only. They are never written to the repository or browser storage, never shown on the big screen, and are cleared when the game starts and on New game. A form left open on the big screen closes and clears after 90 seconds.

## Notes

Power up timing (8 seconds) keeps running while the phone is disconnected. The leaderboard, HI score and the old CTA links were removed.

## Blocking before a stand

- Event name set.
- Compliance approve the consent wording and privacy notice link, and `PRIVACY_URL` is filled in.
- A test contact appears in HubSpot with every field filled, including `game_form_consent` when ticked, and the game name `PB Man` is accepted.
- `price-baileymarketing-star.github.io` stays registered as a trusted domain in HubSpot. Any other host must be added too.
