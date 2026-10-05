#!/usr/bin/env python3
"""
Render a YouTube episode (16:9) and its Shorts (9:16) from an episode YAML file.

Everything here is free and runs locally or on GitHub Actions:
  narration  : your own recordings (--tts own) | a clone of your voice (--tts clone, Chatterbox) |
               Kokoro (offline, default) | edge-tts (free Microsoft voices incl. Australian) | Piper
  visuals    : the live dashboard driven by Playwright + Chrome screencast, plus title/stat cards drawn with Pillow
  captions   : generated from the script itself (exact text), optional faster-whisper for your own voice
  assembly   : ffmpeg

Usage
  python video/make_video.py video/episodes/ep01_chokepoints.yaml                 # long video + all shorts
  python video/make_video.py video/episodes/ep01_chokepoints.yaml --only shorts
  python video/make_video.py video/episodes/ep01_chokepoints.yaml --voice bm_george          # another Kokoro voice
  python video/make_video.py video/episodes/ep01_chokepoints.yaml --tts edge --voice en-AU-WilliamNeural
  python video/make_video.py video/episodes/ep01_chokepoints.yaml --tts own        # your takes from voice_kit.py record
  python video/make_video.py video/episodes/ep01_chokepoints.yaml --tts clone      # your cloned voice (see voice_kit.py)
  python video/make_video.py ... --scenes hook,sulphur                             # render a subset for quick previews
"""
import argparse, asyncio, base64, functools, http.server, json, os, re, shutil, socketserver, subprocess, sys, threading, time, wave
from pathlib import Path

import yaml
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent      # repo root (dashboard lives here)
VID = ROOT / "video"
FONTS = VID / "fonts"
FPS = 30

# Light palette copied from assets/style.css so cards match the dashboard
PAL = dict(bg="#e9eef0", surface="#f7f9fa", ink="#10202a", ink2="#44555f", muted="#74838b", line="#c8d3d8",
           accent="#0a5875", severe="#b42318", energy="#2a78d6", fert="#eb6834", food="#1baf7a", metals="#eda100")


def sh(cmd, quiet=True):
    r = subprocess.run(cmd, capture_output=quiet, text=True)
    if r.returncode != 0:
        sys.exit(f"command failed: {' '.join(map(str, cmd))}\n{r.stderr[-2000:] if quiet else ''}")
    return r


def dur(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)], capture_output=True, text=True).stdout
    return float(out.strip())


# ---------------------------------------------------------------- text helpers
def sentences(text):
    text = " ".join(text.split())
    parts = re.split(r"(?<=[.!?])\s+(?=[A-Z0-9$\"'])", text)
    return [p.strip() for p in parts if p.strip()]


SPOKEN = [  # only applied to the audio. Captions keep the written form.
    (r"\bmb/d\b", "million barrels a day"), (r"\bkb/d\b", "thousand barrels a day"), (r"\bMtpa\b", "million tonnes a year"),
    (r"\bMt\b", "million tonnes"), (r"\$/bbl", "dollars a barrel"), (r"\$/t\b", "dollars a tonne"),
    (r"\$([\d,\.]+)\s*/bbl", r"\1 dollars a barrel"), (r"\$([\d,\.]+)\s*/t\b", r"\1 dollars a tonne"),
    (r"\$([\d,\.]+)", r"\1 dollars"), (r"(\d)%", r"\1 percent"), (r"\bSX-EW\b", "S X E W"), (r"\bHPAL\b", "H-pal"),
    (r"\bLNG\b", "L N G"), (r"\bDAP\b", "D A P"), (r"\bIEA\b", "I E A"), (r"\bFAO\b", "F A O"), (r"\bOCP\b", "O C P"),
    (r"\bShFE\b", "Shanghai Futures Exchange"), (r"\bLME\b", "L M E"), (r"\bREE?s?\b", "rare earths"), (r"\be\.g\.", "for example"),
    (r"\bvs\b", "versus"), (r"\bDy\b", "dysprosium"), (r"\bTb\b", "terbium"),
]


