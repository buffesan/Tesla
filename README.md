# Model Y Sound Lab V1

Static browser prototype for a Tesla Model Y Performance-style synthetic engine sound.

## Run locally

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080`.

## Tesla use

Deploy the folder to any HTTPS host (GitHub Pages, Cloudflare Pages, Netlify, Vercel, Azure Static Web Apps, etc.).
Open the HTTPS URL in the Tesla browser, press **START ENGINE**, then **GPS STARTEN** and allow location access.

## Notes

- GPS speed depends on browser/device support and update rate.
- Audio begins only after a user gesture because of browser autoplay restrictions.
- The V8 is synthesized with the Web Audio API; no third-party engine recordings are included.
