# 🎵 mymusic

Bibliothèque musicale personnelle, pilotée par un agent IA, sans abonnement.

**Coût total : ~0€/mois** — sauf Claude Haiku (~1€/mois pour ~150 téléchargements)

---

## Stack technique

| Composant | Outil | Rôle |
|---|---|---|
| LLM | Claude Haiku (API Anthropic) | Extraire titre + artiste |
| Téléchargement | yt-dlp + ffmpeg | Télécharger et convertir en MP3 |
| Streaming | Navidrome (port 4533) | Bibliothèque + API Subsonic |
| Client iPhone | Substreamer / Amperfy | Écoute sur iPhone |
| Accès distant | Cloudflare Tunnel | URL publique HTTPS gratuite |
| NAS | Synology DS218+ | Stockage permanent |

---

## Architecture

```
iPhone / Navigateur
      ↓ HTTPS (Cloudflare Tunnel)
backend.py (port 5001)
      ├── /chat     → Claude Haiku → yt-dlp (recherche)
      ├── /download → yt-dlp (téléchargement MP3)
      └── /upload   → import manuel MP3
            ↓
NAS /volume1/music/mymusic/
            ↓ scan auto
Navidrome (port 4533)
            ↓ API Subsonic
Substreamer iPhone
```

---

## Structure du projet

```
mymusic/
├── backend.py        ← serveur unifié (agent + upload + download)
├── index.html        ← interface 3 onglets (Agent / Import / Bibliothèque)
├── agent.py          ← agent terminal legacy (Ollama/Mistral)
├── .env              ← clé API Anthropic (jamais committé)
├── .env.example      ← template à copier
└── .gitignore
```

---

## Installation

### Prérequis

- Python 3.10+
- yt-dlp → `winget install yt-dlp`
- ffmpeg → `winget install ffmpeg`
- Navidrome sur le NAS → port 4533

### 1. Cloner le repo

```powershell
git clone https://github.com/TON_USERNAME/mymusic.git
cd mymusic
```

### 2. Configurer la clé API

```powershell
cp .env.example .env
# Édite .env et colle ta clé Anthropic
```

### 3. Lancer le backend

```powershell
# Charge les variables d'environnement puis lance
$env:ANTHROPIC_API_KEY="sk-ant-xxx"
python backend.py
```

### 4. Ouvrir l'interface

Ouvre `http://localhost:5001` dans le navigateur.

---

## Interface

- **Onglet Agent** — tape une requête en langage naturel, l'IA extrait titre + artiste, yt-dlp propose plusieurs résultats YouTube + SoundCloud, tu valides
- **Onglet Import** — drag & drop de fichiers MP3 locaux vers le NAS
- **Onglet Bibliothèque** — navigation dans Navidrome via l'API Subsonic (albums, titres, favoris, recherche)

---

## Accès iPhone

Substreamer ou Amperfy configuré sur :
- URL : `https://music.tondomaine.com` (Cloudflare Tunnel)
- Login : compte admin Navidrome

---

## Notes légales

Le téléchargement de morceaux protégés via yt-dlp est dans une zone grise légale.
Ce projet est conçu pour un **usage strictement personnel et privé**.

---

*Projet développé par Nicolas Jegou — 2026*
