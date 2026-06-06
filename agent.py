import subprocess
import json
import urllib.request
import threading
import webbrowser
import os
from flask import Flask, request, jsonify

MUSIC_FOLDER = r"C:\Users\Etudiant\Music\mymusic\fichiers"

# --- Mistral ---

def ask_mistral(prompt):
    data = json.dumps({
        "model": "mistral",
        "prompt": prompt,
        "stream": False
    }).encode("utf-8")
    req = urllib.request.Request(
        "http://localhost:11434/api/generate",
        data=data,
        headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req) as response:
        result = json.loads(response.read())
        return result["response"].strip()

def extract_song_info(user_input):
    prompt = f"""L'utilisateur veut télécharger une chanson. Extrait le titre et l'artiste.
Réponds UNIQUEMENT en JSON avec ce format exact : {{"titre": "...", "artiste": "..."}}
Requête : {user_input}"""
    response = ask_mistral(prompt)
    start = response.find("{")
    end = response.rfind("}") + 1
    return json.loads(response[start:end])

# --- YouTube : récupère les infos SANS télécharger ---

def get_song_preview(titre, artiste):
    query = f"{titre} {artiste} official audio"
    result = subprocess.run([
        "yt-dlp",
        "--dump-json",
        "--no-playlist",
        f"ytsearch1:{query}"
    ], capture_output=True, text=True)
    data = json.loads(result.stdout)
    return {
        "titre": data.get("title", "Inconnu"),
        "duree": data.get("duration", 0),          # en secondes
        "thumbnail": data.get("thumbnail", ""),
        "url": data.get("webpage_url", ""),
        "channel": data.get("channel", "Inconnu")
    }

def format_duree(secondes):
    m, s = divmod(int(secondes), 60)
    return f"{m}:{s:02d}"

# --- Serveur Flask de confirmation ---

app = Flask(__name__)
confirmation_event = threading.Event()
confirmation_result = {"ok": False}

HTML_PAGE = """
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <title>mymusic — Confirmation</title>
  <style>
    * {{ box-sizing: border-box; margin: 0; padding: 0; }}
    body {{
      background: #0f0f0f;
      color: white;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
    }}
    .card {{
      background: #1a1a1a;
      border-radius: 16px;
      padding: 32px;
      width: 380px;
      text-align: center;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    }}
    .cover {{
      width: 240px;
      height: 240px;
      object-fit: cover;
      border-radius: 12px;
      margin-bottom: 20px;
    }}
    .titre {{ font-size: 18px; font-weight: 700; margin-bottom: 6px; }}
    .channel {{ font-size: 13px; color: #aaa; margin-bottom: 6px; }}
    .duree {{
      display: inline-block;
      background: #2a2a2a;
      border-radius: 20px;
      padding: 4px 14px;
      font-size: 13px;
      color: #ccc;
      margin-bottom: 28px;
    }}
    .warning {{ color: #ff6b6b; font-size: 12px; margin-bottom: 20px; }}
    .buttons {{ display: flex; gap: 12px; justify-content: center; }}
    button {{
      flex: 1;
      padding: 12px;
      border: none;
      border-radius: 10px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.2s;
    }}
    button:hover {{ opacity: 0.85; }}
    .btn-ok {{ background: #1db954; color: white; }}
    .btn-cancel {{ background: #333; color: #ccc; }}
    .done {{ font-size: 22px; margin-top: 10px; }}
  </style>
</head>
<body>
  <div class="card" id="card">
    <img class="cover" src="{thumbnail}" onerror="this.src='https://via.placeholder.com/240x240/1a1a1a/555?text=🎵'">
    <div class="titre">{titre}</div>
    <div class="channel">{channel}</div>
    <div class="duree">⏱ {duree}</div>
    {warning}
    <div class="buttons">
      <button class="btn-ok" onclick="repondre(true)">✅ Télécharger</button>
      <button class="btn-cancel" onclick="repondre(false)">❌ Annuler</button>
    </div>
  </div>
  <script>
    function repondre(ok) {{
      fetch('/reponse', {{
        method: 'POST',
        headers: {{'Content-Type': 'application/json'}},
        body: JSON.stringify({{ok: ok}})
      }}).then(() => {{
        document.getElementById('card').innerHTML =
          ok ? '<div class="done">⬇️ Téléchargement lancé !</div>'
             : '<div class="done">❌ Annulé.</div>';
      }});
    }}
  </script>
</body>
</html>
"""

preview_data = {}

@app.route("/")
def index():
    duree_str = format_duree(preview_data.get("duree", 0))
    duree_sec = int(preview_data.get("duree", 0))
    warning = ""
    if duree_sec > 600:
        warning = f'<div class="warning">⚠️ Durée inhabituelle ({duree_str}) — vérifie que ce n\'est pas un album ou un mix</div>'
    return HTML_PAGE.format(
        thumbnail=preview_data.get("thumbnail", ""),
        titre=preview_data.get("titre", ""),
        channel=preview_data.get("channel", ""),
        duree=duree_str,
        warning=warning
    )

@app.route("/reponse", methods=["POST"])
def reponse():
    data = request.get_json()
    confirmation_result["ok"] = data.get("ok", False)
    confirmation_event.set()
    return jsonify({"status": "ok"})

def lancer_serveur():
    app.run(port=5050, debug=False, use_reloader=False)

# --- Téléchargement ---

def download_song(url):
    subprocess.run([
        "yt-dlp",
        "-x",
        "--audio-format", "mp3",
        "--audio-quality", "0",
        "--embed-thumbnail",
        "--add-metadata",
        "-o", f"{MUSIC_FOLDER}\\%(title)s.%(ext)s",
        url  # on télécharge l'URL exacte trouvée au lieu de chercher à nouveau
    ])

# --- Main ---

def main():
    # Lance le serveur Flask en arrière-plan (une seule fois)
    t = threading.Thread(target=lancer_serveur, daemon=True)
    t.start()

    print("🎵 mymusic agent — tape 'quitter' pour arrêter\n")
    while True:
        user_input = input("Que veux-tu écouter ? → ").strip()
        if user_input.lower() == "quitter":
            break

        print("🤖 Analyse en cours...")
        try:
            info = extract_song_info(user_input)
            print(f"🔍 Recherche : {info['titre']} — {info['artiste']}")

            preview = get_song_preview(info['titre'], info['artiste'])
            preview_data.update(preview)

            # Reset l'événement de confirmation
            confirmation_event.clear()
            confirmation_result["ok"] = False

            # Ouvre le navigateur
            webbrowser.open("http://localhost:5050")
            print("🌐 Vérifie le navigateur et confirme le téléchargement...")

            # Attend la réponse de l'utilisateur
            confirmation_event.wait()

            if confirmation_result["ok"]:
                print("⬇️ Téléchargement en cours...")
                download_song(preview["url"])
                print("✅ Téléchargement terminé !\n")
            else:
                print("❌ Téléchargement annulé.\n")

        except Exception as e:
            print(f"❌ Erreur : {e}\n")

if __name__ == "__main__":
    main()