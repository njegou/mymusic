# mymusic — catalogue à la demande (frontend)

Squelette statique (HTML/CSS/JS, sans framework) pour la nouvelle architecture :
un **index de métadonnées illimité**, mais un **stockage réel uniquement pour
les morceaux ajoutés à une playlist**.

Prêt pour un déploiement GitHub Pages tel quel — aucune dépendance à installer.

## Pourquoi ce découpage (index vs stockage)

- **Index mondial** = recherche live (comme ton `/search` actuel avec
  `yt-dlp ytsearch --flat-playlist --dump-json`). Ça ne coûte rien en
  stockage car ce ne sont que des métadonnées (titre, artiste, durée, id).
- **Cache réel** = déclenché uniquement à l'ajout dans une playlist, via ton
  pipeline existant `yt-dlp` + `ffmpeg` (téléchargement, extraction audio,
  métadonnées) sur le NAS.

C'est le même principe que ton projet actuel — juste avec le téléchargement
déclenché par "ajout playlist" plutôt que par upload manuel. Je suis resté
volontairement sur ce même périmètre (outil personnel, un seul utilisateur)
plutôt que d'en faire un vrai service multi-utilisateurs public : dès qu'on
héberge et sert de la musique à d'autres personnes, l'exposition légale change
de nature par rapport à un usage strictement personnel.

## État actuel du frontend

Tout est en mémoire (aucun backend branché) :

- `WORLD_INDEX` dans `app.js` simule l'index — à remplacer par un vrai fetch.
- La lecture audio est **une synthèse Web Audio** (accord généré), pas un
  vrai fichier — ça permet de tester toute l'UI (play/pause/seek/volume/next)
  sans dépendance externe ni fichier audio à héberger sur GitHub Pages.
- L'ajout à une playlist simule un délai de téléchargement (1.2s) puis bascule
  le morceau en "En cache" (petit point vert vs orange dans les cartes).

## Contrat d'API à brancher sur le NAS

Trois endpoints suffisent pour remplacer les mocks :

```
GET  /api/search?q=texte
     -> [{ id, title, artist, duration }]
     (wrap de ton /search existant, ytsearch --flat-playlist)

POST /api/playlists/:playlistId/tracks   { trackId }
     -> déclenche le téléchargement si pas déjà en cache (ton /download),
        puis startScan Subsonic, puis répond quand prêt

GET  /api/stream/:trackId
     -> si en cache : flux du fichier local (Subsonic stream)
     -> sinon : 404, ou flux transitoire non persisté si tu veux permettre
        l'écoute avant mise en cache (à toi de voir, ça ajoute de la
        complexité pour peu de gain vu ta bande passante NAS 512 Mo RAM)
```

Points d'intégration dans `app.js` :

- `WORLD_INDEX` → remplacer par un `fetch('/api/search?q=...')` dans le
  listener de `#searchInput`
- `addToPlaylist()` → remplacer le `setTimeout` de simulation par un vrai
  `fetch('/api/playlists/.../tracks', { method: 'POST', ... })`
- `startSynth()` / `stopSynth()` → remplacer par un vrai élément `<audio>`
  avec `src = /api/stream/${trackId}`, branché sur les mêmes contrôles
  play/pause/seek/volume déjà câblés

## Déploiement GitHub Pages

1. Pousser ce dossier tel quel sur un repo (`index.html` à la racine ou dans
   `/docs`)
2. Activer GitHub Pages sur la branche/dossier correspondant
3. Comme le vrai backend (NAS) n'est pas exposé publiquement de la même façon
   que ton tunnel Cloudflare, prévoir soit :
   - un reverse proxy vers `navidrome.mymusic-nj.com` pour les endpoints
     `/api/*`, ou
   - configurer les appels fetch pour pointer directement vers ton tunnel
     Cloudflare existant

## Fichiers

```
mymusic-stream/
├── index.html   structure de la page (sidebar, grille, lecteur)
├── style.css    thème navy/violet, indicateurs de cache, responsive
├── app.js       état, rendu, recherche, lecteur (synthèse démo)
└── README.md    ce fichier
```
