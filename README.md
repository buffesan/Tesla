# Model Y Sound Lab V4

Browser-based engine-sound prototype for a Tesla Model Y Performance.

## V4: real recorded V8 audio

V4 replaces the synthetic V3 engine with a real recorded V8 sample bank.

The source recording is:

- **“Maserati GranTurismo S Exhaust”**
- Author: **lmartins**
- Source: https://commons.wikimedia.org/wiki/File:Maserati_GranTurismo_S_Exhaust.ogg
- License: **Creative Commons Attribution 4.0 International (CC BY 4.0)**
- License text: https://creativecommons.org/licenses/by/4.0/

The source recording is modified for this project: analyzed, cut into RPM regions, normalized, looped and dynamically pitch-shifted/crossfaded in the browser.

No Maserati logo or endorsement is implied.

## Audio architecture

- four automatically extracted real-engine RPM loops
- crossfade between neighboring RPM ranges
- playback-rate tracking for simulated RPM
- load-dependent filtering and gain
- shift cut between simulated gears
- iOS `navigator.audioSession = playback` support where available

## Run locally

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080`.

## Tesla use

The repository is deployed through GitHub Pages. Open the HTTPS page in the Tesla browser, press **START ENGINE**, then **GPS STARTEN** and allow location access.

## Notes

- GPS speed depends on browser/device support and update rate.
- Audio begins only after a user gesture because of browser autoplay restrictions.
- This is a simulation. It does not read Tesla CAN data or accelerator-pedal position.
