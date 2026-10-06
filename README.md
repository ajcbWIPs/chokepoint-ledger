# Chokepoint Ledger

Interactive map of global energy, fertiliser, food and metal supply lines, built around the 2026 Strait of Hormuz closure, plus a free pipeline that turns the dashboard into YouTube videos and Shorts.

```
index.html            dashboard (static, no build step)
soil.html             Soil Resilience Planner (country or farm context -> ranked strategies)
data/soil.js          soil methods, system-level moves and country defaults
assets/               app.js, style.css, self-hosted fonts, vendored D3 + topojson
data/data.js          EVERY number in the dashboard lives here
data/world.js         world map geometry (Natural Earth 110m)
video/                video pipeline (episodes, renderer, Shorts clipper, uploader)
.github/workflows/    Pages deploy + video render on GitHub Actions
```

## 1. Put the dashboard on GitHub Pages

1. Create a public repo called `commodity-flows` and push this folder to `main`.
2. Repo Settings > Pages > Source: **GitHub Actions**.
3. The `Refresh data feed and deploy to GitHub Pages` workflow runs on every push and once a day. The site appears at `https://<username>.github.io/commodity-flows/`.

To test locally: `python -m http.server` in this folder, then open `http://localhost:8000`. Opening `index.html` directly also works because the data is loaded as scripts, not fetched.

### What the dashboard does

| Part | What it shows |
|---|---|
| Map layers | Crude production, refinery capacity, consumption, refining balance (capacity minus use), output shut in now, soil fertility index, food input vulnerability |
| Supply lines | 39 lanes across crude, diesel, LNG, urea, sulphur, phosphate, potash, wheat, maize, soy, rice, copper, nickel, rare earths and helium. Colour = vulnerability, width = share of world trade |
| Chokepoints | Status and risk for Hormuz, Bab el-Mandeb, Suez, Malacca, Turkish Straits, Black Sea, Panama, Danish Straits, Taiwan Strait, Cape, Yanbu bypass |
| Scenario slider | Reopens Hormuz from 0 to 100% and recomputes every score |
| Constraint ranking | 16 commodities scored on 7 factors with adjustable weights. Ghost tick = score after a full reopening, which separates transient from structural shortages |
| Staple crops | Which staple is most sensitive to input supply (rice, then maize, wheat, soybeans) on seven factors, the rice input chain from gas feedstock to paddy with the binding bottleneck flagged, and a timing chart of which crops bought fertiliser at the 2026 price peak (driven by the live World Bank feed) |
| Soil without fertiliser | 15 proven methods (chinampas, waru waru, legume rotations, milpa intercrops, soy inoculants, Azolla, rice-fish, fertiliser trees, push-pull, zai pits, manure loops, night soil, biochar, conservation agriculture, microdosing) with evidence, limits and a nutrient mass balance showing why nitrogen can be fixed but phosphorus and potassium must be recycled. Origins can be shown on the map. Also covers turning marginal land productive (salt-affected, sodic, ultramafic, tailings, acid sulfate, sand, eroded slopes, wetland edges) with staged pathways, halophytes and hyperaccumulators, agromining value at the live nickel price, and 13 restoration projects with measured results (Loess Plateau, Niger FMNR, Tigray, Great Green Wall, Kubuqi, Al Baydha, India sodic reclamation, WA saltland, ICBA Salicornia, Sundrop, Albania and Sabah agromining, salt-tolerant potatoes) |
| Spot vs producers | Why spot prices and producer earnings diverge, commodity by commodity |
| Refining balance | Who can refine more than they burn |

### Scoring

* **Lane vulnerability** = weighted mean of highest chokepoint risk on the lane, supplier concentration, 1 minus substitutability, stock thinness `max(0, 1 - cover_days/180)`, and share of flow stopped now.
* **Commodity constraint** = weighted mean of chokepoint exposure, exporter concentration, supply lead time, inventory thinness, policy risk, demand inelasticity and current stress. Reopening scales chokepoint exposure by `(1 - s*hz)` and current stress by `(1 - 0.6*s*hz)`, where `hz` is the Hormuz-driven share of that commodity's stress.
* **Food input vulnerability** = `0.4*(1 - soil/100) + 0.3*fertiliser import share + 0.3*share of fertiliser imports via Hormuz`.

Flags marked `EST` are model estimates. Country oil balances are approximate pre-war values. Soil and fertiliser dependence figures are teaching composites, replace them with ISRIC SoilGrids and FAOSTAT if you want publication grade numbers. Sources are listed in the dashboard and in `data/data.js`.

