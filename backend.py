"""
mymusic — backend unifié
Fusionne : chat agent, download, upload MP3
Lance avec : python backend.py
Écoute sur http://localhost:5001
"""

from http.server import HTTPServer, BaseHTTPRequestHandler
import subprocess
import json
import urllib.request
import os
import re

BASE_DIR  = os.path.dirname(os.path.abspath(__file__))
MUSIC_DIR = "/volume1/music/mymusic"   # NAS Synology

# ══════════════════════════════════════════════════════════
#  CONFIG — colle ta clé API ici (ou utilise une variable
#  d'environnement : export ANTHROPIC_API_KEY="sk-ant-...")
# ══════════════════════════════════════════════════════════

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "REMPLACE_PAR_TA_CLE")


# ══════════════════════════════════════════════════════════
#  CLAUDE HAIKU  (remplace Ollama/Mistral)
# ══════════════════════════════════════════════════════════

def extract_song_info(user_input):
    """Appelle Claude Haiku pour extraire titre + artiste depuis la requête."""
    payload = json.dumps({
        "model": "claude-haiku-4-5-20251001",
        "max_tokens": 200,
        "messages": [
            {
                "role": "user",
                "content": (
                    "L'utilisateur veut télécharger une chanson. "
                    "Extrait le titre et l'artiste. "
                    "Réponds UNIQUEMENT en JSON avec ce format exact : "
                    '{"titre": "...", "artiste": "..."}\n'
                    f"Requête : {user_input}"
                )
            }
        ]
    }).encode("utf-8")

    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=payload,
        headers={
            "Content-Type":      "application/json",
            "x-api-key":         ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01"
        }
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        result = json.loads(resp.read())

    text = result["content"][0]["text"].strip()
    # Extraction robuste du JSON même si Haiku ajoute du texte autour
    start = text.find("{")
    end   = text.rfind("}") + 1
    return json.loads(text[start:end])


# ══════════════════════════════════════════════════════════
#  PREVIEWS YouTube + SoundCloud
# ══════════════════════════════════════════════════════════

def _parse_results(raw_output, artiste, source):
    previews = []
    for line in raw_output.strip().splitlines():
        if not line.strip():
            continue
        try:
            data = json.loads(line)
            duree_sec = int(data.get("duration", 0))
            m, s = divmod(duree_sec, 60)
            previews.append({
                "titre":     data.get("title", ""),
                "artiste":   artiste,
                "channel":   data.get("channel") or data.get("uploader", "Inconnu"),
                "thumbnail": data.get("thumbnail", ""),
                "duree_str": f"{m}:{s:02d}",
                "duree_sec": duree_sec,
                "url":       data.get("webpage_url", ""),
                "source":    source
            })
        except Exception:
            continue
    return previews


def get_previews(titre, artiste, n=3):
    query = f"{titre} {artiste}"
    yt = subprocess.run([
        "yt-dlp", "--dump-json", "--no-playlist",
        f"ytsearch{n}:{query} official audio"
    ], capture_output=True, text=True)
    sc = subprocess.run([
        "yt-dlp", "--dump-json", "--no-playlist",
        f"scsearch{n}:{query}"
    ], capture_output=True, text=True)
    previews  = _parse_results(yt.stdout, artiste, "youtube")
    previews += _parse_results(sc.stdout, artiste, "soundcloud")
    return previews


# ══════════════════════════════════════════════════════════
#  MULTIPART PARSER (sans module cgi, compatible Python 3.13+)
# ══════════════════════════════════════════════════════════

def parse_multipart(data: bytes, boundary: bytes):
    parts = {}
    delimiter = b"--" + boundary
    for seg in data.split(delimiter):
        if seg in (b"", b"--\r\n", b"--"):
            continue
        if b"\r\n\r\n" not in seg:
            continue
        raw_headers, body = seg.split(b"\r\n\r\n", 1)
        if body.endswith(b"\r\n"):
            body = body[:-2]
        headers_text = raw_headers.decode("utf-8", errors="replace")
        disp_match = re.search(r'Content-Disposition:[^\r\n]*', headers_text, re.IGNORECASE)
        if not disp_match:
            continue
        disp = disp_match.group(0)
        name_m     = re.search(r'name="([^"]+)"',     disp)
        filename_m = re.search(r'filename="([^"]+)"', disp)
        name     = name_m.group(1)     if name_m     else None
        filename = filename_m.group(1) if filename_m else None
        if name:
            parts[name] = {"body": body, "filename": filename}
    return parts


# ══════════════════════════════════════════════════════════
#  HANDLER HTTP
# ══════════════════════════════════════════════════════════

