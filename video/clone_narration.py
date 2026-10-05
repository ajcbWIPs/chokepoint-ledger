#!/usr/bin/env python3
"""
Generate an episode's narration in YOUR cloned voice with Chatterbox (open source, MIT licence).

Runs anywhere Chatterbox runs: Google Colab (free GPU, see clone_voice_colab.ipynb), a PC with an
NVIDIA GPU, an Apple Silicon Mac (MPS), or plain CPU (slow). Output is one wav per scene plus a
timing file, named so make_video.py can use it directly:

  python video/clone_narration.py video/episodes/ep01_chokepoints.yaml --ref video/my_voice/reference.wav
  python video/make_video.py video/episodes/ep01_chokepoints.yaml --tts own

Tuning (try on one line first with --preview "some text"):
  --exaggeration  0.3 calm and flat ... 0.5 default ... 0.7 animated
  --cfg           0.5 default. Lower (0.3) if the clone talks too fast or sounds rushed
  --temperature   0.6 to 0.8. Lower is steadier, higher is more varied
  --seed          keep fixed so the voice stays consistent between scenes and episodes
"""
import argparse, json, re, sys, wave
from pathlib import Path

import yaml

GAP = 0.28  # seconds of silence between sentences, matches make_video.py

# Expand units and acronyms so the voice reads them naturally (captions keep the written form)
SPOKEN = [
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


def sentences(text):
    text = " ".join((text or "").split())
    return [p for p in re.split(r"(?<=[.!?])\s+(?=[A-Z0-9$\"'])", text) if p.strip()]


def episode_lines(ep):
    """(scene id, narration) for every voiced scene, including Shorts hooks and outros."""
    out = [(s["id"], s.get("narration", "")) for s in ep["scenes"] if s.get("narration")]
    for sh in ep.get("shorts", []):
        if sh.get("hook", {}).get("say"):
            out.append((f"{sh['id']}_hook", sh["hook"]["say"]))
        if sh.get("outro"):
            out.append((f"{sh['id']}_outro", sh["outro"]))
    return out


class Cloner:
    def __init__(self, ref, exaggeration, cfg, temperature, seed):
        import torch
        from chatterbox.tts import ChatterboxTTS
        self.torch = torch
        dev = "cuda" if torch.cuda.is_available() else ("mps" if torch.backends.mps.is_available() else "cpu")
        print(f"Loading Chatterbox on {dev} (first run downloads about 3 GB)")
        self.m = ChatterboxTTS.from_pretrained(device=dev)
        self.m.prepare_conditionals(str(ref), exaggeration=exaggeration)
        self.sr = self.m.sr
        self.cfg, self.temperature, self.seed = cfg, temperature, seed

    def say(self, text):
        if self.seed is not None:
            self.torch.manual_seed(self.seed)
        wav = self.m.generate(spoken(text), cfg_weight=self.cfg, temperature=self.temperature)
        return wav.squeeze(0).detach().cpu().numpy()


def write_wav(path, chunks, sr):
    import numpy as np
    gap = np.zeros(int(GAP * sr), dtype=np.float32)
    timings, parts, t = [], [], 0.0
    for text, audio in chunks:
        audio = audio.astype(np.float32)
        d = len(audio) / sr
        timings.append([text, round(t, 3), round(t + d, 3)])
        parts += [audio, gap]
        t += d + GAP
    data = np.concatenate(parts) if parts else gap
    peak = float(np.abs(data).max()) or 1.0
    pcm = (data / max(peak, 1e-6) * 0.89 * 32767).astype("<i2")  # normalise to -1 dBFS peak
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr); w.writeframes(pcm.tobytes())
    return timings


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("episodes", nargs="*", help="episode yaml files")
    ap.add_argument("--ref", default=str(Path(__file__).resolve().parent / "my_voice" / "reference.wav"))
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent / "recordings"))
    ap.add_argument("--scenes", help="comma list of scene ids to (re)generate")
    ap.add_argument("--preview", help="just speak this text to preview.wav")
    ap.add_argument("--exaggeration", type=float, default=0.5)
    ap.add_argument("--cfg", type=float, default=0.5)
    ap.add_argument("--temperature", type=float, default=0.7)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--force", action="store_true", help="overwrite scenes that already exist")
    a = ap.parse_args()

    if not Path(a.ref).exists():
        sys.exit(f"No reference recording at {a.ref}")
    c = Cloner(a.ref, a.exaggeration, a.cfg, a.temperature, a.seed)

    if a.preview:
        write_wav(Path("preview.wav"), [(s, c.say(s)) for s in sentences(a.preview)], c.sr)
        print("Wrote preview.wav")
        return

    sel = set(a.scenes.split(",")) if a.scenes else None
    for ep_path in a.episodes:
        ep = yaml.safe_load(Path(ep_path).read_text())
        d = Path(a.out) / ep["id"]
        d.mkdir(parents=True, exist_ok=True)
        lines = [(sid, txt) for sid, txt in episode_lines(ep) if not sel or sid in sel]
        print(f"{ep['title']}: {len(lines)} scenes -> {d}")
        for n, (sid, txt) in enumerate(lines, 1):
            wav_path = d / f"{sid}.wav"
            if wav_path.exists() and not a.force and not sel:
                print(f"  [{n}/{len(lines)}] {sid} exists, skipping")
                continue
            sents = sentences(txt)
            chunks = []
            for s in sents:
                chunks.append((s, c.say(s)))
            timings = write_wav(wav_path, chunks, c.sr)
            (d / f"{sid}.json").write_text(json.dumps({"engine": "chatterbox-clone", "sentences": timings}, indent=1))
            print(f"  [{n}/{len(lines)}] {sid}: {timings[-1][2]:.1f} s")
    print("Done. Render with: python video/make_video.py <episode.yaml> --tts own")


if __name__ == "__main__":
    main()