def spoken(t):
    for a, b in SPOKEN:
        t = re.sub(a, b, t)
    return t


# ---------------------------------------------------------------- TTS
def wav_concat(parts, gap, out):
    """Concatenate wav files with silence gaps. Returns list of (start, end) per part."""
    timings, frames, params, t = [], [], None, 0.0
    for p in parts:
        with wave.open(str(p)) as w:
            params = params or w.getparams()
            if w.getframerate() != params.framerate:
                raise SystemExit("mixed sample rates in TTS output")
            data = w.readframes(w.getnframes())
            d = w.getnframes() / w.getframerate()
        frames.append(data)
        timings.append((t, t + d))
        t += d
        frames.append(b"\x00" * int(gap * params.framerate) * params.sampwidth * params.nchannels)
        t += gap
    with wave.open(str(out), "wb") as w:
        w.setparams(params)
        for f in frames:
            w.writeframes(f)
    return timings


_KOKORO = None


def kokoro():
    global _KOKORO
    if _KOKORO is None:
        from kokoro_onnx import Kokoro
        m, v = VID / "voices" / "kokoro-v1.0.onnx", VID / "voices" / "voices-v1.0.bin"
        if not m.exists():
            sys.exit("Kokoro model not found. Run: python video/get_voice.py kokoro")
        _KOKORO = Kokoro(str(m), str(v))
    return _KOKORO


_CLONE = None


def clone_model():
    global _CLONE
    if _CLONE is None:
        ref = VID / "my_voice" / "reference.wav"
        if not ref.exists():
            sys.exit("No voice reference. Run: python video/voice_kit.py record --reference, then python video/voice_kit.py reference")
        try:
            import torch
            from chatterbox.tts import ChatterboxTTS
        except ImportError:
            sys.exit("Voice cloning needs Chatterbox: pip install chatterbox-tts")
        dev = "cuda" if torch.cuda.is_available() else ("mps" if torch.backends.mps.is_available() else "cpu")
        print(f"  loading Chatterbox on {dev} (first run downloads the model)")
        m = ChatterboxTTS.from_pretrained(device=dev)
        m.prepare_conditionals(str(ref), exaggeration=0.45)
        _CLONE = m
    return _CLONE


_VCTK = None


def vctk():
    """Coqui VITS trained on VCTK (109 speakers incl. Australian). Offline, model from GitHub releases."""
    global _VCTK
    if _VCTK is None:
        import warnings
        warnings.filterwarnings("ignore")
        d = VID / "voices" / "vctk-vits"
        if not (d / "model_file.pth").exists():
            sys.exit("VCTK model not found. Run: python video/get_voice.py vctk")
        from TTS.api import TTS
        _VCTK = TTS(model_path=str(d / "model_file.pth"), config_path=str(d / "config.json"), progress_bar=False)
    return _VCTK


def tts_sentence(text, out, args):
    if args.tts == "vctk":
        import numpy as np, soundfile as sf
        m = vctk()
        m.synthesizer.tts_model.length_scale = args.pace
        audio = np.array(m.tts(text=spoken(text), speaker=args.voice), dtype=np.float32)
        sf.write(str(out), audio, m.synthesizer.output_sample_rate, subtype="PCM_16")
    elif args.tts == "clone":
        import soundfile as sf
        m = clone_model()
        wav = m.generate(spoken(text), cfg_weight=0.5 if args.pace >= 1 else 0.4, temperature=0.7)
        sf.write(str(out), wav.squeeze(0).cpu().numpy(), m.sr, subtype="PCM_16")
    elif args.tts == "kokoro":
        import soundfile as sf
        voice = args.voice if "_" in args.voice and "Neural" not in args.voice else "am_michael"
        audio, sr = kokoro().create(spoken(text), voice=voice, speed=1.0 / args.pace, lang="en-gb" if voice.startswith("b") else "en-us")
        sf.write(str(out), audio, sr, subtype="PCM_16")
    elif args.tts == "piper":
        model = Path(args.piper_model)
        if not model.exists():
            sys.exit(f"Piper voice not found at {model}. Run: python video/get_voice.py")
        subprocess.run([sys.executable, "-m", "piper", "-m", str(model), "-f", str(out), "--length-scale", str(args.pace)],
                       input=spoken(text), text=True, capture_output=True, check=True)
    elif args.tts == "edge":
        mp3 = out.with_suffix(".mp3")
        rate = f"{int(round((1 / args.pace - 1) * 100)):+d}%"
        r = subprocess.run(["edge-tts", "--voice", args.voice, f"--rate={rate}", f"--pitch={args.pitch}", "--text", spoken(text), "--write-media", str(mp3)],
                           capture_output=True, text=True)
        if r.returncode != 0:
            sys.exit("edge-tts could not reach Microsoft's speech service. It needs internet access. "
                     "Run this on your own computer or with the GitHub Actions workflow, or use --tts kokoro offline.\n" + r.stderr[-400:])
        sh(["ffmpeg", "-y", "-i", str(mp3), "-ar", "24000", "-ac", "1", str(out)])
    else:
        raise ValueError(args.tts)


