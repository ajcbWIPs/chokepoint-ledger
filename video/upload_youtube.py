#!/usr/bin/env python3
"""
Optional: upload a rendered episode to YouTube with the free YouTube Data API.
Uploads as PRIVATE by default so you can review it in YouTube Studio before publishing.

One-time setup (free):
  1. console.cloud.google.com > new project > enable "YouTube Data API v3"
  2. OAuth consent screen (External, add yourself as a test user)
  3. Credentials > Create OAuth client ID > Desktop app > download as video/client_secret.json
  4. pip install google-api-python-client google-auth-oauthlib

Usage:
  python video/upload_youtube.py video/out/ep01_chokepoints                       # long video + captions
  python video/upload_youtube.py video/out/ep01_chokepoints --short short_sulphur # a Short
The default quota allows about 6 uploads a day.
"""
import argparse, json
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCOPES = ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.force-ssl"]


def client():
    from google_auth_oauthlib.flow import InstalledAppFlow
    from google.oauth2.credentials import Credentials
    from google.auth.transport.requests import Request
    from googleapiclient.discovery import build
    tok = HERE / "token.json"
    creds = Credentials.from_authorized_user_file(str(tok), SCOPES) if tok.exists() else None
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            creds = InstalledAppFlow.from_client_secrets_file(str(HERE / "client_secret.json"), SCOPES).run_local_server(port=0)
        tok.write_text(creds.to_json())
    return build("youtube", "v3", credentials=creds)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("folder")
    ap.add_argument("--short", help="basename of a short, e.g. short_sulphur")
    ap.add_argument("--privacy", default="private", choices=["private", "unlisted", "public"])
    ap.add_argument("--category", default="27", help="27 = Education")
    args = ap.parse_args()
    from googleapiclient.http import MediaFileUpload

    folder = Path(args.folder)
    meta = json.loads((folder / "youtube_meta.json").read_text())
    if args.short:
        lines = (folder / f"{args.short}.txt").read_text().split("\n\n", 1)
        title, desc, file, srt = lines[0], lines[1] if len(lines) > 1 else "", folder / f"{args.short}.mp4", folder / f"{args.short}.srt"
    else:
        title, desc = meta["title"], (folder / meta["description_file"]).read_text()
        file, srt = folder / "long.mp4", folder / meta["captions"]

    yt = client()
    body = {"snippet": {"title": title[:100], "description": desc[:5000], "tags": meta.get("tags", []), "categoryId": args.category},
            "status": {"privacyStatus": args.privacy, "selfDeclaredMadeForKids": False}}
    req = yt.videos().insert(part="snippet,status", body=body, media_body=MediaFileUpload(str(file), chunksize=-1, resumable=True))
    resp = None
    while resp is None:
        status, resp = req.next_chunk()
        if status:
            print(f"  uploaded {int(status.progress() * 100)}%")
    vid = resp["id"]
    print(f"Uploaded: https://youtu.be/{vid} ({args.privacy})")
    if srt.exists():
        yt.captions().insert(part="snippet", body={"snippet": {"videoId": vid, "language": "en", "name": "English"}},
                             media_body=MediaFileUpload(str(srt))).execute()
        print("Captions attached.")


if __name__ == "__main__":
    main()
