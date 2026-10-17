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

```
browser                                                    server (authoritative)
───────                                                    ──────────────────────
getUserMedia (AEC on, AGC/NS off)                          ping/pong clock sync
  └─ AudioWorklet capture: exactly 4.000 s from the         schedules recordStartAt on its clock
     sample matching the server's start time                  │
  └─ windowed-sinc resample → 16 kHz int16 ── WebSocket ──▶ DSP pipeline → judge → round result
WebRTC peer call (video/audio) + getStats() sampler        relays WebRTC signalling
```

- **Clock sync.** Each client runs NTP-style ping/pong against the server and keeps the minimum-RTT sample (error ≤ RTT/2). The server sends one `recordStartAt` timestamp. Each client converts it to its own AudioContext time with `getOutputTimestamp()`. The capture worklet then starts on that exact sample, not whenever a main-thread timer happens to fire.
- **Authoritative scoring.** Clients upload raw 16 kHz PCM, and the server runs the analysis and judging. A modified client can't simply send itself a high score.
- **DSP pipeline** (`public/dsp/`, the same code in the browser and Node):
  - 32 ms Hann frames at a 10 ms hop, with a hand-written radix-2 FFT.
  - Spectral centroid, roll-off, flatness, tilt and zero-crossing rate.
  - 40-band log-mel spectrogram and 13 MFCCs.
  - YIN pitch tracking with parabolic refinement, plus an HNR estimate.
  - Voice-activity detection: a noise-floor estimate with hysteresis.
  - Onset detection: spectral-flux peak picking, confirmed by a rise in energy.
  - ITU-R BS.1770 loudness (K-weighting re-derived at 16 kHz and calibrated at 1 kHz; momentary and gated integrated LUFS).
- **Judge** (`public/dsp/score.js`). Each animal has weighted feature targets, each scored by a Gaussian falloff outside its range (in semitones for pitch). Tonal animals also have their pitch contour matched to a template with DTW (Sakoe–Chiba band). The formula is `score = 100 · accuracy · (0.6 + 0.3·volume + 0.1·gusto)`, and the result includes an exact breakdown of the points each term cost.
- **Match report** (`public/report.js`, `public/plot.js`). Opens after the final round, and practice rounds have one too. It shows:
  - Per-round, per-player log-mel spectrograms with f0 and onsets overlaid, and loudness / RMS tracks.
  - DTW alignment against the template, or the onset-detection curve for animals without one.
  - The judge's scoring breakdown, and MFCC heatmaps.
  - Capture diagnostics: start error, clipping, DC offset, SNR, crest factor, DSP and upload timing.
  - Clock-sync error bounds, and WebRTC stats (RTT, jitter, loss, concealment, codecs, ICE path).
  - A raw JSON export.

To add an animal, add an entry to `ANIMALS` in `public/dsp/score.js` with feature targets and, optionally, a pitch-contour template.

## Known limitations / next steps

- Scoring is server-side, but the audio itself still comes from the client. Someone could feed in a pre-recorded "perfect" bark.
- Only a public STUN server is configured. Players behind strict NATs won't connect without a TURN server (e.g. coturn).
- The thresholds in `public/dsp/score.js` are first guesses. Use Practice mode and its report to tune them on real voices.
- Without headphones, echo cancellation usually stops your opponent's bark from counting as yours, but not always.
