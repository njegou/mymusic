# mymusic — catalogue à la demande (frontend)

Frontend statique zéro-configuration : `index.html` / `style.css` / `app.js`
sont prévus pour être servis **depuis le même domaine que ton API** (ton
tunnel Cloudflare `navidrome.mymusic-nj.com`), pas sur GitHub Pages. Comme ça,
les appels `fetch('/api/...')` sont relatifs — rien à saisir, rien à régler.

## Pourquoi pas GitHub Pages pour héberger le frontend

GitHub Pages te donne un domaine `*.github.io` différent de ton NAS. Un
frontend hébergé là-bas devrait connaître l'URL de ton API (d'où le champ
qu'on avait ajouté puis retiré) et ton backend devrait gérer le CORS.
En servant les 3 fichiers directement depuis le NAS, tout ça disparaît.

## Comment servir le frontend depuis le NAS (zéro-config, sans Docker)

Le plus simple avec les contraintes du DS218 (pas de nginx, pas de Docker) :
étendre le petit serveur Python que tu as déjà pour `/api/*` afin qu'il serve
aussi ces 3 fichiers statiques. Avec `http.server` stdlib :

```python
# à ajouter à côté de tes handlers /api/search, /api/library, /api/stream
import os

STATIC_DIR = "/volume1/homes/Nicolas/mymusic-stream"  # ce dossier

def do_GET(self):
    if self.path.startswith("/api/"):
        return self.handle_api()  # ta logique existante

    path = self.path.split("?")[0]
    if path == "/":
        path = "/index.html"
    filepath = os.path.join(STATIC_DIR, path.lstrip("/"))
    if os.path.isfile(filepath):
        self.send_response(200)
        content_type = {
            ".html": "text/html", ".css": "text/css", ".js": "application/javascript"
        }.get(os.path.splitext(filepath)[1], "application/octet-stream")
        self.send_header("Content-Type", content_type)
        self.end_headers()
        with open(filepath, "rb") as f:
            self.wfile.write(f.read())
    else:
        self.send_response(404)
        self.end_headers()
```

Puis copier ce dossier sur le NAS (`scp` ou `git clone` direct sur le DS218 si
tu préfères garder GitHub comme source de vérité — le NAS peut très bien
faire un `git pull` périodique) et pointer `STATIC_DIR` dessus. Le tunnel
Cloudflare existant sert alors le site ET l'API sur la même URL.

## Sur "brancher YouTube / SoundCloud / Apple Music / Spotify"

Une nuance importante ici : **YouTube via ton propre pipeline `yt-dlp`**
reste dans le même cadre que ton projet actuel (perso, sur ton NAS). En
revanche, un système qui irait chercher les morceaux complets sur Spotify ou
Apple Music sans passer par leurs SDK officiels (et sans l'abonnement/l'auth
de l'utilisateur) contournerait leurs protections — ce n'est pas quelque
chose que je construis, quel que soit le cadrage.

Ce qui est légitime et que je peux ajouter si tu veux enrichir le catalogue
au-delà de YouTube :
- **iTunes Search API** (Apple) — previews de 30s, publique, sans clé ni auth
- **Spotify Web API** (recherche + preview_url) — publique via
  "Client Credentials", sans compte utilisateur, previews de 30s aussi
- **SoundCloud** — selon les morceaux, certains sont diffusables via leur
  widget officiel

Ce sont des extraits (30s), pas les morceaux complets — mais ça peut suffire
pour identifier/prévisualiser avant de décider quoi télécharger via ton
pipeline YouTube existant.

## Contrat d'API attendu côté NAS (inchangé)

```
GET  /api/search?q=texte        -> [{ id, title, artist, duration }]
GET  /api/library                -> [{ id, title, artist, duration }]
POST /api/library  { id, title, artist, duration }  -> télécharge si absent
GET  /api/stream/:id             -> flux audio (si dans la bibliothèque)
```

## Vues de l'interface

- **Accueil** — les 8 derniers morceaux téléchargés
- **Rechercher** — recherche live (debounce 350ms)
- **Ma bibliothèque** — tout ce qui est réellement stocké sur le NAS

## Fichiers

```
mymusic-stream/
├── index.html   structure de la page
├── style.css    thème navy/violet
├── app.js       état, fetch réseau, lecteur <audio>
└── README.md    ce fichier
```