### Soil Resilience Planner

`soil.html` ranks the methods for a country or a custom farm (climate, crop, water, farm size, livestock, soil problems), splits them into this season, 1 to 3 years and 5+ years, checks which nutrients the plan leaves uncovered, and lists system-level moves triggered by the country's fertiliser import and Hormuz exposure. It also takes a land type (ordinary cropland or one of eight marginal land types), shows the conversion pathway first and matches restoration projects. Link straight to a country with its ISO numeric code, a land type, or both: `soil.html#c356`, `soil.html#land-ultramafic`, `soil.html#c036_land-saline`.

### Live data feed

`scripts/update_feed.py` writes `data/live.json`, which drives the Live prices strip and the Brent and Diesel headline tiles. The Pages workflow runs it on every push and daily at 08:17 Sydney time, commits the refreshed feed and redeploys.

* **World Bank Pink Sheet** (no key, monthly averages, updated early each month): Brent, WTI, Henry Hub, European gas, Asian LNG, urea, DAP, potash, phosphate rock, copper, nickel, wheat, maize, rice, soybeans.
* **EIA daily spot** (optional, free key): Brent, WTI, NY Harbor diesel and Henry Hub every trading day, plus the diesel crack versus Brent. Register at eia.gov/opendata/register.php, then add the key as a repo secret named `EIA_API_KEY` (Settings > Secrets and variables > Actions).

Yahoo Finance and FRED's CSV downloads both block GitHub's servers, which is why they aren't used. If a source fails, the last good values stay up with a STALE tag. Run the refresh by hand from Actions > "Refresh data feed and deploy to GitHub Pages" > Run workflow.

### Updating the numbers

Edit `data/data.js`, push, done. The headline strip, lanes, chokepoints, country values, constraint factors and divergence notes all sit in that one file.

## 2. Make videos (all free)

| Job | Tool | Cost |
|---|---|---|
| Voice | **Kokoro** (open-source, natural, offline, default) or **edge-tts** (Microsoft neural voices, incl. Australian `en-AU-WilliamNeural`, `en-AU-NatashaNeural`) or Piper, or your own recordings | free |
| Visuals | **Playwright + Chromium** drives the live dashboard and records it through Chrome's screencast | free |
| Title and stat cards | **Pillow**, in the dashboard's fonts and colours | free |
| Captions | Generated from the script text, so they are word perfect. **faster-whisper** for your own voice | free |
| Editing and encoding | **ffmpeg** | free |
| Rendering in the cloud | **GitHub Actions** (free minutes on public repos) | free |
| Upload | **YouTube Data API** (`upload_youtube.py`) or YouTube Studio by hand | free |

### Render locally

```bash
pip install -r video/requirements.txt
python -m playwright install chromium
python video/get_voice.py                         # one-time Kokoro voice download (about 350 MB)
python video/make_video.py video/episodes/ep01_chokepoints.yaml   # Australian male narrator by default
```

The narrator is set per episode in its `voice:` block. Episodes default to `en-AU-WilliamNeural` (generic Australian male, pace 1.05, pitch -4Hz for a relaxed, slightly deeper read). That voice is free but needs internet. Add `--tts kokoro` to render fully offline.

Output in `video/out/ep01_chokepoints/`:

* `long.mp4` 1920x1080 episode, `long.srt` captions to upload alongside it
* `youtube_description.txt` with chapter timestamps, sources and the dashboard link
* `short_*.mp4` 1080x1920 Shorts with burned-in captions, plus `short_*.txt` title and caption text

Useful flags:

```bash
--voice bm_george                        # other Kokoro voices: am_michael (default), af_heart, bf_emma, am_fenrir, bm_fable
--tts edge --voice en-AU-WilliamNeural   # Australian accent, needs internet
--tts own                                # use video/recordings/<episode id>/<scene id>.wav
--scenes hook,sulphur                    # quick preview of a few scenes
--only shorts                            # just the Shorts
--theme dark                             # dark dashboard frames
--music track.mp3                        # background bed, ducked to -24 dB (YouTube Audio Library is free)
--pace 1.08                              # slower narration
```

### Render on GitHub instead

Actions tab > **Render YouTube video and Shorts** > Run workflow. Pick the episode and voice. Download the `video-output` artifact when it finishes.

### Writing a new episode

Copy an episode YAML. Each scene has `narration` and a `visual`:

