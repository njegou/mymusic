"""
mymusic — serveur API (recherche, bibliothèque, streaming, upload)
NAS Synology DS218 — Python stdlib uniquement, aucune dépendance à installer.

Lance avec : python3 upload_server.py
Écoute sur http://0.0.0.0:5050

Routes :
  GET  /api/search?q=...&page=0     recherche live, 20 résultats par page (yt-dlp ytsearch, métadonnées seules)
  GET  /api/library                 morceaux réellement téléchargés sur le NAS
  POST /api/library                 { id, title, artist, duration } -> télécharge si absent
  GET  /api/stream/<id>             flux audio (Range supporté, pour le seek du <audio>)
  POST /upload                      upload manuel d'un .mp3 (inchangé)
"""

import os
import json
import hashlib
import random
import string
import subprocess
import threading
import urllib.request
import cgi
import shutil
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote

# ---------------------------------------------------------------------------
# CONFIG — bloc unique à adapter si tu bascules PC <-> NAS
# ---------------------------------------------------------------------------
MUSIC_DIR = "/volume1/music/mymusic"          # NAS. Sur PC : r"C:\Users\Etudiant\Music\mymusic\fichiers"
INDEX_FILE = os.path.join(MUSIC_DIR, "library_index.json")
PORT = 5050

YTDLP_CMD = ["/opt/bin/python3.13", "-m", "yt_dlp"]   # vérifié sur ce NAS le 05/07/2026
FFMPEG_BIN = "ffmpeg"   # doit être dans le PATH, yt-dlp l'appelle en interne

NAVIDROME_URL = "http://localhost:4533"
NAVIDROME_USER = "admin"              # <-- ton compte Navidrome
NAVIDROME_PASSWORD = "CHANGE_ME"      # <-- ton mot de passe Navidrome

SEARCH_TIMEOUT_SEC = 45
DOWNLOAD_TIMEOUT_SEC = 180

# Un seul process yt-dlp à la fois (recherche OU téléchargement) — protège
# les 512 Mo de RAM du DS218 des risques d'OOM en cas de requêtes concurrentes.
YTDLP_LOCK = threading.Lock()
INDEX_LOCK = threading.Lock()


# ---------------------------------------------------------------------------
# Index de bibliothèque — simple fichier JSON à côté des mp3
# { "<youtube_id>": { id, title, artist, duration, filename } }
# ---------------------------------------------------------------------------
def load_index():
    with INDEX_LOCK:
        if not os.path.isfile(INDEX_FILE):
            return {}
        with open(INDEX_FILE, "r", encoding="utf-8") as f:
            try:
                return json.load(f)
            except json.JSONDecodeError:
                return {}


def save_index(index):
    with INDEX_LOCK:
        with open(INDEX_FILE, "w", encoding="utf-8") as f:
            json.dump(index, f, ensure_ascii=False, indent=2)


# ---------------------------------------------------------------------------
# Navidrome / Subsonic — même pattern d'auth MD5 que le reste du projet
# ---------------------------------------------------------------------------
def subsonic_params():
    salt = "".join(random.choices(string.ascii_letters + string.digits, k=6))
    token = hashlib.md5((NAVIDROME_PASSWORD + salt).encode()).hexdigest()
    return f"u={NAVIDROME_USER}&t={token}&s={salt}&v=1.16.1&c=mymusic&f=json"


def trigger_navidrome_scan():
    try:
        url = f"{NAVIDROME_URL}/rest/startScan?{subsonic_params()}"
        urllib.request.urlopen(url, timeout=10)
    except Exception as e:
        print(f"[WARN] Scan Navidrome échoué : {e}")


# ---------------------------------------------------------------------------
# yt-dlp — recherche (métadonnées seules) et téléchargement
# ---------------------------------------------------------------------------
def yt_search(query, page=0, page_size=20):
    start = page * page_size + 1
    end = (page + 1) * page_size
    cmd = YTDLP_CMD + [
        f"ytsearch{end}:{query}",
        "--playlist-start", str(start), "--playlist-end", str(end),
        "--flat-playlist", "--dump-json", "--no-warnings",
    ]
    with YTDLP_LOCK:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=SEARCH_TIMEOUT_SEC)

    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip()[:300] or "yt-dlp a échoué")

    results = []
    for line in result.stdout.strip().split("\n"):
        if not line:
            continue
        data = json.loads(line)
        results.append({
            "id": data.get("id"),
            "title": data.get("title") or "Titre inconnu",
            "artist": data.get("uploader") or data.get("channel") or "Inconnu",
            "duration": int(data.get("duration") or 0),
        })
    return results


