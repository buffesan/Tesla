# Model Y Sound Lab V3

Static browser prototype for a Tesla Model Y Performance-style engine sound.

## V3 audio engine

V3 replaces the simple oscillator-based V8 with a multi-layer loop-bank engine:

- four RPM anchor banks (idle / mid / pull / high)
- separate cruise and load loops
- continuous crossfading between RPM ranges
- playback-rate tracking for simulated RPM
- intake-noise layer
- short exhaust impulse response for body/resonance
- shift cut + exhaust pop
- overrun crackle
- iOS `navigator.audioSession = playback` support when available

The loop material is generated locally in the browser; no third-party engine recordings are included.

## Run locally

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080`.

## Tesla use

Deploy over HTTPS (GitHub Pages is enabled for this repository), open the site in the Tesla browser, press **START ENGINE**, then **GPS STARTEN** and allow location access.

## Notes

- GPS speed depends on browser/device support and update rate.
- Audio begins only after a user gesture because of browser autoplay restrictions.
- This is a simulation. It does not read Tesla vehicle CAN data or accelerator-pedal position.
