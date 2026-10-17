# 🐶 Barkoff

Omegle, but you bark at each other. Get paired with a random stranger over video, and each round the game picks an animal. When the countdown hits GO you both make the sound at once, and whoever is loudest and most convincing wins. Best of 3, with sudden death on a tie.

## Run it

```sh
npm install
npm start
# open http://localhost:3000
```

To try a match on your own, open two **separate browser windows** side by side (not tabs) and click "Find someone to bark at" in each. "Practice solo" lets you test scoring by yourself.

Browsers only allow the mic on `localhost` or HTTPS. To play with friends elsewhere, put the server behind an HTTPS tunnel, e.g. `npx cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`.

## Put it online

**Permanent (free):** the repo has a `render.yaml`. Go to <https://dashboard.render.com/blueprints>, choose **New Blueprint Instance**, connect this GitHub repo, and click **Apply**. You get a link like `https://barkoff.onrender.com`. On the free plan the server sleeps after 15 minutes idle, so the first visit after that takes about 30 seconds to load.

**Instant, from your laptop:** `npm start`, then in another terminal run `npx cloudflared tunnel --url http://localhost:3000`. Share the `https://….trycloudflare.com` link it prints. It works only while both commands keep running.

## How it works

- **`server.js`**: static file server + WebSocket. It keeps a one-person queue for matchmaking, relays WebRTC offers/answers/ICE candidates between the two players, and runs the match: it picks the animal, times the rounds, collects both scores, and decides each round.
- **`public/app.js`**: UI, camera/mic, the peer-to-peer WebRTC call, and live spectrograms for both players.
- **`public/scoring.js`**: the judge. During the 4-second window it samples the mic about every 21 ms and extracts:
  - loudness (dBFS), attack (how sharply sounds start), number of separate bursts, active time
  - pitch (autocorrelation), pitch glide range, how much of the sound is tonal
  - spectral centroid (brightness) and flatness (noisiness/growl)

  Each animal sets target ranges for some of these features (a dog = several short, punchy bursts; a cow = a low, steady, long tone; a wolf = one long gliding howl; and so on). **Accuracy** is how well you hit those targets. Final score = `accuracy × (60% + 30% volume + 10% gusto)`, so screaming the wrong animal won't win.
- **`public/tick-worklet.js`**: an audio-thread clock, so sampling keeps working even when the tab is in the background.

To add an animal, add an entry to `ANIMALS` in `public/scoring.js` and its id to `ANIMALS` in `server.js`.

## Known limitations / next steps

- **Scores are computed in the browser and trusted by the server**, so anyone can cheat with devtools. The fix is to send the raw features (or audio) to the server and score them there.
- Only a public STUN server is configured. Players behind strict NATs won't connect without a TURN server (e.g. coturn).
- The thresholds in `scoring.js` are first guesses. Use Practice mode with the devtools console open (features are logged via `console.debug`) to tune them on real voices.
- Without headphones, echo cancellation usually stops your opponent's bark from counting as yours, but not always.
