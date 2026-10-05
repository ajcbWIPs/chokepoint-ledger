#!/usr/bin/env python3
"""
Narrate the videos in your own voice. Two routes, both free.

ROUTE 1: record yourself (most natural)
  python video/voice_kit.py record video/episodes/ep01_chokepoints.yaml
  -> opens a teleprompter at http://localhost:8800 . Press Space to record a scene, Space to stop,
     listen back, re-take if needed. Each take saves straight to video/recordings/<episode>/<scene>.webm
  python video/make_video.py video/episodes/ep01_chokepoints.yaml --tts own
  (audio is cleaned automatically: rumble filter, light denoise, loudness normalised to YouTube's -14 LUFS)

ROUTE 2: clone your voice with Chatterbox (open source, runs locally)
  python video/voice_kit.py record --reference      # read the reference passage once (about 60 s)
  python video/voice_kit.py reference               # cleans it and cuts the best 20 s into video/my_voice/reference.wav
  pip install chatterbox-tts                        # first run downloads the model (about 3 GB)
  python video/make_video.py video/episodes/ep01_chokepoints.yaml --tts clone
  Tips: record in a quiet, soft-furnished room, 15 to 25 cm from the mic, natural pace.
  A GPU makes cloning fast. On CPU, expect roughly 2 to 5 minutes per minute of narration.

Keep reference.wav out of public repos (it is in .gitignore). Anyone holding it can clone your voice.
"""
import argparse, json, re, subprocess, sys, threading, webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

import yaml

VID = Path(__file__).resolve().parent
REC = VID / "recordings"
MYV = VID / "my_voice"

REFERENCE_TEXT = (
    "I study engineering, and this channel is about the physical side of the economy. "
    "Where crude oil, diesel, fertiliser, grain and metals actually move, and what happens when a route closes. "
    "Take sulphur. Most of it is a by-product of cleaning sour gas, so producers cannot simply make more when the price rises. "
    "Is that a problem? It is if you run a copper leach plant in Chile, or a nickel refinery in Indonesia. "
    "Numbers help. Ten million barrels a day, fourteen thousand eight hundred dollars a tonne, forty five percent. "
    "Honestly, the most interesting part is how one input links energy, metals and food. "
    "So let's map it, score it, and see which supply lines break first."
)

