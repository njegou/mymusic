# mymusic — catalogue à la demande (frontend)

Squelette statique (HTML/CSS/JS, sans framework) branché sur de vrais appels
réseau vers ton backend NAS — plus de données mock. Prêt pour GitHub Pages.

## Modèle de stockage (confirmé)

- **Recherche** = toujours live, jamais stockée (métadonnées seules, via ton
  pipeline `yt-dlp ytsearch --flat-playlist --dump-json`).
- **Bibliothèque** = uniquement ce qui a été réellement téléchargé sur le NAS.
  Il n'y a plus de distinction "playlist" vs "cache" : ajouter un morceau à la
  bibliothèque = le télécharger (`yt-dlp` + `ffmpeg`) et le garder.
- Cliquer play sur un résultat de recherche qui n'est pas encore dans la
  bibliothèque déclenche le téléchargement, puis lance la lecture une fois
  prêt.

## Contrat d'API attendu côté NAS

```
GET  {API_BASE}/api/search?q=texte
     -> [{ id, title, artist, duration }]
     Live, rien n'est écrit sur disque.

GET  {API_BASE}/api/library
     -> [{ id, title, artist, duration }]
     Tout ce qui existe déjà physiquement sur le NAS.

POST {API_BASE}/api/library      body: { id, title, artist, duration }
     -> télécharge si absent (yt-dlp + ffmpeg), répond en 2xx quand prêt.
     -> peut réutiliser ton /download existant + déclencher le scan Subsonic.

GET  {API_BASE}/api/stream/:id
     -> flux audio (uniquement si le morceau est dans la bibliothèque).
     -> peut proxier vers le stream Subsonic authentifié côté serveur, pour
        ne pas exposer le token MD5 au frontend.
```

Le backend doit renvoyer les en-têtes CORS appropriés
(`Access-Control-Allow-Origin`) puisque ce frontend est servi depuis un
domaine différent (GitHub Pages) de ton tunnel Cloudflare.

## Configuration de l'URL du backend

Un champ "Backend API" est disponible dans la barre latérale (persisté en
`localStorage` du navigateur). Pas besoin de toucher au code pour pointer
vers `https://navidrome.mymusic-nj.com` ou toute autre URL — pratique si tu
testes en local avant de finaliser le tunnel.

## Vues de l'interface

- **Accueil** — les 8 derniers morceaux téléchargés
- **Rechercher** — recherche live dans le catalogue mondial (debounce 350ms
  pour ne pas spammer le backend à chaque frappe)
- **Ma bibliothèque** — tout ce qui est réellement stocké sur le NAS

## Lecteur audio

Un vrai élément `<audio>` (cf. `#audioEl` dans `index.html`), plus de
synthèse Web Audio de démo. Il pointe vers `GET /api/stream/:id` et ne
fonctionne donc que pour les morceaux déjà dans la bibliothèque — d'où le
flux "télécharge puis joue" pour les résultats de recherche.

## Déploiement GitHub Pages

1. Pousser ce dossier tel quel sur un repo (`index.html` à la racine ou dans
   `/docs`), activer GitHub Pages sur la branche correspondante.
2. Configurer côté NAS le CORS pour autoriser l'origine `https://<user>.github.io`.
3. Renseigner l'URL du backend dans le champ "Backend API" une fois déployé.

## Fichiers

```
mymusic-stream/
├── index.html   structure de la page (sidebar, config API, grille, lecteur)
├── style.css    thème navy/violet, indicateurs bibliothèque, responsive
├── app.js       état, fetch réseau (search/library/stream), lecteur <audio>
└── README.md    ce fichier
```
