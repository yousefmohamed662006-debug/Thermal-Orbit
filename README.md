# Thermal Orbit

Thermal Orbit explores satellite fire detections from MODIS and VIIRS NOAA-20 on a globe, with an observation calendar, regional analysis, wildfire stories and a map assistant.

## Run locally

1. Install Node.js 24 or later and Python 3. Verify with `node --version` and `py -3 --version` on Windows or `python3 --version` on macOS/Linux. The assistant uses `py -3` on Windows and `python3` elsewhere. Set `EMBERSCOPE_PYTHON` to a Python executable path if needed.
2. Open a terminal in this folder and run `node scripts/serve.mjs` or `npm start`. There are no npm or pip dependencies to install.
3. Open http://127.0.0.1:4173. If the port is in use, stop the other server or set `PORT` before launching. Map imagery, place search, Gemini responses and FIRMS updates require internet access.

For a GitHub checkout, configure the API keys locally if you need Gemini or NASA FIRMS updates:

- Copy `.gemini.env.example` to `.gemini.env` and enter a Google Gemini API key. The server reads it for each chat request. Local map commands and archive lookups work without a Gemini key.
- Copy `.firms.env.example` to `.firms.env` and enter a NASA FIRMS MAP_KEY. Restart the server. The server refreshes the Northern California snapshot at startup and daily at 06:00 UTC while running. The bundled global archive is served from the included monthly summaries.

The two real environment files are ignored by Git. If handing over a runnable local copy that includes these files, provide it only to authorized recipients through a private channel. Share keys separately from the GitHub repository.

## Data

- `global-data/` contains the compressed monthly map summaries and sensor coverage indexes.
- `site/fire-data.json` contains the Northern California archive and recent local observations.
- `event-data/` contains the five wildfire stories' map frames derived from NASA FIRMS observations. Event source links are in the app.
- Where the global display uses simulated estimates to fill archive gaps, the app labels those estimates. They do not enter the assistant's observed-data analysis.
- Country boundaries are from Natural Earth (1:50m Admin 0 Countries, public domain).

The project uses a Node server for its APIs. GitHub can host the source repository. A GitHub Pages deployment alone cannot run those APIs.