class Handler(BaseHTTPRequestHandler):

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin",  "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    # ── GET ────────────────────────────────────────────────
    def do_GET(self):
        if self.path in ("/", "/index.html"):
            self._serve_file("index.html", "text/html; charset=utf-8")
        else:
            self._json(404, {"error": "Route inconnue"})

    def _serve_file(self, filename, content_type):
        path = os.path.join(BASE_DIR, filename)
        try:
            with open(path, "rb") as f:
                content = f.read()
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(content)))
            self._cors()
            self.end_headers()
            self.wfile.write(content)
        except FileNotFoundError:
            self._json(404, {"error": f"{filename} introuvable"})

    # ── POST ───────────────────────────────────────────────
    def do_POST(self):
        if self.path == "/chat":
            length = int(self.headers.get("Content-Length", 0))
            body   = json.loads(self.rfile.read(length)) if length else {}
            self._handle_chat(body)

        elif self.path == "/download":
            length = int(self.headers.get("Content-Length", 0))
            body   = json.loads(self.rfile.read(length)) if length else {}
            self._handle_download(body)

        elif self.path == "/upload":
            self._handle_upload()

        else:
            self._json(404, {"error": "Route inconnue"})

    # ── /chat ──────────────────────────────────────────────
    def _handle_chat(self, body):
        messages   = body.get("messages", [])
        user_input = messages[-1]["content"] if messages else ""
        try:
            info     = extract_song_info(user_input)
            previews = get_previews(info["titre"], info["artiste"], n=3)
            if not previews:
                self._json(200, {"action": "error", "message": "Aucun résultat trouvé."})
                return
            yt_n = sum(1 for p in previews if p["source"] == "youtube")
            sc_n = sum(1 for p in previews if p["source"] == "soundcloud")
            sources = []
            if yt_n: sources.append(f"{yt_n} YouTube")
            if sc_n: sources.append(f"{sc_n} SoundCloud")
            msg = f"J'ai trouvé {len(previews)} résultat(s) ({' · '.join(sources)}) — choisis le bon morceau :"
            self._json(200, {"action": "confirm", "message": msg, "previews": previews})
        except Exception as e:
            self._json(500, {"action": "error", "message": f"Erreur : {e}"})

    # ── /download ──────────────────────────────────────────
    def _handle_download(self, body):
        url     = body.get("url", "")
        titre   = body.get("titre", "")
        artiste = body.get("artiste", "")
        if not url:
            self._json(400, {"status": "error", "message": "URL manquante"})
            return
        os.makedirs(MUSIC_DIR, exist_ok=True)
        subprocess.Popen([
            "yt-dlp", "-x",
            "--audio-format",      "mp3",
            "--audio-quality",     "0",
            "--embed-thumbnail",
            "--convert-thumbnails","jpg",
            "--add-metadata",
            "--parse-metadata", f":{titre}:%(meta_title)s",
            "--parse-metadata", f":{artiste}:%(meta_artist)s",
            "--parse-metadata", f":{artiste}:%(meta_album_artist)s",
            "-o", f"{MUSIC_DIR}/{artiste} - %(title)s.%(ext)s",
            url
        ])
        self._json(200, {"status": "ok", "titre": titre, "artiste": artiste})

    # ── /upload ────────────────────────────────────────────
    def _handle_upload(self):
        content_type = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in content_type:
            self._text(400, "Expected multipart/form-data")
            return
        boundary_m = re.search(r'boundary=([^\s;]+)', content_type)
        if not boundary_m:
            self._text(400, "Missing boundary")
            return
        boundary = boundary_m.group(1).encode()
        length   = int(self.headers.get("Content-Length", 0))
        raw      = self.rfile.read(length)
        parts    = parse_multipart(raw, boundary)
        fp       = parts.get("file")
        if not fp or not fp.get("filename"):
            self._text(400, "No file found in request")
            return
        filename = os.path.basename(fp["filename"])
        if not filename.lower().endswith(".mp3"):
            self._text(400, "Only .mp3 files are accepted")
            return
        os.makedirs(MUSIC_DIR, exist_ok=True)
        dest = os.path.join(MUSIC_DIR, filename)
        with open(dest, "wb") as f:
            f.write(fp["body"])
        print(f"[upload] {filename} → {dest}")
        self._text(200, f"Uploaded: {filename}")

    # ── helpers ────────────────────────────────────────────
    def _json(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type",   "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _text(self, code, message):
        body = message.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type",   "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        print(f"  {self.address_string()} — {fmt % args}")


# ══════════════════════════════════════════════════════════
#  LANCEMENT
# ══════════════════════════════════════════════════════════

if __name__ == "__main__":
    server = HTTPServer(("127.0.0.1", 5001), Handler)
    print("✅  mymusic backend unifié démarré")
    print("    → Chat    : POST /chat")
    print("    → Download: POST /download")
    print("    → Upload  : POST /upload  (MP3 → NAS)")
    print("    → UI      : http://localhost:5001")
    print("    Ctrl+C pour quitter\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServeur arrêté.")
        server.server_close()