PAGE = r"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Narration Booth</title>
<style>
:root{--bg:#0d1519;--panel:#142028;--ink:#e8eff2;--muted:#8a9aa2;--line:#25363f;--rec:#ff5b4d;--ok:#5fc495;--acc:#5cb2d4}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,"Segoe UI",sans-serif}
.app{display:grid;grid-template-columns:260px 1fr;min-height:100vh}
nav{border-right:1px solid var(--line);padding:16px;overflow:auto;max-height:100vh;position:sticky;top:0}
nav h1{font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin:0 0 12px}
nav button{display:flex;justify-content:space-between;gap:8px;width:100%;text-align:left;background:none;border:1px solid transparent;color:var(--ink);padding:8px 10px;border-radius:6px;cursor:pointer;font:inherit;font-size:14px}
nav button[aria-current=true]{border-color:var(--acc);background:var(--panel)}
nav .st{font-family:ui-monospace,monospace;font-size:12px;color:var(--muted)}nav .st.ok{color:var(--ok)}
main{padding:32px clamp(16px,5vw,64px);display:grid;gap:20px;align-content:start}
.eyebrow{font:600 12px ui-monospace,monospace;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
.script{font-size:clamp(24px,3vw,38px);line-height:1.45;max-width:34ch;font-weight:500}
.script .s{display:block;margin-bottom:.5em}
.bar{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
button.big{font:600 16px system-ui;padding:12px 18px;border-radius:8px;border:1px solid var(--line);background:var(--panel);color:var(--ink);cursor:pointer}
button.big.rec{background:var(--rec);border-color:var(--rec);color:#fff}
button.big:focus-visible,nav button:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
.meter{height:8px;width:220px;background:var(--line);border-radius:4px;overflow:hidden}.meter span{display:block;height:100%;width:0;background:var(--ok)}
.timer{font:600 18px ui-monospace,monospace;min-width:4ch}
.note{color:var(--muted);font-size:14px;max-width:70ch}
audio{width:min(480px,100%)}
@media(max-width:760px){.app{grid-template-columns:1fr}nav{position:static;max-height:none;border-right:0;border-bottom:1px solid var(--line)}}
</style></head><body><div class="app">
<nav><h1 id="epname"></h1><div id="list"></div></nav>
<main>
 <div class="eyebrow" id="where"></div>
 <div class="script" id="script"></div>
 <div class="bar">
  <button class="big" id="recbtn" type="button">Record (Space)</button>
  <div class="meter" aria-label="Input level"><span id="lvl"></span></div><span class="timer" id="timer">0:00</span>
  <button class="big" id="prev" type="button">Previous (Left)</button><button class="big" id="next" type="button">Next (Right)</button>
 </div>
 <audio id="play" controls hidden></audio>
 <p class="note" id="msg">Read at a relaxed pace. Small stumbles are fine, just pause and repeat the sentence. Each take replaces the last one for that scene.</p>
</main></div>
<script>
const DATA = __DATA__;
const $ = s => document.querySelector(s);
let i = 0, rec = null, chunks = [], t0 = 0, tick = null, stream = null, analyser = null;
$("#epname").textContent = DATA.title;
function fmt(s){return Math.floor(s/60)+":"+String(Math.floor(s%60)).padStart(2,"0")}
function drawList(){
  $("#list").innerHTML = DATA.items.map((it,k)=>`<button type="button" data-k="${k}" aria-current="${k===i}"><span>${it.label}</span><span class="st ${it.done?"ok":""}">${it.done?"done":"todo"}</span></button>`).join("");
  document.querySelectorAll("#list button").forEach(b=>b.onclick=()=>go(+b.dataset.k));
}
function go(k){ if(rec) return; i=Math.max(0,Math.min(DATA.items.length-1,k)); const it=DATA.items[i];
  $("#where").textContent = `${i+1} of ${DATA.items.length}  /  saves as ${it.file}`;
  $("#script").innerHTML = it.text.map(s=>`<span class="s">${s}</span>`).join("");
  const a=$("#play"); if(it.done){a.src=`/take/${DATA.ep}/${it.file}?t=${Date.now()}`;a.hidden=false}else{a.hidden=true}
  drawList(); window.scrollTo({top:0}); }
async function mic(){ if(stream) return;
  stream = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false,channelCount:1}});
  const ctx=new AudioContext(); analyser=ctx.createAnalyser(); analyser.fftSize=1024; ctx.createMediaStreamSource(stream).connect(analyser);
  const buf=new Float32Array(analyser.fftSize);
  (function loop(){analyser.getFloatTimeDomainData(buf);let p=0;for(const v of buf)p=Math.max(p,Math.abs(v));$("#lvl").style.width=Math.min(100,p*140)+"%";$("#lvl").style.background=p>0.95?"var(--rec)":"var(--ok)";requestAnimationFrame(loop)})();
}
async function toggle(){
  if(!rec){
    try{ await mic(); }catch(e){ $("#msg").textContent="Microphone blocked. Allow mic access for localhost in the browser address bar, then try again."; return; }
    chunks=[]; rec=new MediaRecorder(stream,{mimeType:MediaRecorder.isTypeSupported("audio/webm;codecs=opus")?"audio/webm;codecs=opus":""});
    rec.ondataavailable=e=>chunks.push(e.data); rec.onstop=save; rec.start();
    t0=performance.now(); tick=setInterval(()=>$("#timer").textContent=fmt((performance.now()-t0)/1000),200);
    $("#recbtn").textContent="Stop (Space)"; $("#recbtn").classList.add("rec"); $("#msg").textContent="Recording. Leave a one second pause before you start talking.";
  } else { rec.stop(); clearInterval(tick); }
}
async function save(){
  const blob=new Blob(chunks,{type:"audio/webm"}); const it=DATA.items[i]; rec=null;
  $("#recbtn").textContent="Record (Space)"; $("#recbtn").classList.remove("rec");
  const r=await fetch(`/save/${DATA.ep}/${it.file}`,{method:"POST",body:blob});
  if(r.ok){ it.done=true; $("#msg").textContent=`Saved ${it.file}. Listen back, then press Right for the next scene.`; go(i); }
  else { $("#msg").textContent="Save failed. Is voice_kit.py still running in the terminal?"; }
}
$("#recbtn").onclick=toggle; $("#prev").onclick=()=>go(i-1); $("#next").onclick=()=>go(i+1);
addEventListener("keydown",e=>{ if(e.target.tagName==="BUTTON"&&e.code==="Space"){e.preventDefault();toggle();return}
  if(e.code==="Space"){e.preventDefault();toggle()} else if(e.code==="ArrowRight")go(i+1); else if(e.code==="ArrowLeft")go(i-1); });
go(0);
</script></body></html>"""


def readable(t):
    """Expand units so the script reads naturally aloud. Acronyms stay as written."""
    sys.path.insert(0, str(VID))
    from make_video import SPOKEN
    for a, b in SPOKEN[:8]:
        t = re.sub(a, b, t)
    return t


def sentences(t):
    t = readable(" ".join(t.split()))
    return [s for s in re.split(r"(?<=[.!?])\s+", t) if s]


def items_for(args):
    if args.reference:
        return "my_voice", "Voice reference", [{"label": "Reference passage", "file": "reference_raw.webm", "text": sentences(REFERENCE_TEXT)}]
    ep = yaml.safe_load(Path(args.episode).read_text())
    items = [{"label": s.get("chapter") or s["id"], "file": f"{s['id']}.webm", "text": sentences(s.get("narration", ""))} for s in ep["scenes"] if s.get("narration")]
    for sh in ep.get("shorts", []):  # hook and outro lines that only appear in Shorts
        if sh.get("hook", {}).get("say"):
            items.append({"label": f"Short hook: {sh['id']}", "file": f"{sh['id']}_hook.webm", "text": sentences(sh["hook"]["say"])})
        if sh.get("outro"):
            items.append({"label": f"Short outro: {sh['id']}", "file": f"{sh['id']}_outro.webm", "text": sentences(sh["outro"])})
    return ep["id"], ep["title"], items


def folder(ep):
    return MYV if ep == "my_voice" else REC / ep


def record(args):
    ep, title, items = items_for(args)
    d = folder(ep); d.mkdir(parents=True, exist_ok=True)
    for it in items:
        it["done"] = (d / it["file"]).exists()
    html = PAGE.replace("__DATA__", json.dumps({"ep": ep, "title": title, "items": items}))

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _file(self):
            parts = urlparse(self.path).path.strip("/").split("/")
            if len(parts) != 3 or parts[1] != ep or not re.fullmatch(r"[\w\-]+\.webm", parts[2]):
                return None
            return folder(ep) / parts[2]

        def do_GET(self):
            if self.path in ("/", "/index.html"):
                body = html.encode(); ctype = "text/html; charset=utf-8"
            elif self.path.startswith("/take/") and (f := self._file()) and f.exists():
                body = f.read_bytes(); ctype = "audio/webm"
            else:
                self.send_response(404); self.end_headers(); return
            self.send_response(200); self.send_header("Content-Type", ctype); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

        def do_POST(self):
            f = self._file() if self.path.startswith("/save/") else None
            if not f:
                self.send_response(400); self.end_headers(); return
            f.write_bytes(self.rfile.read(int(self.headers["Content-Length"])))
            print("  saved", f.relative_to(VID.parent))
            self.send_response(200); self.end_headers()

    srv = ThreadingHTTPServer(("127.0.0.1", args.port), H)
    url = f"http://localhost:{args.port}"
    print(f"Narration booth for '{title}' at {url}  (Ctrl+C when finished)")
    print(f"Takes save to {d.relative_to(VID.parent)}/")
    threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    if ep == "my_voice":
        print("Next: python video/voice_kit.py reference")
    else:
        print(f"Next: python video/make_video.py {args.episode} --tts own")


def reference(args):
    src = Path(args.file) if args.file else MYV / "reference_raw.webm"
    if not src.exists():
        sys.exit(f"No recording at {src}. Run: python video/voice_kit.py record --reference")
    MYV.mkdir(exist_ok=True)
    clean = MYV / "reference_clean.wav"
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(src), "-ac", "1", "-ar", "24000", "-af",
                    "highpass=f=70,afftdn=nf=-25,silenceremove=start_periods=1:start_threshold=-45dB:stop_periods=-1:stop_threshold=-45dB:stop_duration=0.6,loudnorm=I=-18:TP=-2",
                    str(clean)], check=True)
    total = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(clean)], capture_output=True, text=True).stdout)
    length = min(args.seconds, total)
    start = max(0.0, min(2.0, total - length))
    out = MYV / "reference.wav"
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-ss", f"{start:.2f}", "-t", f"{length:.2f}", "-i", str(clean), "-af", "afade=t=in:d=0.05,areverse,afade=t=in:d=0.2,areverse", str(out)], check=True)
    print(f"Reference ready: {out.relative_to(VID.parent)} ({length:.0f} s of {total:.0f} s recorded)")
    if total < 12:
        print("  ! Under 12 s of speech. Re-record the full passage for a better clone.")
    print("Next: pip install chatterbox-tts, then python video/make_video.py <episode.yaml> --tts clone")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("record", help="teleprompter recording booth in your browser")
    r.add_argument("episode", nargs="?")
    r.add_argument("--reference", action="store_true", help="record the voice cloning reference passage")
    r.add_argument("--port", type=int, default=8800)
    f = sub.add_parser("reference", help="clean the reference recording for cloning")
    f.add_argument("file", nargs="?")
    f.add_argument("--seconds", type=float, default=20)
    a = ap.parse_args()
    if a.cmd == "record":
        if not a.reference and not a.episode:
            sys.exit("Give an episode yaml, or --reference")
        record(a)
    else:
        reference(a)


if __name__ == "__main__":
    main()
