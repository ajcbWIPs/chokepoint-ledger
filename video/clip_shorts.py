#!/usr/bin/env python3
"""
Cut vertical Shorts out of ANY landscape video: the rendered episode, a screen recording of you walking
through the dashboard, or a talking-head recording. Free and local.

  # clips listed by hand
  python video/clip_shorts.py my_recording.mp4 --clip "01:12-01:58|Why diesel broke first" --clip "04:05-04:50|Sulphur"

  # one clip per chapter from a rendered episode (uses its .srt for captions)
  python video/clip_shorts.py video/out/ep01_chokepoints/long.mp4 --chapters video/out/ep01_chokepoints/youtube_description.txt

Captions come from an .srt next to the video (same name) or --srt. If there is none and faster-whisper is
installed (pip install faster-whisper), the audio is transcribed locally. Layout: blurred full-bleed
background, the original frame centred, a title bar on top and large captions in the lower third.
"""
import argparse, re, subprocess, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from make_video import FONTS, chunk_caps, write_ass, sh, dur  # noqa: E402


def t2s(t):
    parts = [float(p) for p in t.replace(",", ".").split(":")]
    s = 0.0
    for p in parts:
        s = s * 60 + p
    return s


def read_srt(path):
    out = []
    for block in Path(path).read_text().strip().split("\n\n"):
        lines = block.strip().splitlines()
        if len(lines) >= 3 and "-->" in lines[1]:
            a, b = [t2s(x.strip()) for x in lines[1].split("-->")]
            out.append((" ".join(lines[2:]), a, b))
    return out


def whisper(video):
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("No captions found and faster-whisper is not installed. Clips will have no captions.")
        return []
    print("Transcribing locally with faster-whisper (base.en)...")
    segs, _ = WhisperModel("base.en", compute_type="int8").transcribe(str(video))
    return [(s.text.strip(), s.start, s.end) for s in segs]


def chapters_from(desc_path, total):
    rows = []
    for line in Path(desc_path).read_text().splitlines():
        m = re.match(r"^(\d+:\d{2}(?::\d{2})?)\s+(.+)$", line.strip())
        if m:
            rows.append((t2s(m.group(1)), m.group(2)))
    return [(a, rows[i + 1][0] if i + 1 < len(rows) else total, title) for i, (a, title) in enumerate(rows)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--clip", action="append", default=[], help='"MM:SS-MM:SS|Title"')
    ap.add_argument("--chapters", help="youtube_description.txt with chapter timestamps")
    ap.add_argument("--srt")
    ap.add_argument("--max", type=float, default=59.0, help="trim each clip to this many seconds")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    video = Path(args.video)
    total = dur(video)
    out_dir = Path(args.out) if args.out else video.parent / "clips"
    out_dir.mkdir(parents=True, exist_ok=True)

    srt = Path(args.srt) if args.srt else video.with_suffix(".srt")
    caps = read_srt(srt) if srt.exists() else whisper(video)

    clips = []
    for c in args.clip:
        rng, _, title = c.partition("|")
        a, b = rng.split("-")
        clips.append((t2s(a), t2s(b), title or "Clip"))
    if args.chapters:
        clips += chapters_from(args.chapters, total)
    if not clips:
        sys.exit("Give --clip or --chapters")

    for i, (a, b, title) in enumerate(clips, 1):
        b = min(b, a + args.max)
        local = [(t, max(s - a, 0), min(e - a, b - a)) for t, s, e in caps if e > a and s < b]
        ass = out_dir / f"clip_{i:02d}.ass"
        write_ass(chunk_caps(local, 4), ass, 1080, 1920, True)
        safe = re.sub(r"[^A-Za-z0-9]+", "_", title).strip("_").lower()[:40]
        out = out_dir / f"short_{i:02d}_{safe}.mp4"
        title_txt = title.upper().replace(":", r"\:").replace("'", "")
        font = FONTS / "big-shoulders-display-latin-800-normal.ttf"
        vf = (
            "[0:v]split[a][b];"
            "[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:2,eq=brightness=-0.08[bg];"
            "[b]scale=1080:-2[fg];"
            "[bg][fg]overlay=(W-w)/2:(H-h)/2-120,"
            f"drawbox=x=0:y=150:w=1080:h=190:color=0x10202a@0.88:t=fill,"
            f"drawtext=fontfile={font}:text='{title_txt}':fontcolor=white:fontsize=78:x=(w-text_w)/2:y=200,"
            f"ass={ass}:fontsdir={FONTS}[v]"
        )
        sh(["ffmpeg", "-y", "-ss", f"{a:.2f}", "-to", f"{b:.2f}", "-i", str(video), "-filter_complex", vf, "-map", "[v]", "-map", "0:a?",
            "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", str(out)])
        print(f"  -> {out} ({b - a:.0f}s)")


if __name__ == "__main__":
    main()