```yaml
- id: sulphur
  chapter: The sulphur problem          # becomes a YouTube chapter
  narration: >
    Sulphur is a by-product ...
  visual:
    type: dashboard                     # or title, stat, list
    scene: {group: Fertiliser, commodity: Sulphur, zoom: [80, 10, 1.6]}
    timeline:
      - {at: 30, scene: {select: r22, zoom: [105, 5, 2.8], ms: 3000}}
  visual_vertical: {...}                # optional framing for Shorts
```

`scene` accepts anything `window.setScene()` accepts in `assets/app.js`: `layer`, `group`, `commodity`, `scen` (0 to 1), `select` (lane id like `r22` or chokepoint id like `hormuz`), `tab` (`lines`, `rank`, `div`, `bal`, `method`), `view` (`map` or `panel`), `zoom` (`reset` or `[lon, lat, scale]`) and `ms` (transition time). Shorts are lists of scene ids with an optional hook card and outro.

### Narrate in your own voice

**Record yourself (most natural).** A teleprompter booth runs in your browser and saves one take per scene:

```bash
python video/voice_kit.py record video/episodes/ep01_chokepoints.yaml   # Space = record/stop, arrows = next/previous
python video/make_video.py video/episodes/ep01_chokepoints.yaml --tts own
```

Takes land in `video/recordings/<episode>/`. They are cleaned automatically (rumble filter, light denoise, silence trim, loudness normalised to -14 LUFS), and the visuals stretch to fit your pace. Any phone or laptop mic works. A quiet, soft-furnished room matters more than the mic.

**Clone your voice (for episodes you don't want to record).** Uses Chatterbox, an open-source model (MIT licence).

Easiest, on a free Colab GPU: open `video/clone_voice_colab.ipynb` at colab.research.google.com (File > Upload notebook), switch the runtime to T4 GPU and run the cells. It records your 60 s reference passage in the browser, lets you preview and tune the voice, then narrates every scene and downloads `narration_<episode>.zip`. Unzip that into `video/recordings/<episode id>/` and render:

```bash
python video/make_video.py video/episodes/ep01_chokepoints.yaml --tts own
```

On your own machine instead (NVIDIA GPU or Apple Silicon recommended):

```bash
python video/voice_kit.py record --reference      # read the 60 s passage once
python video/voice_kit.py reference               # cleans it and keeps the best 20 s
pip install chatterbox-tts                        # model downloads on first run (about 3 GB)
python video/clone_narration.py video/episodes/ep01_chokepoints.yaml --preview "Sulphur is the commodity almost nobody is watching."
python video/clone_narration.py video/episodes/*.yaml
python video/make_video.py video/episodes/ep01_chokepoints.yaml --tts own
```

Tuning: `--cfg 0.3` if the clone sounds rushed, `--exaggeration 0.6` for more energy, a lower `--temperature` for steadier delivery. Keep `--seed` fixed so episodes sound consistent. Re-do a single scene with `--scenes sulphur`.

`video/my_voice/` is in `.gitignore`. Keep the reference out of public repos because it is enough to clone your voice. Chatterbox adds an inaudible watermark to its output. Tick YouTube's "altered or synthetic content" box when uploading cloned-voice videos.

### Clip Shorts from any recording

Recorded yourself talking over the dashboard? Cut it into vertical Shorts with a blurred background, title bar and big captions:

```bash
python video/clip_shorts.py my_take.mp4 --clip "01:12-01:58|Why diesel broke first" --clip "04:05-04:50|Sulphur"
python video/clip_shorts.py video/out/ep01_chokepoints/long.mp4 --chapters video/out/ep01_chokepoints/youtube_description.txt
```

Without an `.srt`, it transcribes locally with faster-whisper (`pip install faster-whisper`).

### Upload

`python video/upload_youtube.py video/out/ep01_chokepoints` uploads as private with title, description, tags and captions. Setup steps are at the top of the script. Review in YouTube Studio, then publish.

## 3. Using it with Claude

Claude can run this whole pipeline in a chat because its workspace has ffmpeg, Chromium and Piper. Ask it to:

* update `data/data.js` with the latest IEA, FAO or price figures and re-render
* write a new episode YAML from a topic and render a preview
* turn a long render into more Shorts with `clip_shorts.py`
* push the repo to GitHub when a repository is connected
* drive YouTube Studio through Claude in Chrome, where it will ask before each upload or publish step

Educational content only. Not investment advice.