def narrate(scene, work, args, ep_id):
    """Returns (wav path, [(sentence, start, end), ...])"""
    sid = scene["id"]
    out = work / f"{sid}.wav"
    sents = sentences(scene.get("narration", ""))
    if args.tts == "own":
        if not sents:
            pass  # silent scene, handled below
        else:
            found = sorted(f for f in (VID / "recordings" / ep_id).glob(f"{sid}.*") if f.suffix != ".json")
            tfile = VID / "recordings" / ep_id / f"{sid}.json"
            if found and tfile.exists():
                # cloned narration from clone_narration.py: already clean and timed sentence by sentence
                sh(["ffmpeg", "-y", "-i", str(found[0]), "-ac", "1", "-ar", "48000", "-af", "loudnorm=I=-14:TP=-1.5:LRA=9",
                    "-c:a", "pcm_s16le", str(out)])
                return out, [tuple(x) for x in json.loads(tfile.read_text())["sentences"]]
            if not found:
                sys.exit(f"missing recording for scene '{sid}'. Record it with: python video/voice_kit.py record <episode.yaml>")
            # clean the take: rumble filter, light denoise, trim silence at both ends, normalise to -14 LUFS (YouTube's target)
            sh(["ffmpeg", "-y", "-i", str(found[0]), "-ac", "1", "-ar", "48000", "-af",
                "highpass=f=70,afftdn=nf=-25,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.15,"
                "areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.25,areverse,loudnorm=I=-14:TP=-1.5:LRA=9",
                "-c:a", "pcm_s16le", str(out)])
            return out, align_own(out, sents)
    cache = work / f"{sid}.json"
    key = json.dumps([sents, args.tts, args.voice, args.pace, args.pitch])
    if cache.exists() and out.exists() and json.loads(cache.read_text())["key"] == key:
        return out, json.loads(cache.read_text())["t"]
    parts = []
    for i, s in enumerate(sents):
        p = work / f"{sid}_{i:02d}.wav"
        tts_sentence(s, p, args)
        parts.append(p)
    if not parts:  # silent scene
        p = work / f"{sid}_silence.wav"
        sh(["ffmpeg", "-y", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono", "-t", str(scene.get("hold", 3)), "-c:a", "pcm_s16le", str(p)])
        wav_concat([p], 0, out)
        cache.write_text(json.dumps({"key": key, "t": []}))
        return out, []
    tm = wav_concat(parts, 0.28, out)
    t = [(s, a, b) for s, (a, b) in zip(sents, tm)]
    cache.write_text(json.dumps({"key": key, "t": t}))
    return out, t


def align_own(wav, sents):
    """Timings for your own recording. Uses faster-whisper if installed, else spreads sentences by length."""
    total = dur(wav)
    try:
        from faster_whisper import WhisperModel
        segs, _ = WhisperModel("base.en", compute_type="int8").transcribe(str(wav), word_timestamps=False)
        segs = list(segs)
        return [(s.text.strip(), s.start, s.end) for s in segs]
    except Exception:
        n = sum(len(s) for s in sents) or 1
        t, out = 0.0, []
        for s in sents:
            d = total * len(s) / n
            out.append((s, t, t + d))
            t += d
        return out


# ---------------------------------------------------------------- captions
def chunk_caps(timed, max_words):
    caps = []
    for text, a, b in timed:
        words = text.split()
        chunks = [words[i:i + max_words] for i in range(0, len(words), max_words)]
        n = sum(len(" ".join(c)) for c in chunks) or 1
        t = a
        for c in chunks:
            s = " ".join(c)
            d = (b - a) * len(s) / n
            caps.append((s, t, t + d))
            t += d
    return caps


def ts_srt(t):
    h, r = divmod(t, 3600); m, s = divmod(r, 60)
    return f"{int(h):02d}:{int(m):02d}:{int(s):02d},{int(round((s % 1) * 1000)) % 1000:03d}"


def ts_ass(t):
    h, r = divmod(t, 3600); m, s = divmod(r, 60)
    return f"{int(h)}:{int(m):02d}:{s:05.2f}"


def write_srt(caps, path):
    path.write_text("\n".join(f"{i}\n{ts_srt(a)} --> {ts_srt(b)}\n{t}\n" for i, (t, a, b) in enumerate(caps, 1)))


def write_ass(caps, path, w, h, vertical):
    size = 66 if vertical else 46
    margin = int(h * 0.17) if vertical else 60
    head = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {w}
PlayResY: {h}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Public Sans,{size},&H00FFFFFF,&H00FFFFFF,&H002A2010,&H002A2010,-1,0,0,0,100,100,0,0,3,{16 if vertical else 10},0,2,80,80,{margin},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    lines = []
    for t, a, b in caps:
        txt = t.upper() if vertical else t
        lines.append(f"Dialogue: 0,{ts_ass(a)},{ts_ass(b)},Cap,,0,0,0,,{txt}")
    path.write_text(head + "\n".join(lines) + "\n")


# ---------------------------------------------------------------- cards (Pillow)
def font(name, size):
    p = FONTS / f"{name}.ttf"
    try:
        return ImageFont.truetype(str(p), size)
    except OSError:
        return ImageFont.truetype("DejaVuSans-Bold.ttf", size)


def wrap(draw, text, f, width):
    words, lines, cur = text.split(), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if draw.textlength(t, font=f) <= width:
            cur = t
        else:
            lines.append(cur); cur = w
    if cur:
        lines.append(cur)
    return lines


def draw_card(scene, w, h, out):
    im = Image.new("RGB", (w, h), PAL["bg"])
    d = ImageDraw.Draw(im)
    s = w / 1920 if w > h else w / 1080
    pad = int(110 * s)
    kind = scene["visual"]["type"]
    v = scene["visual"]
    d.rectangle([0, 0, w, int(14 * s)], fill=PAL[v.get("color", "accent")])
    eyebrow = v.get("eyebrow", "Chokepoint Ledger")
    d.text((pad, pad), eyebrow.upper(), font=font("jetbrains-mono-latin-700-normal", int(30 * s)), fill=PAL["muted"])
    y = pad + int(70 * s)
    if kind == "title":
        f = font("big-shoulders-display-latin-800-normal", int((150 if w > h else 130) * s))
        for line in wrap(d, v["text"].upper(), f, w - 2 * pad):
            d.text((pad, y), line, font=f, fill=PAL["ink"]); y += int(f.size * 1.0)
        if v.get("sub"):
            y += int(30 * s)
            f2 = font("public-sans-latin-600-normal", int(44 * s))
            for line in wrap(d, v["sub"], f2, w - 2 * pad):
                d.text((pad, y), line, font=f2, fill=PAL["ink2"]); y += int(f2.size * 1.35)
    elif kind == "stat":
        f = font("jetbrains-mono-latin-700-normal", int((230 if w > h else 210) * s))
        d.text((pad, y), v["value"], font=f, fill=PAL[v.get("color", "severe")])
        y += int(f.size * 1.15)
        if v.get("unit"):
            fu = font("jetbrains-mono-latin-700-normal", int(48 * s))
            d.text((pad + int(8 * s), y), v["unit"], font=fu, fill=PAL["muted"]); y += int(90 * s)
        f2 = font("big-shoulders-display-latin-800-normal", int(88 * s))
        for line in wrap(d, v["label"].upper(), f2, w - 2 * pad):
            d.text((pad, y), line, font=f2, fill=PAL["ink"]); y += int(f2.size * 1.02)
        if v.get("note"):
            y += int(20 * s)
            f3 = font("public-sans-latin-600-normal", int(38 * s))
            for line in wrap(d, v["note"], f3, w - 2 * pad):
                d.text((pad, y), line, font=f3, fill=PAL["ink2"]); y += int(f3.size * 1.35)
    elif kind == "list":
        f = font("big-shoulders-display-latin-800-normal", int(96 * s))
        for line in wrap(d, v["text"].upper(), f, w - 2 * pad):
            d.text((pad, y), line, font=f, fill=PAL["ink"]); y += int(f.size * 1.0)
        y += int(40 * s)
        f2 = font("public-sans-latin-700-normal", int(50 * s))
        fn = font("jetbrains-mono-latin-700-normal", int(50 * s))
        for i, item in enumerate(v["items"], 1):
            d.text((pad, y), f"{i:02d}", font=fn, fill=PAL[v.get("color", "severe")])
            lines = wrap(d, item, f2, w - 2 * pad - int(110 * s))
            for line in lines:
                d.text((pad + int(110 * s), y), line, font=f2, fill=PAL["ink"]); y += int(f2.size * 1.3)
            y += int(18 * s)
    foot = font("jetbrains-mono-latin-700-normal", int(24 * s))
    d.text((pad, h - pad), v.get("source", "Data as of 5 Oct 2026. Educational content, not investment advice."), font=foot, fill=PAL["muted"])
    im.save(out)


def card_clip(img, seconds, out, w, h):
    frames = int(seconds * FPS) + 1
    # slow push-in so a still card does not look frozen
    zp = f"zoompan=z='1+0.04*on/{frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d={frames}:s={w}x{h}:fps={FPS}"
    sh(["ffmpeg", "-y", "-loop", "1", "-i", str(img), "-vf", f"scale={w*2}:{h*2},{zp},format=yuv420p", "-t", f"{seconds:.3f}", "-r", str(FPS),
        "-c:v", "libx264", "-preset", "medium", "-crf", "18", str(out)])


# ---------------------------------------------------------------- dashboard capture (Playwright + CDP screencast)
class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def serve(port):
    handler = functools.partial(QuietHandler, directory=str(ROOT))
    httpd = socketserver.TCPServer(("127.0.0.1", port), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


async def capture_dashboard(browser, url, scene, seconds, out, vertical, theme):
    """Record the dashboard while running the scene's timeline. Frames come from Chrome's screencast so they are sharp."""
    vw, vh, dpr = (540, 960, 2) if vertical else (1920, 1080, 1)
    ctx = await browser.new_context(viewport={"width": vw, "height": vh}, device_scale_factor=dpr, color_scheme=theme)
    page = await ctx.new_page()
    await page.goto(url)
    await page.wait_for_function("window.dashboardReady === true")
    await page.evaluate("document.fonts.ready")
    v = scene["visual"]
    first = dict(v.get("scene", {}))
    first.setdefault("capture", True)
    first.setdefault("portrait", vertical)
    first["ms"] = 0
    await page.evaluate("(o) => setScene(o)", first)
    if v.get("scroll"):
        await page.evaluate("(s) => document.querySelector(s).scrollIntoView({block: 'start'})", v["scroll"])
    if v.get("scroll_y"):
        await page.evaluate("(y) => window.scrollBy(0, y)", v["scroll_y"])
    await page.wait_for_timeout(400)

    frames_dir = out.parent / (out.stem + "_frames")
    shutil.rmtree(frames_dir, ignore_errors=True); frames_dir.mkdir()
    frames = []
    cdp = await ctx.new_cdp_session(page)

    async def on_frame(p):
        i = len(frames)
        fp = frames_dir / f"{i:05d}.jpg"
        fp.write_bytes(base64.b64decode(p["data"]))
        frames.append((p["metadata"]["timestamp"], fp))
        try:
            await cdp.send("Page.screencastFrameAck", {"sessionId": p["sessionId"]})
        except Exception:
            pass

    cdp.on("Page.screencastFrame", lambda p: asyncio.ensure_future(on_frame(p)))
    await cdp.send("Page.startScreencast", {"format": "jpeg", "quality": 92, "maxWidth": vw * dpr, "maxHeight": vh * dpr, "everyNthFrame": 1})
    # nudge one paint so the first frame exists
    await page.evaluate("document.body.style.outline='0px solid transparent'")
    t0 = time.monotonic()
    for step in sorted(v.get("timeline", []), key=lambda s: s["at"]):
        wait = step["at"] - (time.monotonic() - t0)
        if wait > 0:
            await asyncio.sleep(wait)
        if "scene" in step:
            asyncio.ensure_future(page.evaluate("(o) => setScene(o)", step["scene"]))
        if "scroll" in step:
            asyncio.ensure_future(page.evaluate("(s) => document.querySelector(s).scrollIntoView({behavior: 'smooth', block: 'start'})", step["scroll"]))
        if "scroll_by" in step:
            asyncio.ensure_future(page.evaluate("(y) => window.scrollBy({top: y, behavior: 'smooth'})", step["scroll_by"]))
    rest = seconds - (time.monotonic() - t0)
    if rest > 0:
        await asyncio.sleep(rest)
    await cdp.send("Page.stopScreencast")
    await asyncio.sleep(0.2)
    await ctx.close()
    if not frames:
        sys.exit(f"no frames captured for scene {scene['id']}")
    # turn variable-rate frames into a constant-rate clip
    base = frames[0][0]
    lst = frames_dir / "list.txt"
    with lst.open("w") as f:
        for i, (ts, fp) in enumerate(frames):
            nxt = frames[i + 1][0] if i + 1 < len(frames) else base + seconds
            f.write(f"file '{fp.name}'\nduration {max(nxt - ts, 1 / FPS):.4f}\n")
        f.write(f"file '{frames[-1][1].name}'\n")
    W, H = (1080, 1920) if vertical else (1920, 1080)
    sh(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(lst), "-vf", f"scale={W}:{H}:flags=lanczos,fps={FPS},format=yuv420p",
        "-t", f"{seconds:.3f}", "-c:v", "libx264", "-preset", "medium", "-crf", "18", str(out)])
    shutil.rmtree(frames_dir, ignore_errors=True)


# ---------------------------------------------------------------- assembly
def mux(video, audio, out):
    sh(["ffmpeg", "-y", "-i", str(video), "-i", str(audio), "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
        "-ar", "48000", "-shortest", str(out)])


def concat(clips, out):
    lst = out.with_suffix(".txt")
    lst.write_text("".join(f"file '{c.resolve()}'\n" for c in clips))
    sh(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", str(out)])


def burn(src, ass, out, music=None, music_db=-24):
    vf = f"ass={ass}:fontsdir={FONTS}"
    cmd = ["ffmpeg", "-y", "-i", str(src)]
    if music:
        cmd += ["-stream_loop", "-1", "-i", str(music), "-filter_complex",
                f"[0:v]{vf}[v];[1:a]volume={music_db}dB[m];[0:a][m]amix=inputs=2:duration=first:dropout_transition=0[a]", "-map", "[v]", "-map", "[a]"]
    else:
        cmd += ["-vf", vf, "-c:a", "copy"]
    cmd += ["-c:v", "libx264", "-preset", "medium", "-crf", "19", "-movflags", "+faststart", str(out)]
    sh(cmd)


async def render(ep, scenes, vertical, args, work, out_dir, tag):
    W, H = (1080, 1920) if vertical else (1920, 1080)
    clips, all_caps, chapters, t = [], [], [], 0.0
    browser = None
    from playwright.async_api import async_playwright
    async with async_playwright() as p:
        for sc in scenes:
            wav, timed = narrate(sc, work, args, ep["id"])
            seconds = dur(wav) + sc.get("tail", 0.5)
            vclip = work / f"{tag}_{sc['id']}_v.mp4"
            kind = sc["visual"]["type"]
            if kind == "dashboard":
                if browser is None:
                    browser = await p.chromium.launch()
                await capture_dashboard(browser, args.url, sc, seconds, vclip, vertical, sc["visual"].get("theme", args.theme))
            else:
                img = work / f"{tag}_{sc['id']}.png"
                draw_card(sc, W, H, img)
                card_clip(img, seconds, vclip, W, H)
            # pad audio to clip length
            apad = work / f"{tag}_{sc['id']}_a.wav"
            sh(["ffmpeg", "-y", "-i", str(wav), "-af", f"loudnorm=I=-14:TP=-1.5:LRA=11,apad=whole_dur={seconds:.3f}", "-ar", "48000", str(apad)])
            clip = work / f"{tag}_{sc['id']}.mp4"
            mux(vclip, apad, clip)
            clips.append(clip)
            if sc.get("chapter"):
                chapters.append((t, sc["chapter"]))
            all_caps += [(s, a + t, b + t) for s, a, b in timed]
            t += dur(clip)
            print(f"  [{tag}] {sc['id']:<18} {seconds:5.1f}s  ({kind})")
        if browser:
            await browser.close()
    raw = work / f"{tag}_raw.mp4"
    concat(clips, raw)
    caps = chunk_caps(all_caps, 4 if vertical else 11)
    srt = out_dir / f"{tag}.srt"
    write_srt(chunk_caps(all_caps, 11), srt)
    ass = work / f"{tag}.ass"
    write_ass(caps, ass, W, H, vertical)
    final = out_dir / f"{tag}.mp4"
    if vertical or args.burn_long:
        burn(raw, ass, final, args.music)
    elif args.music:
        burn_free = work / f"{tag}_m.mp4"
        sh(["ffmpeg", "-y", "-i", str(raw), "-stream_loop", "-1", "-i", str(args.music), "-filter_complex",
            "[1:a]volume=-24dB[m];[0:a][m]amix=inputs=2:duration=first[a]", "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-movflags", "+faststart", str(burn_free)])
        shutil.move(burn_free, final)
    else:
        sh(["ffmpeg", "-y", "-i", str(raw), "-c", "copy", "-movflags", "+faststart", str(final)])
    return final, chapters, t


def fmt_ts(t):
    m, s = divmod(int(t), 60); h, m = divmod(m, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("episode")
    ap.add_argument("--only", choices=["long", "shorts", "all"], default="all")
    ap.add_argument("--scenes", help="comma list of scene ids for a quick preview")
    ap.add_argument("--tts", choices=["vctk", "kokoro", "edge", "piper", "own", "clone"], default=os.environ.get("TTS"), help="default comes from the episode's voice: block, else kokoro")
    ap.add_argument("--voice", default=None, help="kokoro: am_michael, bm_george, af_heart, bf_emma, am_fenrir, bm_fable. edge: en-AU-WilliamNeural etc (edge-tts --list-voices)")
    ap.add_argument("--piper-model", default=str(VID / "voices" / "en_US-lessac-medium.onnx"))
    ap.add_argument("--pace", type=float, default=None, help=">1 slower, <1 faster")
    ap.add_argument("--pitch", default=None, help="edge only, e.g. -4Hz for a slightly deeper voice")
    ap.add_argument("--theme", default="light", choices=["light", "dark"])
    ap.add_argument("--url", default=None, help="dashboard URL. Default serves this repo locally")
    ap.add_argument("--music", help="optional background track (YouTube Audio Library is free)")
    ap.add_argument("--burn-long", action="store_true", help="burn captions into the long video too (YouTube usually prefers the .srt)")
    args = ap.parse_args()
    ep = yaml.safe_load(Path(args.episode).read_text())
    # voice settings: command line > episode "voice:" block > defaults
    vcfg = ep.get("voice", {})
    args.tts = args.tts or vcfg.get("tts", "kokoro")
    if args.voice is None:
        args.voice = vcfg.get("voice") if vcfg.get("tts", "kokoro") == args.tts else None
        args.voice = args.voice or {"kokoro": "am_michael", "edge": "en-AU-WilliamNeural", "vctk": "p254"}.get(args.tts, "")
    args.pace = args.pace if args.pace is not None else float(vcfg.get("pace", 1.0))
    args.pitch = args.pitch or vcfg.get("pitch", "+0Hz")
    print(f"Voice: {args.tts} {args.voice} pace {args.pace} pitch {args.pitch}")

    out_dir = ROOT / "video" / "out" / ep["id"]; out_dir.mkdir(parents=True, exist_ok=True)
    work = out_dir / "work"; work.mkdir(exist_ok=True)
    httpd = None
    if not args.url:
        httpd = serve(0)  # any free port
        args.url = f"http://127.0.0.1:{httpd.server_address[1]}/index.html"

    by_id = {s["id"]: s for s in ep["scenes"]}
    sel = args.scenes.split(",") if args.scenes else None

    if args.only in ("long", "all"):
        scenes = [s for s in ep["scenes"] if not sel or s["id"] in sel]
        print(f"Rendering long video: {ep['title']}")
        final, chapters, total = asyncio.run(render(ep, scenes, False, args, work, out_dir, "long"))
        desc = [ep.get("description", "").strip(), "", "Chapters"] + [f"{fmt_ts(t)} {c}" for t, c in chapters]
        desc += ["", "Interactive dashboard: " + ep.get("dashboard_url", "(add your GitHub Pages link)"), "", "Sources"] + [f"- {s}" for s in ep.get("sources", [])]
        desc += ["", "Educational content only. Not financial advice."]
        (out_dir / "youtube_description.txt").write_text("\n".join(desc))
        (out_dir / "youtube_meta.json").write_text(json.dumps({"title": ep["title"], "tags": ep.get("tags", []), "description_file": "youtube_description.txt", "captions": "long.srt"}, indent=2))
        print(f"  -> {final.relative_to(ROOT)} ({fmt_ts(total)})")

    if args.only in ("shorts", "all"):
        for sh_ in ep.get("shorts", []):
            if sel and not set(sh_["scenes"]) & set(sel):
                continue
            scenes = []
            if sh_.get("hook"):
                scenes.append({"id": f"{sh_['id']}_hook", "narration": sh_["hook"].get("say", ""), "tail": 0.2,
                               "visual": {"type": "title", "text": sh_["hook"]["text"], "eyebrow": sh_["hook"].get("eyebrow", "60 second commodity brief"), "color": "severe"}})
            scenes += [by_id[s] | {"visual": by_id[s].get("visual_vertical", by_id[s]["visual"])} for s in sh_["scenes"]]
            if sh_.get("outro"):
                scenes.append({"id": f"{sh_['id']}_outro", "narration": sh_["outro"], "tail": 0.6,
                               "visual": {"type": "title", "text": "Full breakdown on the channel", "sub": "Interactive map linked in the description"}})
            print(f"Rendering short: {sh_['id']}")
            final, _, total = asyncio.run(render(ep, scenes, True, args, work, out_dir, f"short_{sh_['id']}"))
            (out_dir / f"short_{sh_['id']}.txt").write_text(f"{sh_['title']}\n\n{sh_.get('caption', '')}\n\n#Shorts " + " ".join("#" + t.replace(" ", "") for t in ep.get("tags", [])[:4]))
            if total > 60:
                print(f"  ! short is {total:.0f}s. YouTube Shorts allow up to 3 min, but under 60s performs best.")
            print(f"  -> {final.relative_to(ROOT)} ({total:.0f}s)")
    if httpd:
        httpd.shutdown()


if __name__ == "__main__":
    main()
