# mymusic — catalogue à la demande (frontend)

Frontend statique déployé sur GitHub Pages (`njegou.github.io/mymusic/`),
branché sur un backend fixe (aucun champ à remplir dans l'UI — l'URL est
posée une fois dans `app.js`).

## Backend

Le code du backend est `upload_server.py` (extension de celui que tu avais
déjà) — trois routes ajoutées à côté de `/upload` :

```
GET  /api/search?q=texte        recherche live (yt-dlp ytsearch, rien stocké)
GET  /api/library                morceaux déjà téléchargés sur le NAS
POST /api/library  { id, title, artist, duration }  télécharge si absent
GET  /api/stream/:id             flux audio, avec support du Range (seek)
```

Tourne sur le port 5050, comme avant. Un seul process `yt-dlp` à la fois
(recherche ou téléchargement, jamais les deux en parallèle) pour protéger
les 512 Mo de RAM du DS218.

### Config à éditer avant de lancer

En haut de `upload_server.py` :

```python
MUSIC_DIR = "/volume1/music/mymusic"
NAVIDROME_USER = "admin"
NAVIDROME_PASSWORD = "CHANGE_ME"   # <-- ton vrai mot de passe Navidrome
```

### Lancer sur le NAS (même pattern que Navidrome/cloudflared)

```sh
nohup python3 /volume1/homes/Nicolas/upload_server.py >> /volume1/homes/Nicolas/mymusic-api.log 2>&1 & disown
```

À ajouter en tâche déclenchée au démarrage dans DSM Task Scheduler, comme
pour Navidrome et cloudflared, avec `>>` pour garder l'historique des logs.

## Exposer le port 5050 publiquement (tunnel Cloudflare)

Ton tunnel actuel route `navidrome.mymusic-nj.com` vers le port 4533. Il
faut ajouter un deuxième hostname public pour le port 5050, dans
`/volume1/homes/Nicolas/.cloudflared/config.yml` :

```yaml
ingress:
  - hostname: navidrome.mymusic-nj.com
    service: http://localhost:4533
  - hostname: api.mymusic-nj.com
    service: http://localhost:5050
  - service: http_status:404
```

Puis dans Cloudflare Dashboard → DNS, ajouter un enregistrement CNAME
`api.mymusic-nj.com` pointant vers ton tunnel (`<tunnel-id>.cfargotunnel.com`),
comme pour `navidrome.mymusic-nj.com`. Redémarrer `cloudflared` (ou attendre
le prochain boot si tu relances la tâche DSM).

Si tu choisis un autre nom que `api.mymusic-nj.com`, mets-le à jour dans
`app.js` :

```js
const API_BASE = "https://ton-hostname-choisi.com";
```

## Sur "brancher YouTube / SoundCloud / Apple Music / Spotify"

YouTube via ton propre pipeline `yt-dlp` reste dans le même cadre que ton
projet actuel (perso, sur ton NAS). Un système qui irait chercher les
morceaux complets sur Spotify ou Apple Music sans passer par leurs SDK
officiels contournerait leurs protections — ce n'est pas quelque chose que
je construis. Pistes légitimes si tu veux enrichir le catalogue au-delà de
YouTube : iTunes Search API (previews Apple Music, publique, sans clé) et
Spotify Web API en mode Client Credentials (recherche + previews 30s).

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

upload_server.py  backend NAS (recherche, bibliothèque, stream, upload)
```
