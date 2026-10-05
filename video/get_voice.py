#!/usr/bin/env python3
"""Download a free narration voice into video/voices/. Run once.

  python video/get_voice.py                      # default: Kokoro (natural, offline)
  python video/get_voice.py vctk                 # VCTK voices incl. Australian male p254 (needs coqui-tts)
  python video/get_voice.py en_US-lessac-medium  # Piper fallback voice
  python video/get_voice.py en_GB-alan-medium    # any voice from https://huggingface.co/rhasspy/piper-voices
"""
import sys, urllib.request
from pathlib import Path

name = sys.argv[1] if len(sys.argv) > 1 else "kokoro"
out = Path(__file__).resolve().parent / "voices"
out.mkdir(exist_ok=True)
if name == "kokoro":  # default: natural open-source voice, about 350 MB, runs offline on CPU
    rel = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/"
    for f in ("kokoro-v1.0.onnx", "voices-v1.0.bin"):
        if not (out / f).exists():
            print("downloading", f)
            urllib.request.urlretrieve(rel + f, out / f)
    print("Kokoro ready. Voices: am_michael, bm_george, af_heart, bf_emma, am_fenrir, bm_fable")
    sys.exit(0)
if name == "vctk":  # Coqui VITS, 109 VCTK speakers incl. Australian male p254. Needs: pip install coqui-tts
    import zipfile, json
    z = out / "vctk.zip"
    if not (out / "vctk-vits" / "model_file.pth").exists():
        print("downloading VCTK VITS (about 150 MB)")
        urllib.request.urlretrieve("https://github.com/coqui-ai/TTS/releases/download/v0.6.1_models/tts_models--en--vctk--vits.zip", z)
        zipfile.ZipFile(z).extractall(out)
        (out / "tts_models--en--vctk--vits").rename(out / "vctk-vits")
        z.unlink()
    cfg = out / "vctk-vits" / "config.json"
    txt = cfg.read_text()
    fixed = json.loads(txt)
    sp = str(out / "vctk-vits" / "speaker_ids.json")
    fixed["speakers_file"] = sp
    fixed.setdefault("model_args", {})["speakers_file"] = sp
    cfg.write_text(json.dumps(fixed, indent=1))
    print("VCTK ready. Australian-accented male: p254")
    sys.exit(0)
lang, voice, quality = name.split("-")
family = lang.split("_")[0]
base = f"https://huggingface.co/rhasspy/piper-voices/resolve/main/{family}/{lang}/{voice}/{quality}/{name}"
for ext in (".onnx", ".onnx.json"):
    dest = out / (name + ext)
    if dest.exists():
        print("have", dest.name)
        continue
    print("downloading", dest.name)
    urllib.request.urlretrieve(base + ext + "?download=true", dest)
print("Voice ready. Use --piper-model", out / (name + ".onnx"))