def download_track(track_id, title, artist, duration):
    index = load_index()
    if track_id in index:
        return index[track_id]  # déjà téléchargé, rien à refaire

    url = f"https://www.youtube.com/watch?v={track_id}"
    out_template = os.path.join(MUSIC_DIR, "%(id)s.%(ext)s")
    cmd = YTDLP_CMD + [
        url,
        "-x", "--audio-format", "mp3", "--audio-quality", "0",
        "--embed-thumbnail", "--convert-thumbnails", "jpg", "--embed-metadata",
        "-o", out_template, "--no-warnings",
    ]

    os.makedirs(MUSIC_DIR, exist_ok=True)
    with YTDLP_LOCK:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=DOWNLOAD_TIMEOUT_SEC)

    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip()[:300] or "Échec du téléchargement")

    filename = f"{track_id}.mp3"
    filepath = os.path.join(MUSIC_DIR, filename)
    if not os.path.isfile(filepath):
        raise RuntimeError("Fichier introuvable après téléchargement")

    entry = {
        "id": track_id,
        "title": title or "Titre inconnu",
        "artist": artist or "Inconnu",
        "duration": int(duration or 0),
        "filename": filename,
    }
    index[track_id] = entry
    save_index(index)
    trigger_navidrome_scan()
    return entry


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------
class MymusicHandler(BaseHTTPRequestHandler):

    # --- CORS -----------------------------------------------------------
    def do_OPTIONS(self):
        self.send_cors_headers(200)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def send_cors_headers(self, code):
        self.send_response(code)
        self.send_header("Access-Control-Allow-Origin", "*")

    # --- GET --------------------------------------------------------------
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)

        if path == "/api/search":
            q = (qs.get("q", [""])[0]).strip()
            if not q:
                self.respond_json(200, [])
                return
            try:
                page = int(qs.get("page", ["0"])[0])
            except ValueError:
                page = 0
            try:
                self.respond_json(200, yt_search(q, page=page))
            except Exception as e:
                self.respond_json(500, {"error": str(e)})
            return

        if path == "/api/library":
            self.respond_json(200, list(load_index().values()))
            return

        if path.startswith("/api/stream/"):
            track_id = unquote(path[len("/api/stream/"):])
            self.handle_stream(track_id)
            return

        self.respond(404, "Not found")

    def handle_stream(self, track_id):
        entry = load_index().get(track_id)
        if not entry:
            self.respond(404, "Morceau absent de la bibliothèque")
            return

        filepath = os.path.join(MUSIC_DIR, entry["filename"])
        if not os.path.isfile(filepath):
            self.respond(404, "Fichier manquant sur le disque")
            return

        file_size = os.path.getsize(filepath)
        start, end, status = 0, file_size - 1, 200

        range_header = self.headers.get("Range")
        if range_header:
            status = 206
            range_value = range_header.replace("bytes=", "")
            start_str, _, end_str = range_value.partition("-")
            start = int(start_str) if start_str else 0
            end = int(end_str) if end_str else file_size - 1

        length = end - start + 1

        self.send_cors_headers(status)
        self.send_header("Content-Type", "audio/mpeg")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
        self.end_headers()

        with open(filepath, "rb") as f:
            f.seek(start)
            remaining = length
            chunk_size = 65536
            while remaining > 0:
                chunk = f.read(min(chunk_size, remaining))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    break  # l'utilisateur a coupé la lecture / changé de morceau
                remaining -= len(chunk)

    # --- POST ---------------------------------------------------------------
    def do_POST(self):
        if self.path == "/upload":
            self.handle_upload()
            return

        if self.path == "/api/library":
            self.handle_library_post()
            return

        self.respond(404, "Not found")

    def handle_library_post(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length))
            track_id = body["id"]
            entry = download_track(
                track_id,
                body.get("title"),
                body.get("artist"),
                body.get("duration"),
            )
            self.respond_json(200, entry)
        except Exception as e:
            self.respond_json(500, {"error": str(e)})

    def handle_upload(self):
        content_type = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in content_type:
            self.respond(400, "Expected multipart/form-data")
            return

        form = cgi.FieldStorage(
            fp=self.rfile,
            headers=self.headers,
            environ={"REQUEST_METHOD": "POST", "CONTENT_TYPE": content_type},
        )

        file_field = form.get("file")
        if not file_field or not hasattr(file_field, "filename") or not file_field.filename:
            self.respond(400, "No file found in request")
            return

        filename = os.path.basename(file_field.filename)
        if not filename.lower().endswith(".mp3"):
            self.respond(400, "Only .mp3 files are accepted")
            return

        dest = os.path.join(MUSIC_DIR, filename)
        os.makedirs(MUSIC_DIR, exist_ok=True)

        with open(dest, "wb") as f:
            shutil.copyfileobj(file_field.file, f)

        print(f"[OK] {filename} → {dest}")
        self.respond(200, f"Uploaded: {filename}")

    # --- Helpers de réponse ----------------------------------------------
    def respond(self, code, message):
        body = message.encode("utf-8")
        self.send_cors_headers(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def respond_json(self, code, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_cors_headers(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        print(f"[{self.address_string()}] {fmt % args}")


if __name__ == "__main__":
    os.makedirs(MUSIC_DIR, exist_ok=True)
    server = ThreadingHTTPServer(("0.0.0.0", PORT), MymusicHandler)
    print(f"mymusic API → http://0.0.0.0:{PORT}")
    print(f"Dossier musique : {MUSIC_DIR}")
    print("Ctrl+C pour arrêter.\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServeur arrêté.")
