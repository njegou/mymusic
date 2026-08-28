/* ==========================================================================
   mymusic — front-end
   --------------------------------------------------------------------------
   Contrat d'API (voir upload_server.py sur le NAS) :

     GET  /api/search?q=...&page=0        recherche live YouTube, 20/page
     GET  /api/library                     morceaux téléchargés via cet outil
     POST /api/library      { id, title, artist, duration }
     GET  /api/stream-direct/<youtube_id>  lecture à la demande, rien n'est écrit sur le NAS
     GET  /api/stream/<youtube_id>         repli si pas encore sur Navidrome
     GET  /api/playlists                   liste des playlists Navidrome
     POST /api/playlists    { name }
     GET  /api/playlists/<id>              détail : { tracks, editable, songCount, duration, changed }
     POST /api/playlists/<id>/tracks       { songId }
     GET  /api/playlists/<id>/cover?key=   pochette personnalisée (404 si aucune)
     POST /api/playlists/<id>/cover        { image: "data:image/jpeg;base64,..." } ou { image: null } pour retirer
     POST /api/playlists/<id>/delete       supprime la playlist (les fichiers audio restent)
     GET  /api/stream-nd/<navidrome_id>    flux proxié Navidrome (préféré)
     POST /upload  multipart: file (audio ou .zip, champ répétable) + playlist_id OU playlist_name
                    -> 202 { job_id, total, rejected } — le NAS traite en tâche de fond
     GET  /api/import/<job_id>   suivi : { state, step, done, total, tracks, rejected, playlist }
                    Formats : mp3/m4a/flac gardés tels quels, le reste (wav, opus,
                    alac, wma...) transcodé en MP3 côté NAS.
   ========================================================================== */

const $ = (sel) => document.querySelector(sel);

// URL fixée une fois pour toutes (frontend sur GitHub Pages, backend sur le NAS).
const API_BASE = "https://api.mymusic-nj.com";
function apiUrl(path) {
  return `${API_BASE}${path}`;
}

// ---------------------------------------------------------------------------
// Accès protégé — clé demandée une fois, stockée en local sur l'appareil.
// ---------------------------------------------------------------------------
// Mot de passe d'accès, saisi via la page d'accès et stocké sur l'appareil.
// (plus de prompt() : le déverrouillage passe par #accessGate -> boot())
function getApiKey() {
  return localStorage.getItem("mymusic_api_key") || "";
}

// À utiliser pour tous les appels JSON (recherche, playlists, library, upload).
async function apiFetch(path, options = {}) {
  const headers = { ...(options.headers || {}), "X-API-Key": getApiKey() };
  const res = await fetch(apiUrl(path), { ...options, headers });
  if (res.status === 401) {
    localStorage.removeItem("mymusic_api_key");
    showAccessGate();
    toast("Accès expiré — ressaisis le mot de passe.");
  }
  return res;
}

// À utiliser pour les URLs de streaming (<audio src>) : pas de header possible
// côté navigateur pour cet élément, donc la clé passe en paramètre ?key=.
function streamUrlWithKey(path) {
  return `${apiUrl(path)}?key=${encodeURIComponent(getApiKey())}`;
}

// Pochette d'album proxifiée depuis Navidrome. Un <img src> ne peut pas porter
// de header X-API-Key, donc la clé passe en ?key= (même principe que le stream).
// Jeton incrémenté à chaque ouverture de playlist (cf. openPlaylistDetail).
let playlistRequestToken = 0;

function coverUrlWithKey(coverArt) {
  if (!coverArt) return null;
  return `${apiUrl("/api/cover/" + encodeURIComponent(coverArt))}?key=${encodeURIComponent(getApiKey())}`;
}

// Pochette personnalisée d'une playlist. Le backend renvoie 404 si aucune image
// n'a été déposée : c'est le onerror du <img> qui déclenche alors le repli sur
// la vignette dégradé + initiales. Le paramètre ?v= force le rafraîchissement
// juste après un upload (sinon le navigateur resservirait l'ancienne image).
function playlistCoverUrl(playlistId) {
  const v = state.playlistCoverV[playlistId] || 0;
  return `${apiUrl("/api/playlists/" + encodeURIComponent(playlistId) + "/cover")}`
    + `?key=${encodeURIComponent(getApiKey())}&v=${v}`;
}

// ---------------------------------------------------------------------------
// État
// ---------------------------------------------------------------------------
const state = {
  library: [],            // tout ce que CET outil a téléchargé (suivi local)
  playlists: [],          // playlists Navidrome (liste)
  playlistCoverV: {},     // { playlistId: timestamp } — cache-buster des pochettes custom
  openPlaylist: null,     // { id, name, editable } de la playlist affichée en détail
  favorites: new Set(),   // ids des morceaux favoris (cœurs pleins)
  playQueue: [],          // liste de lecture en cours (pour next/prev)
  queuedNext: [],         // morceaux insérés manuellement ("Lecture ensuite"), joués en priorité
  playHistory: [],        // pile des morceaux joués avant l'actuel (pour "précédent")
  currentTrackId: null,   // navidrome_id si dispo, sinon youtube id
  currentTrackObj: null,
  isPlaying: false,
  shuffle: false,
  search: { query: "", page: 0, results: [] },
};

const PAGE_SIZE = 20; // doit correspondre au page_size côté backend
const audioEl = $("#audioEl");

const byLibId = (id) => state.library.find((t) => t.id === id);
const isCached = (id) => state.library.some((t) => t.id === id);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function normalize(str) {
  return (str || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}
function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}
// Durée cumulée d'une playlist : "42 min" en dessous d'une heure, "1 h 07"
// au-delà. formatTime() reste réservé aux durées de morceaux (m:ss).
function formatDurationLong(sec) {
  if (!isFinite(sec) || sec <= 0) return null;
  const totalMin = Math.round(sec / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (!h) return `${totalMin} min`;
  return m ? `${h} h ${String(m).padStart(2, "0")}` : `${h} h`;
}

// "12 juil. 2026" — Navidrome renvoie du ISO 8601 dans l'attribut `changed`.
function formatDateShort(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" });
}

// Ligne de détails affichée à côté du nom : "14 morceaux · 52 min · maj 12 juil. 2026".
// Chaque segment est optionnel — si le backend ne renvoie pas encore `changed`,
// la date disparaît simplement au lieu d'afficher un trou.
function playlistMetaText(songCount, duration, changed) {
  const parts = [`${songCount} morceau${songCount > 1 ? "x" : ""}`];
  const dur = formatDurationLong(duration);
  if (dur) parts.push(dur);
  const date = formatDateShort(changed);
  if (date) parts.push(`maj ${date}`);
  return parts.join(" · ");
}

function coverGradient(seed) {
  let hash = 0;
  for (const c of String(seed)) hash = (hash * 31 + c.charCodeAt(0)) % 360;
  return `linear-gradient(135deg, hsl(${hash} 70% 55%), hsl(${(hash + 55) % 360} 65% 40%))`;
}
// Cover réelle (pochette YouTube Music) en priorité, avec repli automatique
// sur la vignette "empreinte sonore" si absente ou si le chargement échoue.
function coverHtml(track, seed, cls = "track-row-cover", fillParent = false) {
  const grad = coverGradient(seed);
  const fallback = initials(track && track.title);
  const size = fillParent ? "width:100%;height:100%;border-radius:inherit;" : "";
  const img = track && track.cover
    ? `<img src="${track.cover}" alt="" loading="lazy" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;" onerror="this.remove()">`
    : "";
  return `<div class="${cls}" style="${size}background:${grad};position:relative;overflow:hidden;">${fallback}${img}</div>`;
}
// Vignette d'une playlist : pochette personnalisée si elle existe, sinon
// dégradé + initiales. Même mécanique de repli que coverHtml() (onerror).
function playlistCoverHtml(pl, cls = "track-row-cover") {
  return `<div class="${cls}" style="background:${coverGradient(pl.id)};position:relative;overflow:hidden;">`
    + `${initials(pl.name)}`
    + `<img src="${playlistCoverUrl(pl.id)}" alt="" loading="lazy"`
    + ` style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;"`
    + ` onerror="this.remove()">`
    + `</div>`;
}

function initials(title) {
  return (title || "?").split(" ").slice(0, 2).map((w) => w[0]).join("").toUpperCase();
}
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("is-visible");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("is-visible"), 2400);
}

// ---------------------------------------------------------------------------
// Favoris — cœur cliquable. ON : télécharge + étoile Navidrome + playlist
// "Favorite Songs". OFF : dé-étoile + retire de la playlist, et supprime le
// fichier du NAS s'il n'est dans aucune autre playlist (confirmation demandée).
// ---------------------------------------------------------------------------
function favBtnHtml(track) {
  const on = state.favorites.has(track.id);
  return `<button class="fav-btn ${on ? "is-fav" : ""}" data-fav data-fav-id="${track.id}"
    title="${on ? "Retirer des favoris" : "Ajouter aux favoris"}">${on ? "♥" : "♡"}</button>`;
}

// Attache la bascule au cœur d'une ligne déjà rendue.
function wireFav(row, track) {
  const btn = row.querySelector("[data-fav]");
  if (btn) btn.addEventListener("click", (e) => { e.stopPropagation(); toggleFavorite(track, btn); });
}

// Met à jour toutes les occurrences du même morceau affichées à l'écran.
function syncFavButtons(trackId) {
  const on = state.favorites.has(trackId);
  document.querySelectorAll(`[data-fav-id="${trackId}"]`).forEach((b) => {
    b.classList.toggle("is-fav", on);
    if (!b.dataset.busy) {
      b.textContent = on ? "♥" : "♡";
      b.title = on ? "Retirer des favoris" : "Ajouter aux favoris";
    }
  });
  updatePlayerLike();
}

// Cœur de la barre de lecture : reflète l'état favori du morceau en cours.
function updatePlayerLike() {
  const btn = $("#playerLike");
  if (!btn) return;
  const t = state.currentTrackObj;
  const on = !!(t && state.favorites.has(t.id));
  btn.classList.toggle("is-fav", on);
  btn.title = on ? "Retirer des favoris" : "Ajouter aux favoris";
  btn.disabled = !t;
}

async function toggleFavorite(track, btn) {
  if (btn.dataset.busy) return;
  const willFav = !state.favorites.has(track.id);

  // Décochage : peut entraîner la suppression du fichier -> on confirme.
  if (!willFav && !confirm(
    `Retirer « ${track.title} » des favoris ?\n\n`
    + `Le morceau sera aussi supprimé du NAS, sauf s'il figure dans une autre playlist.`
  )) return;

  btn.dataset.busy = "1";
  btn.classList.add("is-loading");
  btn.textContent = "…";
  try {
    const res = await apiFetch("/api/favorite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: track.id, title: track.title, artist: track.artist,
        duration: track.duration, cover: track.cover || null, favorite: willFav,
      }),
    });
    if (!res.ok) {
      let m = `HTTP ${res.status}`;
      try { m = (await res.json()).error || m; } catch {}
      throw new Error(m);
    }
    const data = await res.json();
    if (data.favorite) { state.favorites.add(track.id); toast("Ajouté aux favoris"); }
    else { state.favorites.delete(track.id); toast(data.deleted ? "Retiré des favoris et supprimé du NAS" : "Retiré des favoris"); }
    if (willFav || data.deleted) loadLibrary();   // la bibliothèque a changé
  } catch (err) {
    toast(`Favori : ${err.message}`);
  } finally {
    delete btn.dataset.busy;
    btn.classList.remove("is-loading");
    syncFavButtons(track.id);
  }
}

async function loadFavorites() {
  try {
    const res = await apiFetch("/api/favorites");
    if (!res.ok) return;
    state.favorites = new Set(await res.json());
  } catch { /* silencieux : les cœurs resteront vides */ }
}

// ---------------------------------------------------------------------------
// Rendu — cartes (recherche/accueil)
// ---------------------------------------------------------------------------
function renderCard(track) {
  const cached = isCached(track.id);
  const row = document.createElement("div");
  row.className = "track-row";
  row.dataset.trackId = track.id;
  row.innerHTML = `
    ${coverHtml(track, track.id)}
    <div>
      <div class="track-row-title">${track.title}</div>
      <div class="track-row-artist">${track.artist}</div>
    </div>
    <span class="track-row-status ${cached ? "cached" : "ondemand"}">${cached ? "Téléchargé" : "À la demande"}</span>
    <span class="row-actions">
      ${favBtnHtml(track)}
      <button class="playlist-add-btn" data-add title="Ajouter à une playlist">＋</button>
    </span>
    <span class="track-row-duration" data-play title="Lire">▶</span>
  `;
  row.querySelector("[data-play]").addEventListener("click", (e) => {
    e.stopPropagation();
    handleTrackActivate(track);
  });
  row.querySelector("[data-add]").addEventListener("click", (e) => {
    e.stopPropagation();
    openPlaylistPicker(e.currentTarget, track);
  });
  wireFav(row, track);
  row.addEventListener("click", () => handleTrackActivate(track));
  return row;
}

function renderGrid(container, tracks, emptyMsg) {
  container.innerHTML = "";
  if (!tracks.length) {
    container.innerHTML = `<div class="empty-state">${emptyMsg}</div>`;
    return;
  }
  tracks.forEach((t) => container.appendChild(renderCard(t)));
}

// Carte de pochette pour le carrousel de l'accueil (icône ICON_PLAY définie
// plus bas dans le fichier — disponible au moment où renderAll s'exécute).
function renderHomeCard(track) {
  const card = document.createElement("div");
  card.className = "home-card";
  card.innerHTML = `
    <div class="home-card-art">
      ${coverHtml(track, track.id, "home-card-cover", true)}
      <button class="home-card-play" title="Lire" aria-label="Lire">${ICON_PLAY}</button>
    </div>
    <div class="home-card-title">${track.title}</div>
    <div class="home-card-sub">${track.artist || ""}</div>
  `;
  card.addEventListener("click", () => handleTrackActivate(track));
  return card;
}

// Tuiles d'accès rapide = premières playlists.
function renderHomeQuick() {
  const wrap = $("#homeQuick");
  if (!wrap) return;
  const pls = state.playlists.slice(0, 6);
  wrap.innerHTML = "";
  pls.forEach((pl) => {
    const tile = document.createElement("div");
    tile.className = "home-qtile";
    tile.innerHTML = `
      ${playlistCoverHtml(pl, "home-qtile-cover")}
      <div class="home-qtile-name">${pl.name}</div>
      <button class="home-qtile-play" title="Ouvrir" aria-label="Ouvrir">${ICON_PLAY}</button>
    `;
    tile.addEventListener("click", () => { activateView("library"); openPlaylistDetail(pl.id, pl.name); });
    wrap.appendChild(tile);
  });
}

// ── Recommandations de l'accueil ────────────────────────────────────────────
// Servies par /api/home, personnalisées par utilisateur (le backend interroge
// Navidrome sous l'identité de la session) et renouvelées toutes les 6 h.
// Le conteneur est créé à la volée au-dessus de "Récemment ajoutés", donc
// aucune modification d'index.html n'est nécessaire.
function homeRecoContainer() {
  let box = $("#homeRecos");
  if (box) return box;

  const grid = $("#homeGrid");
  if (!grid) return null;

  box = document.createElement("div");
  box.id = "homeRecos";

  // On remonte jusqu'au titre "Récemment ajoutés" pour se placer avant lui.
  const anchor = grid.previousElementSibling || grid;
  grid.parentElement.insertBefore(box, anchor);
  return box;
}

let homeReturnFromAlbum = false;   // vrai quand la vue album a été ouverte depuis l'accueil

function renderRecoShelf(shelf) {
  const section = document.createElement("div");
  section.className = "home-reco-shelf";

  const heading = document.createElement("h2");
  heading.textContent = shelf.title;
  section.appendChild(heading);

  const row = document.createElement("div");
  // Réutilise la classe du carrousel existant : même style, aucun CSS à ajouter.
  row.className = $("#homeGrid") ? $("#homeGrid").className : "";
  if (shelf.albums && shelf.albums.length) {
    // Rangée d'albums : la carte mène à la vue détail, pas à une lecture directe.
    // shelf.catalog => nouveautés du catalogue (browseId -> openCatalogAlbum) ;
    // sinon albums de la bibliothèque Navidrome (id ND -> openLibraryAlbum).
    shelf.albums.forEach((a) => row.appendChild(renderHomeAlbumCard(a, shelf.catalog)));
  } else {
    (shelf.tracks || []).forEach((t) => {
      const track = {
        ...t,
        navidrome_id: t.navidrome_id || t.id,
        cover: t.coverArt ? coverUrlWithKey(t.coverArt) : null,
      };
      row.appendChild(renderHomeCard(track));
    });
  }
  section.appendChild(row);
  return section;
}

// Carte album de l'accueil : mêmes classes CSS que renderHomeCard (aucun style
// neuf), mais le clic ouvre la vue album au lieu de lancer une lecture.
function renderHomeAlbumCard(album, isCatalog) {
  const card = document.createElement("div");
  card.className = "home-card";
  // Catalogue : cover = URL directe YouTube. Bibliothèque : coverArt = id
  // Navidrome à proxifier. On gère les deux, dans cet ordre de priorité.
  const coverUrl = album.cover
    ? album.cover
    : (album.coverArt ? coverUrlWithKey(album.coverArt) : null);
  const inner = coverUrl
    ? `<img src="${coverUrl}" alt="" loading="lazy">`
    : `<span class="home-card-fallback">${initials(album.name)}</span>`;
  card.innerHTML = `
    <div class="home-card-art">
      <div class="home-card-cover">${inner}</div>
    </div>
    <div class="home-card-title">${album.name}</div>
    <div class="home-card-sub">${album.artist || ""}${album.year ? " · " + album.year : ""}</div>
  `;
  card.addEventListener("click", () => {
    homeReturnFromAlbum = true;
    if (isCatalog) openCatalogAlbum(album.id);   // browseId YouTube
    else openLibraryAlbum(album.id);             // id Navidrome
  });
  return card;
}

// Ouvre un album de la BIBLIOTHÈQUE Navidrome dans la vue "catalog-album"
// (réutilisée telle quelle). Distinct de openCatalogAlbum, qui ouvre un album
// du catalogue mondial via un browseId YouTube. Ici l'id est un id Navidrome :
// on pose navidrome_id sur chaque piste pour que playTrack streame via
// /api/stream-nd/ (cf. renderCatalogTrackRow -> playTrack).
async function openLibraryAlbum(albumId) {
  activateView("catalog-album");
  homeReturnFromAlbum = true;
  const head = $("#catAlbumHead");
  const container = $("#catAlbumTracks");
  container.innerHTML = `<div class="empty-state">Chargement de l'album…</div>`;
  try {
    const res = await apiFetch(`/api/albums/${encodeURIComponent(albumId)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    const album = { ...raw, cover: raw.coverArt ? coverUrlWithKey(raw.coverArt) : null };
    const tracks = (raw.tracks || []).map((t) => ({
      ...t,
      navidrome_id: t.id,          // -> lecture via /api/stream-nd/
      in_library: true,            // c'est de la bibliothèque, par définition
      cover: t.coverArt ? coverUrlWithKey(t.coverArt) : album.cover,
    }));

    const cover = album.cover
      ? `<img src="${album.cover}" alt="" loading="lazy">`
      : `<div class="album-card-fallback">${initials(album.name)}</div>`;

    head.innerHTML = `
      <div class="cat-album-head">
        <div class="cat-album-cover">${cover}</div>
        <div class="cat-album-info">
          <div class="cat-album-kicker">Album</div>
          <h1 class="view-title">${album.name}</h1>
          <div class="view-sub">${album.artist}${album.year ? " · " + album.year : ""} · ${tracks.length} titre${tracks.length > 1 ? "s" : ""}</div>
          <div class="cat-album-actions">
            <button class="primary-btn" id="catAlbumPlay">▶ Lecture</button>
            <button class="primary-btn ghost" id="catAlbumShuffle">🔀 Aléatoire</button>
          </div>
        </div>
      </div>
    `;

    container.innerHTML = "";
    if (!tracks.length) {
      container.innerHTML = `<div class="empty-state">Aucun morceau disponible pour cet album.</div>`;
      return;
    }
    tracks.forEach((t) => container.appendChild(renderCatalogTrackRow(t, tracks, album)));

    const queue = tracks.map((t) => ({ ...t, cover: t.cover || album.cover }));
    $("#catAlbumPlay").addEventListener("click", () => {
      if (queue[0]) playTrack(byLibId(queue[0].id) || queue[0], queue);
    });
    $("#catAlbumShuffle").addEventListener("click", () => {
      if (!queue.length) return;
      state.shuffle = true;
      $("#shuffleBtn").classList.add("is-active");
      const pick = queue[Math.floor(Math.random() * queue.length)];
      playTrack(byLibId(pick.id) || pick, queue);
    });
  } catch (err) {
    container.innerHTML = `<div class="empty-state">Erreur : ${err.message}</div>`;
  }
}

async function renderRecommendations(force = false) {
  const box = homeRecoContainer();
  if (!box) return;

  try {
    const res = await apiFetch("/api/home", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force: !!force }),
    });
    if (!res.ok) return;
    const data = await res.json();
    const shelves = (data && data.shelves) || [];

    box.innerHTML = "";
    // Une rangée vide n'est pas affichée : mieux vaut rien qu'un bloc creux.
    shelves.filter((sh) => (sh.tracks && sh.tracks.length) || (sh.albums && sh.albums.length))
           .forEach((sh) => box.appendChild(renderRecoShelf(sh)));
  } catch {
    // Silencieux : l'accueil doit rester utilisable sans recommandations.
  }
}

function renderAll() {
  renderHomeQuick();
  renderRecommendations();

  const grid = $("#homeGrid");
  const recent = [...state.library].slice(-12).reverse();
  grid.innerHTML = "";
  if (!recent.length) {
    grid.style.display = "block";
    grid.innerHTML = `<div class="empty-state">Rien dans ta bibliothèque pour l'instant — cherche un morceau et ajoute-le à une playlist pour le télécharger.</div>`;
  } else {
    grid.style.display = "";
    recent.forEach((t) => grid.appendChild(renderHomeCard(t)));
  }
}

// ---------------------------------------------------------------------------
// Rendu — playlists (liste + détail)
// ---------------------------------------------------------------------------
function renderPlaylistRow(pl) {
  const card = document.createElement("div");
  card.className = "playlist-card";
  // Les détails (nombre, durée, date) ne sont plus ici : ils apparaissent
  // dans l'en-tête au clic. La carte ne montre que pochette et nom.
  card.innerHTML = `
    ${playlistCoverHtml(pl, "playlist-card-cover")}
    <div class="playlist-card-name">${pl.name}</div>
  `;
  card.addEventListener("click", () => openPlaylistDetail(pl.id, pl.name));
  return card;
}

function renderPlaylistsList() {
  const container = $("#playlistsList");
  container.innerHTML = "";
  if (!state.playlists.length) {
    container.innerHTML = `<div class="empty-state">Aucune playlist pour l'instant — crée-en une.</div>`;
    return;
  }
  state.playlists.forEach((pl) => container.appendChild(renderPlaylistRow(pl)));
}

// Playlists dans la sidebar : vignette + nom, clic = ouvre le détail.
function renderSidebarPlaylists() {
  const container = $("#sidebarPlaylists");
  if (!container) return;
  container.innerHTML = "";
  if (!state.playlists.length) {
    container.innerHTML = `<div class="side-pls-empty">Aucune playlist</div>`;
    return;
  }
  state.playlists.forEach((pl) => {
    const row = document.createElement("div");
    row.className = "side-pl";
    row.innerHTML = `
      ${playlistCoverHtml(pl, "side-pl-cover")}
      <div class="side-pl-name">${pl.name}</div>
    `;
    row.addEventListener("click", () => { activateView("library"); openPlaylistDetail(pl.id, pl.name); });
    container.appendChild(row);
  });
}

async function loadPlaylists() {
  try {
    const res = await apiFetch("/api/playlists");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.playlists = await res.json();
  } catch (err) {
    toast(`Impossible de charger les playlists : ${err.message}`);
    state.playlists = [];
  }
  renderPlaylistsList();
  renderSidebarPlaylists();
  renderHomeQuick();
}

function renderPlaylistTrackRow(track, queueRaw, playlistId, editable) {
  const row = document.createElement("div");
  row.className = "track-row";
  // Le glisser-déposer n'a de sens que si Navidrome accepte de réécrire la
  // playlist (playlist possédée, non-smart).
  if (editable) {
    row.draggable = true;
    row.dataset.songId = track.id;
  }
  row.innerHTML = `
    ${coverHtml(track, track.id)}
    <div>
      <div class="track-row-title">${track.title}</div>
      <div class="track-row-artist">${track.artist}</div>
    </div>
    <span class="track-row-status cached">Navidrome</span>
    <span class="row-actions">
      ${favBtnHtml(track)}
      <button class="row-action" title="Options">⋯</button>
    </span>
    <span class="track-row-duration">${formatTime(track.duration)}</span>
  `;
  const queue = queueRaw.map((t) => ({ ...t, navidrome_id: t.id }));
  const self = { ...track, navidrome_id: track.id };
  wireFav(row, track);

  row.addEventListener("click", (e) => {
    if (e.target.closest(".row-action") || e.target.closest("[data-fav]")) return;
    playTrack(self, queue);
  });

  row.querySelector(".row-action").addEventListener("click", (e) => {
    e.stopPropagation();
    const items = [
      { label: "Lecture ensuite", icon: "▷", onClick: () => queueNext(self) },
    ];
    // Renommage réservé aux fichiers venus d'un import : les morceaux
    // téléchargés tiennent leurs tags de YouTube Music.
    if (track.imported) {
      items.push({
        label: "Renommer", icon: "✎",
        onClick: () => openRenameModal(track, playlistId),
      });
    }
    // Déplacement à la carte : le glisser-déposer HTML5 ignore le tactile et
    // reste capricieux selon le navigateur. Ces deux entrées fonctionnent
    // partout, iPhone compris.
    if (editable) {
      const total = queueRaw.length;
      if (track.index > 0) {
        items.push({
          label: "Monter", icon: "↑",
          onClick: () => moveTrack(playlistId, track.index, -1),
        });
      }
      if (track.index < total - 1) {
        items.push({
          label: "Descendre", icon: "↓",
          onClick: () => moveTrack(playlistId, track.index, +1),
        });
      }
    }
    if (editable) {
      items.push({
        label: "Retirer de la playlist", icon: "🗑", danger: true,
        onClick: () => removeFromPlaylist(playlistId, track.index, track.title, row),
      });
    }
    openTrackMenu(e.currentTarget, items);
  });
  return row;
}

// Insère un morceau juste après le titre courant (modèle "Lire ensuite").
function queueNext(track) {
  state.queuedNext.push({ ...track });
  updateQueueBadge();
  toast(`« ${track.title} » sera lu ensuite`);
}

async function removeFromPlaylist(playlistId, index, title, rowEl) {
  if (typeof index !== "number") { toast("Index introuvable."); return; }
  try {
    const res = await apiFetch(`/api/playlists/${encodeURIComponent(playlistId)}/remove`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ index }),
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { msg = (await res.json()).error || msg; } catch {}
      throw new Error(msg);
    }
    // Recharge le détail : les index des morceaux suivants ont changé.
    toast(`« ${title} » retiré`);
    openPlaylistDetail(playlistId, $("#playlistDetailTitle").textContent);
  } catch (err) {
    toast(`Suppression impossible : ${err.message}`);
  }
}

// Petit menu contextuel réutilisable, ancré sous un bouton.
function openTrackMenu(anchorEl, items) {
  document.querySelector(".track-menu")?.remove();
  const menu = document.createElement("div");
  menu.className = "track-menu";
  items.forEach((it) => {
    const b = document.createElement("button");
    b.className = "track-menu-item" + (it.danger ? " danger" : "");
    b.innerHTML = `<span class="track-menu-icon">${it.icon || ""}</span>${it.label}`;
    b.addEventListener("click", (e) => { e.stopPropagation(); menu.remove(); it.onClick(); });
    menu.appendChild(b);
  });
  document.body.appendChild(menu);
  const r = anchorEl.getBoundingClientRect();
  menu.style.top = `${r.bottom + 6}px`;
  // Aligné à droite du bouton, sans déborder de l'écran.
  menu.style.left = `${Math.max(8, r.right - menu.offsetWidth)}px`;

  const close = (e) => {
    if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener("click", close); }
  };
  setTimeout(() => document.addEventListener("click", close), 0);
}

function updateQueueBadge() {
  const el = $("#queueBadge");
  if (!el) return;
  const n = state.queuedNext.length;
  el.textContent = n;
  el.classList.toggle("is-hidden", n === 0);
}

async function openPlaylistDetail(id, name) {
  // Jeton de requête : ouvrir une grosse playlist puis une petite fait revenir
  // les réponses dans le désordre, et la plus lente écrasait l'affichage de la
  // plus récente. Toute réponse dont le jeton a été périmé est ignorée.
  const token = ++playlistRequestToken;
  $("#playlistsListWrap").classList.add("is-hidden");
  $("#playlistDetailWrap").classList.remove("is-hidden");
  $("#playlistDetailTitle").textContent = name;
  $("#playlistDetailMeta").textContent = "";
  $("#playlistDetailCover").innerHTML = playlistCoverHtml({ id, name }, "playlist-hero-cover");
  $("#playlistCoverBtn").classList.add("is-hidden");
  $("#playlistMenuBtn").classList.add("is-hidden");
  state.openPlaylist = { id, name, editable: false };

  const container = $("#playlistDetailTracks");
  container.innerHTML = `<div class="empty-state">Chargement…</div>`;
  try {
    const res = await apiFetch(`/api/playlists/${encodeURIComponent(id)}`);
    if (token !== playlistRequestToken) return;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (token !== playlistRequestToken) return;

    // Compteur et durée : on privilégie ce que renvoie Navidrome, avec repli
    // sur un calcul local — la page reste juste même si le backend n'a pas
    // encore été mis à jour.
    const tracks = data.tracks || [];
    // La pochette réellement embarquée dans le fichier, servie par le proxy
    // Navidrome. Pour un morceau importé, c'est celle de la playlist.
    tracks.forEach((t) => { t.cover = t.cover || coverUrlWithKey(t.coverArt); });
    const songCount = typeof data.songCount === "number" ? data.songCount : tracks.length;
    const duration = typeof data.duration === "number"
      ? data.duration
      : tracks.reduce((sum, t) => sum + (Number(t.duration) || 0), 0);
    $("#playlistDetailMeta").textContent = playlistMetaText(songCount, duration, data.changed);

    state.openPlaylist = { id, name, editable: !!data.editable };
    // La pochette n'est personnalisable que sur les playlists qu'on possède
    // (une smart playlist ou une playlist partagée reste en lecture seule).
    $("#playlistCoverBtn").classList.toggle("is-hidden", !data.editable);
    $("#playlistMenuBtn").classList.toggle("is-hidden", !data.editable);

    container.innerHTML = "";
    if (!tracks.length) {
      container.innerHTML = `<div class="empty-state">Playlist vide — ajoute des morceaux depuis la recherche (bouton ＋).</div>`;
      return;
    }
    tracks.forEach((t) => {
      const row = renderPlaylistTrackRow(t, tracks, id, data.editable);
      if (data.editable) wireReorder(row, container, id);
      container.appendChild(row);
    });
  } catch (err) {
    if (token !== playlistRequestToken) return;
    container.innerHTML = `<div class="empty-state">Erreur : ${err.message}</div>`;
  }
}

// ---------------------------------------------------------------------------
// Pochette personnalisée — l'image est recadrée en carré et redimensionnée
// DANS LE NAVIGATEUR avant l'envoi. Le NAS (512 Mo de RAM) ne reçoit donc
// qu'un JPEG de ~60 Ko, jamais la photo brute de 5 Mo.
// ---------------------------------------------------------------------------
function squareJpegDataUrl(file, size = 600) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("fichier illisible"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("format d'image non supporté par le navigateur"));
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext("2d");
        // Recadrage centré : on prend le plus grand carré possible dans l'image.
        const side = Math.min(img.naturalWidth, img.naturalHeight);
        const sx = (img.naturalWidth - side) / 2;
        const sy = (img.naturalHeight - side) / 2;
        ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function sendPlaylistCover(playlistId, dataUrl) {
  const res = await apiFetch(`/api/playlists/${encodeURIComponent(playlistId)}/cover`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: dataUrl }),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  // Nouvelle version -> les <img> rechargent au lieu de resservir le cache.
  state.playlistCoverV[playlistId] = Date.now();
}

function refreshPlaylistCovers(playlistId, name) {
  $("#playlistDetailCover").innerHTML =
    playlistCoverHtml({ id: playlistId, name }, "playlist-hero-cover");
  renderPlaylistsList();
  renderSidebarPlaylists();
  renderHomeQuick();
}

$("#playlistCoverInput").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";  // permet de re-sélectionner le même fichier ensuite
  const pl = state.openPlaylist;
  if (!file || !pl) return;
  try {
    toast("Préparation de la pochette…");
    const dataUrl = await squareJpegDataUrl(file);
    await sendPlaylistCover(pl.id, dataUrl);
    refreshPlaylistCovers(pl.id, pl.name);
    // Le NAS retagge les morceaux importés en arrière-plan : leur pochette
    // dans la vue Albums ne changera qu'après le scan Navidrome suivant.
    toast("Pochette mise à jour — morceaux importés en cours d'alignement");
  } catch (err) {
    toast(`Pochette impossible : ${err.message}`);
  }
});

$("#playlistCoverBtn").addEventListener("click", (e) => {
  const pl = state.openPlaylist;
  if (!pl) return;
  openTrackMenu(e.currentTarget, [
    {
      label: "Choisir une image", icon: "🖼",
      onClick: () => $("#playlistCoverInput").click(),
    },
    {
      label: "Retirer la pochette", icon: "🗑", danger: true,
      onClick: async () => {
        try {
          await sendPlaylistCover(pl.id, null);
          refreshPlaylistCovers(pl.id, pl.name);
          toast("Pochette retirée — morceaux importés en cours d'alignement");
        } catch (err) {
          toast(`Suppression impossible : ${err.message}`);
        }
      },
    },
  ]);
});

// ---------------------------------------------------------------------------
// Renommage d'un morceau importé
// ---------------------------------------------------------------------------
let renameTarget = null;   // { id, playlistId } du morceau en cours d'édition

function openRenameModal(track, playlistId) {
  renameTarget = { id: track.id, playlistId };
  $("#renameTitle").value = track.title || "";
  // "Inconnu"/"[Unknown Artist]" sont des étiquettes de repli, pas de vraies
  // valeurs : on présente un champ vide plutôt que de les faire recopier.
  const artist = track.artist || "";
  $("#renameArtist").value = /^(inconnu|\[?unknown artist\]?)$/i.test(artist) ? "" : artist;
  $("#renameModal").classList.remove("is-hidden");
  $("#renameTitle").focus();
  $("#renameTitle").select();
}

function closeRenameModal() {
  $("#renameModal").classList.add("is-hidden");
  $("#renameSave").disabled = false;
  $("#renameSave").textContent = "Enregistrer";
  renameTarget = null;
}

async function saveRename() {
  if (!renameTarget) return;
  const title = $("#renameTitle").value.trim();
  if (!title) { toast("Le titre ne peut pas être vide"); return; }
  const artist = $("#renameArtist").value.trim();
  const { id, playlistId } = renameTarget;

  // Le backend attend la fin du réindexage avant de répondre : quelques
  // secondes, d'où le bouton verrouillé plutôt qu'un simple toast.
  $("#renameSave").disabled = true;
  $("#renameSave").textContent = "Enregistrement…";
  try {
    const res = await apiFetch(`/api/tracks/${encodeURIComponent(id)}/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, artist }),
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { msg = (await res.json()).error || msg; } catch {}
      throw new Error(msg);
    }
    const data = await res.json();
    closeRenameModal();
    toast(data.indexed
      ? `Renommé en « ${title} »`
      : `Renommé — Navidrome termine son indexation`);
    if (playlistId && state.openPlaylist && state.openPlaylist.id === playlistId) {
      openPlaylistDetail(playlistId, state.openPlaylist.name);
    }
  } catch (err) {
    $("#renameSave").disabled = false;
    $("#renameSave").textContent = "Enregistrer";
    toast(`Renommage impossible : ${err.message}`);
  }
}

$("#renameSave").addEventListener("click", saveRename);
$("#renameCancel").addEventListener("click", closeRenameModal);
$("#renameModal").addEventListener("click", (e) => {
  if (e.target === $("#renameModal")) closeRenameModal();
});
["#renameTitle", "#renameArtist"].forEach((sel) => {
  $(sel).addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveRename();
    if (e.key === "Escape") closeRenameModal();
  });
});

// ---------------------------------------------------------------------------
// Réordonnancement d'une playlist par glisser-déposer
// ---------------------------------------------------------------------------
// Déplace d'un cran le morceau situé à `index`. delta = -1 (monter) ou +1.
async function moveTrack(playlistId, index, delta) {
  const container = $("#playlistDetailTracks");
  const ids = [...container.querySelectorAll("[data-song-id]")]
    .map((el) => el.dataset.songId);
  const target = index + delta;
  if (target < 0 || target >= ids.length) return;
  [ids[index], ids[target]] = [ids[target], ids[index]];
  await savePlaylistOrder(playlistId, null, ids);
}

let dragSongId = null;

function wireReorder(row, container, playlistId) {
  row.addEventListener("dragstart", (e) => {
    dragSongId = row.dataset.songId;
    row.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    // Firefox n'amorce pas le glissement sans données attachées.
    e.dataTransfer.setData("text/plain", dragSongId);
  });

  row.addEventListener("dragend", () => {
    row.classList.remove("dragging");
    container.querySelectorAll(".drop-before, .drop-after")
      .forEach((el) => el.classList.remove("drop-before", "drop-after"));
    dragSongId = null;
  });

  row.addEventListener("dragover", (e) => {
    if (!dragSongId || row.dataset.songId === dragSongId) return;
    e.preventDefault();
    // Au-dessus de la moitié haute -> insertion avant, sinon après.
    const rect = row.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    row.classList.toggle("drop-before", before);
    row.classList.toggle("drop-after", !before);
  });

  row.addEventListener("dragleave", (e) => {
    // dragleave se déclenche aussi en passant d'un enfant de la ligne à un
    // autre : sans ce test, le repère d'insertion clignote et disparaît
    // parfois juste avant le dépôt.
    if (!row.contains(e.relatedTarget)) {
      row.classList.remove("drop-before", "drop-after");
    }
  });

  row.addEventListener("drop", (e) => {
    e.preventDefault();
    const before = row.classList.contains("drop-before");
    row.classList.remove("drop-before", "drop-after");
    const dragged = container.querySelector(`[data-song-id="${dragSongId}"]`);
    if (!dragged || dragged === row) return;
    container.insertBefore(dragged, before ? row : row.nextSibling);
    savePlaylistOrder(playlistId, container);
  });
}

async function savePlaylistOrder(playlistId, container, explicitIds = null) {
  const songIds = explicitIds
    || [...container.querySelectorAll("[data-song-id]")].map((el) => el.dataset.songId);
  try {
    const res = await apiFetch(`/api/playlists/${encodeURIComponent(playlistId)}/reorder`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ songIds }),
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { msg = (await res.json()).error || msg; } catch {}
      throw new Error(msg);
    }
    toast("Ordre enregistré");
    // Les index de chaque ligne ont changé : on redessine pour que "Monter",
    // "Descendre" et "Retirer" visent toujours la bonne position.
    if (state.openPlaylist) openPlaylistDetail(playlistId, state.openPlaylist.name);
  } catch (err) {
    toast(`Ordre non enregistré : ${err.message}`);
    // L'affichage a déjà bougé : on recharge pour ne pas laisser un ordre
    // à l'écran qui ne correspond pas à ce qui est stocké.
    if (state.openPlaylist) openPlaylistDetail(playlistId, state.openPlaylist.name);
  }
}

function showPlaylistsList() {
  $("#playlistDetailWrap").classList.add("is-hidden");
  $("#playlistsListWrap").classList.remove("is-hidden");
  state.openPlaylist = null;
}

async function deletePlaylist(pl) {
  // Une playlist n'est qu'une liste de renvois : les fichiers audio restent
  // dans la bibliothèque. Le message doit le dire, sinon on hésite à cliquer.
  if (!confirm(
    `Supprimer la playlist « ${pl.name} » ?\n\n`
    + `Les morceaux restent dans ta bibliothèque, seule la playlist disparaît.`
  )) return;
  try {
    const res = await apiFetch(`/api/playlists/${encodeURIComponent(pl.id)}/delete`, {
      method: "POST",
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { msg = (await res.json()).error || msg; } catch {}
      throw new Error(msg);
    }
    showPlaylistsList();
    toast(`Playlist « ${pl.name} » supprimée`);
    loadPlaylists();
  } catch (err) {
    toast(`Suppression impossible : ${err.message}`);
  }
}

async function resyncPlaylistImports(pl) {
  try {
    const res = await apiFetch(
      `/api/playlists/${encodeURIComponent(pl.id)}/resync-imports`, { method: "POST" });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { msg = (await res.json()).error || msg; } catch {}
      throw new Error(msg);
    }
    const data = await res.json();
    toast(data.added
      ? `${data.added} morceau${data.added > 1 ? "x" : ""} rattaché${data.added > 1 ? "s" : ""} aux imports`
      : "Aucun morceau importé à rattacher");
    if (data.added) openPlaylistDetail(pl.id, pl.name);
  } catch (err) {
    toast(`Rattachement impossible : ${err.message}`);
  }
}

$("#playlistMenuBtn").addEventListener("click", (e) => {
  const pl = state.openPlaylist;
  if (!pl) return;
  openTrackMenu(e.currentTarget, [
    {
      label: "Changer la pochette", icon: "🖼",
      onClick: () => $("#playlistCoverInput").click(),
    },
    {
      label: "Rattacher les imports", icon: "🔗",
      onClick: () => resyncPlaylistImports(pl),
    },
    {
      label: "Supprimer la playlist", icon: "🗑", danger: true,
      onClick: () => deletePlaylist(pl),
    },
  ]);
});

$("#backToPlaylistsBtn").addEventListener("click", () => {
  showPlaylistsList();
});

$("#createPlaylistBtn").addEventListener("click", async () => {
  const name = prompt("Nom de la nouvelle playlist :");
  if (!name || !name.trim()) return;
  try {
    const res = await apiFetch("/api/playlists", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    toast(`Playlist "${name.trim()}" créée`);
    loadPlaylists();
  } catch (err) {
    toast(`Erreur création playlist : ${err.message}`);
  }
});

async function addTrackToPlaylist(playlistId, songId) {
  const res = await apiFetch(`/api/playlists/${encodeURIComponent(playlistId)}/tracks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ songId }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

function closeAnyPicker() {
  document.querySelectorAll(".playlist-picker").forEach((p) => p.remove());
}

function buildPlaylistPickerMenu(navidromeId) {
  const picker = document.createElement("div");
  picker.className = "playlist-picker";
  if (!state.playlists.length) {
    picker.innerHTML = `<div class="picker-empty">Aucune playlist — crée-en une d'abord.</div>`;
    return picker;
  }
  state.playlists.forEach((pl) => {
    const btn = document.createElement("button");
    btn.textContent = pl.name;
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await addTrackToPlaylist(pl.id, navidromeId);
        toast(`Ajouté à "${pl.name}"`);
      } catch (err) {
        toast(`Erreur : ${err.message}`);
      }
      picker.remove();
    });
    picker.appendChild(btn);
  });
  return picker;
}

function attachPicker(anchorEl, picker) {
  anchorEl.style.position = "relative";
  anchorEl.appendChild(picker);
  setTimeout(() => {
    document.addEventListener("click", function closeOnce(e) {
      if (!picker.contains(e.target)) {
        picker.remove();
        document.removeEventListener("click", closeOnce);
      }
    });
  }, 0);
}

async function openPlaylistPicker(anchorEl, track) {
  closeAnyPicker();

  let entry = byLibId(track.id) || (track.navidrome_id ? track : null);
  if (!entry || !entry.navidrome_id) {
    const downloaded = await ensureDownloaded(track);
    entry = downloaded;
    if (!entry || !entry.navidrome_id) {
      toast("Pas encore synchronisé avec Navidrome — réessaie dans quelques secondes.");
      return;
    }
  }

  if (!state.playlists.length) await loadPlaylists();
  attachPicker(anchorEl, buildPlaylistPickerMenu(entry.navidrome_id));
}

async function openPlaylistPickerDirect(anchorEl, navidromeId) {
  closeAnyPicker();
  if (!navidromeId) {
    toast("Pas encore synchronisé avec Navidrome — réessaie dans quelques secondes.");
    return;
  }
  if (!state.playlists.length) await loadPlaylists();
  attachPicker(anchorEl, buildPlaylistPickerMenu(navidromeId));
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    activateView(btn.dataset.view);
    if (btn.dataset.view === "library") {
      $("#playlistDetailWrap").classList.add("is-hidden");
      $("#playlistsListWrap").classList.remove("is-hidden");
      loadPlaylists();
    }
    if (btn.dataset.view === "import") {
      populateImportPlaylistSelect();
    }
  });
});

function activateView(view) {
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("is-active"));
  document.querySelectorAll(`.nav-item[data-view="${view}"]`).forEach((b) => b.classList.add("is-active"));
  document.querySelectorAll(".view").forEach((v) => v.classList.add("is-hidden"));
  $(`#view-${view}`).classList.remove("is-hidden");
}

// ---------------------------------------------------------------------------
// Recherche live avec pagination
// ---------------------------------------------------------------------------
let searchDebounce = null;
let searchAbort = null;        // contrôleur de la requête encore en vol
let searchToken = 0;           // invalide les réponses d'une recherche périmée

const SEARCH_TIMEOUT_MS = 20000;

// Annule la requête en cours et invalide sa réponse. Sans ça, une recherche
// lente lancée sur "blind" pouvait écraser le résultat de "blinding lights"
// arrivé entre-temps.
function cancelInFlightSearch() {
  searchToken++;
  if (searchAbort) {
    searchAbort.abort("superseded");
    searchAbort = null;
  }
}

$("#searchInput").addEventListener("input", (e) => {
  activateView("search");
  const q = e.target.value.trim();

  clearTimeout(searchDebounce);
  cancelInFlightSearch();
  state.search = { query: q, page: 0, results: [] };

  if (!q) {
    $("#searchSub").textContent = "Tape une requête ci-dessus pour interroger le catalogue mondial en direct.";
    $("#searchAlbums").classList.add("is-hidden");
    $("#searchArtists").classList.add("is-hidden");
    renderGrid($("#searchGrid"), [], "");
    return;
  }

  $("#searchSub").textContent = "Recherche en cours…";
  searchDebounce = setTimeout(() => runSearch(q, 0), 350);
});

// Traduit une erreur de fetch en message exploitable.
//
// Un fetch qui échoue SANS statut HTTP signifie que la réponse n'est jamais
// arrivée jusqu'au JS : NAS arrêté, tunnel Cloudflare tombé, ou page d'erreur
// 502 renvoyée sans en-tête Access-Control-Allow-Origin. Le navigateur
// présente ça comme une erreur réseau, ce qui ressemble à un problème de CORS
// alors que la config CORS n'a rien à voir.
function describeSearchError(err) {
  if (err && err.name === "AbortError") {
    // signal.reason vaut "timeout" ou "superseded" selon l'origine.
    const reason = err.reason || (searchAbort && searchAbort.signal.reason);
    return reason === "timeout"
      ? "délai dépassé (20 s), le NAS met trop de temps à répondre — un import est peut-être en cours"
      : null;   // annulation volontaire : on n'affiche rien
  }
  const status = err && err.status;
  if (status === 500) return "erreur serveur — voir upload_server.log sur le NAS";
  if (status === 502 || status === 503) return "le serveur mymusic ne répond pas (arrêté, ou saturé par un import)";
  if (status === 504 || status === 524) return "le NAS a mis trop de temps à répondre (délai Cloudflare dépassé)";
  if (status === 401 || status === 403) return "accès refusé, ressaisis le mot de passe";
  if (status) return `erreur HTTP ${status}`;
  if (!navigator.onLine) return "pas de connexion réseau";
  return "serveur injoignable — le NAS ou le tunnel Cloudflare ne répond pas";
}

async function runSearch(q, page) {
  const token = ++searchToken;

  const ctrl = new AbortController();
  searchAbort = ctrl;
  const timer = setTimeout(() => ctrl.abort("timeout"), SEARCH_TIMEOUT_MS);

  try {
    const res = await apiFetch(
      `/api/search?q=${encodeURIComponent(q)}&page=${page}`,
      { signal: ctrl.signal }
    );
    if (!res.ok) {
      const e = new Error(`HTTP ${res.status}`);
      e.status = res.status;
      throw e;
    }
    const results = await res.json();

    if (token !== searchToken) return;   // une frappe plus récente a pris le relais

    if (page === 0) {
      state.search = { query: q, page: 0, results };
    } else {
      state.search.results = state.search.results.concat(results);
      state.search.page = page;
    }

    $("#searchSub").textContent = `${state.search.results.length} résultat(s) chargé(s) — lecture en streaming, téléchargement sur le NAS uniquement si ajouté à une playlist.`;
    renderSearchResults(results.length === PAGE_SIZE);
  } catch (err) {
    if (token !== searchToken) return;
    if (err && err.name === "AbortError") err.reason = ctrl.signal.reason;
    const msg = describeSearchError(err);
    if (msg) {
      $("#searchSub").textContent = `Erreur de recherche : ${msg}.`;
      if (page === 0) renderGrid($("#searchGrid"), [], "");
    }
    return;
  } finally {
    clearTimeout(timer);
    if (searchAbort === ctrl) searchAbort = null;
  }

  // Albums puis artistes, SÉQUENTIELLEMENT et seulement une fois les morceaux
  // affichés. Auparavant ces trois requêtes partaient en parallèle : sur un
  // HTTPServer mono-thread qui spawn un subprocess Python par recherche, elles
  // se bloquaient mutuellement (~10 s cumulés) et saturaient le backlog TCP —
  // ce que Cloudflare traduit en 502, sans en-tête CORS.
  if (page === 0) {
    await runAlbumSearch(q, token);
    if (token !== searchToken) return;
    await runArtistSearch(q, token);
  }
}

function renderSearchResults(mayHaveMore) {
  const container = $("#searchGrid");
  renderGrid(container, state.search.results, "Aucun résultat pour cette recherche.");

  if (mayHaveMore) {
    const btn = document.createElement("button");
    btn.className = "load-more-btn";
    btn.textContent = "Charger 20 de plus";
    btn.addEventListener("click", () => {
      btn.textContent = "Chargement…";
      btn.disabled = true;
      runSearch(state.search.query, state.search.page + 1);
    });
    container.appendChild(btn);
  }
}

// ---------------------------------------------------------------------------
// Catalogue ALBUMS — n'importe quel album du monde, tracklist COMPLÈTE.
// Différent de l'onglet "Albums" (qui, lui, liste la bibliothèque Navidrome).
// Ici un album s'ouvre en entier même si aucun morceau n'est téléchargé :
//   - piste déjà en bibliothèque -> lecture via Navidrome
//   - piste absente              -> lecture directe (rien n'est écrit sur le NAS)
// ---------------------------------------------------------------------------
async function runAlbumSearch(q, token) {
  const wrap = $("#searchAlbums");
  wrap.innerHTML = `<div class="album-strip-title">Albums</div><div class="empty-state">Recherche d'albums…</div>`;
  wrap.classList.remove("is-hidden");
  try {
    const res = await apiFetch(`/api/search-albums?q=${encodeURIComponent(q)}&limit=6`);
    if (token != null && token !== searchToken) return;   // recherche périmée
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const albums = await res.json();
    if (token != null && token !== searchToken) return;
    if (!Array.isArray(albums) || !albums.length) {
      wrap.classList.add("is-hidden");
      return;
    }
    wrap.innerHTML = `<div class="album-strip-title">Albums</div>`;
    const strip = document.createElement("div");
    strip.className = "album-strip";
    albums.forEach((a) => strip.appendChild(renderAlbumCard(a)));
    wrap.appendChild(strip);
  } catch {
    wrap.classList.add("is-hidden");   // silencieux : les morceaux restent affichés
  }
}

function renderAlbumCard(album) {
  const card = document.createElement("div");
  card.className = "album-card";
  const cover = album.cover
    ? `<img src="${album.cover}" alt="" loading="lazy">`
    : `<div class="album-card-fallback">${initials(album.name)}</div>`;
  card.innerHTML = `
    <div class="album-card-cover">${cover}</div>
    <div class="album-card-name">${album.name}</div>
    <div class="album-card-meta">${album.artist}${album.year ? " · " + album.year : ""}</div>
  `;
  card.addEventListener("click", () => openCatalogAlbum(album.id));
  return card;
}

function renderCatalogTrackRow(track, tracks, album) {
  const row = document.createElement("div");
  row.className = "track-row";
  row.dataset.trackId = track.id;
  const owned = track.in_library || isCached(track.id);
  row.innerHTML = `
    <div class="track-row-cover track-row-num">${track.track}</div>
    <div>
      <div class="track-row-title">${track.title}</div>
      <div class="track-row-artist">${track.artist}</div>
    </div>
    <span class="track-row-status ${owned ? "cached" : ""}">${owned ? "Bibliothèque" : "Streaming"}</span>
    <span class="row-actions">
      ${favBtnHtml(track)}
      <button class="row-action" title="${owned ? "Ajouter à une playlist" : "Télécharger sur le NAS"}">${owned ? "＋" : "⤓"}</button>
    </span>
    <span class="track-row-duration">${formatTime(track.duration)}</span>
  `;

  // Contexte de lecture : tout l'album, pour l'enchaînement des pistes.
  const queue = tracks.map((t) => ({ ...t, cover: t.cover || album.cover }));
  const self = { ...track, cover: track.cover || album.cover };
  wireFav(row, self);

  row.addEventListener("click", (e) => {
    if (e.target.closest(".row-action") || e.target.closest("[data-fav]")) return;
    const entry = byLibId(track.id);
    if (entry) playTrack(entry, state.library);      // possédé -> Navidrome
    else playTrack(self, queue);                     // sinon -> streaming direct
  });

  row.querySelector(".row-action").addEventListener("click", async (e) => {
    e.stopPropagation();
    const entry = byLibId(track.id) || await ensureDownloaded(self);
    if (entry) openPlaylistPickerDirect(e.currentTarget, entry.navidrome_id);
  });

  return row;
}

async function openCatalogAlbum(browseId) {
  activateView("catalog-album");
  const head = $("#catAlbumHead");
  const container = $("#catAlbumTracks");
  head.innerHTML = "";
  container.innerHTML = `<div class="empty-state">Chargement de l'album…</div>`;

  try {
    const res = await apiFetch(`/api/album/${encodeURIComponent(browseId)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const album = await res.json();
    const tracks = album.tracks || [];

    const cover = album.cover
      ? `<img src="${album.cover}" alt="" loading="lazy">`
      : `<div class="album-card-fallback">${initials(album.name)}</div>`;

    head.innerHTML = `
      <div class="cat-album-head">
        <div class="cat-album-cover">${cover}</div>
        <div class="cat-album-info">
          <div class="cat-album-kicker">Album</div>
          <h1 class="view-title">${album.name}</h1>
          <div class="view-sub">${album.artist}${album.year ? " · " + album.year : ""} · ${tracks.length} titre${tracks.length > 1 ? "s" : ""}</div>
          <div class="cat-album-actions">
            <button class="primary-btn" id="catAlbumPlay">▶ Lecture</button>
            <button class="primary-btn ghost" id="catAlbumShuffle">🔀 Aléatoire</button>
          </div>
        </div>
      </div>
    `;

    container.innerHTML = "";
    if (!tracks.length) {
      container.innerHTML = `<div class="empty-state">Aucun morceau disponible pour cet album.</div>`;
      return;
    }
    tracks.forEach((t) => container.appendChild(renderCatalogTrackRow(t, tracks, album)));

    const queue = tracks.map((t) => ({ ...t, cover: t.cover || album.cover }));
    $("#catAlbumPlay").addEventListener("click", () => {
      if (queue[0]) playTrack(byLibId(queue[0].id) || queue[0], queue);
    });
    $("#catAlbumShuffle").addEventListener("click", () => {
      if (!queue.length) return;
      state.shuffle = true;
      $("#shuffleBtn").classList.add("is-active");
      const pick = queue[Math.floor(Math.random() * queue.length)];
      playTrack(byLibId(pick.id) || pick, queue);
    });
  } catch (err) {
    container.innerHTML = `<div class="empty-state">Erreur : ${err.message}</div>`;
  }
}

$("#backToSearchBtn").addEventListener("click", () => {
  // Retour contextuel : si la vue album a été ouverte depuis l'accueil on y
  // revient, sinon comportement historique (retour à la recherche). Repli sur
  // "search" si aucune vue "home" n'existe sous cet id.
  const goHome = homeReturnFromAlbum && document.getElementById("view-home");
  homeReturnFromAlbum = false;
  activateView(goHome ? "home" : "search");
});

// ---------------------------------------------------------------------------
// Catalogue ARTISTES — page artiste : populaires + albums + singles.
// Les morceaux se lisent/téléchargent comme ceux d'un album ; les albums et
// singles rebranchent sur openCatalogAlbum (la vue album déjà construite).
// ---------------------------------------------------------------------------
async function runArtistSearch(q, token) {
  const wrap = $("#searchArtists");
  wrap.innerHTML = `<div class="album-strip-title">Artistes</div><div class="empty-state">Recherche d'artistes…</div>`;
  wrap.classList.remove("is-hidden");
  try {
    const res = await apiFetch(`/api/search-artists?q=${encodeURIComponent(q)}&limit=4`);
    if (token != null && token !== searchToken) return;   // recherche périmée
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const artists = await res.json();
    if (token != null && token !== searchToken) return;
    if (!Array.isArray(artists) || !artists.length) {
      wrap.classList.add("is-hidden");
      return;
    }
    wrap.innerHTML = `<div class="album-strip-title">Artistes</div>`;
    const strip = document.createElement("div");
    strip.className = "album-strip";
    artists.forEach((a) => strip.appendChild(renderArtistCard(a)));
    wrap.appendChild(strip);
  } catch {
    wrap.classList.add("is-hidden");
  }
}

function renderArtistCard(artist) {
  const card = document.createElement("div");
  card.className = "album-card artist-card";
  const cover = artist.cover
    ? `<img src="${artist.cover}" alt="" loading="lazy">`
    : `<div class="album-card-fallback">${initials(artist.name)}</div>`;
  card.innerHTML = `
    <div class="album-card-cover artist-cover">${cover}</div>
    <div class="album-card-name">${artist.name}</div>
    ${artist.subscribers ? `<div class="album-card-meta">${artist.subscribers} abonnés</div>` : ``}
  `;
  card.addEventListener("click", () => openArtist(artist.id));
  return card;
}

function renderArtistSongRow(track, tracks) {
  const row = document.createElement("div");
  row.className = "track-row";
  const owned = track.in_library || isCached(track.id);
  row.innerHTML = `
    <div class="track-row-cover track-row-num">♪</div>
    <div>
      <div class="track-row-title">${track.title}</div>
      <div class="track-row-artist">${track.artist}</div>
    </div>
    <span class="track-row-status ${owned ? "cached" : ""}">${owned ? "Bibliothèque" : "Streaming"}</span>
    <span class="row-actions">
      ${favBtnHtml(track)}
      <button class="row-action" title="${owned ? "Ajouter à une playlist" : "Télécharger sur le NAS"}">${owned ? "＋" : "⤓"}</button>
    </span>
    <span class="track-row-duration">${formatTime(track.duration)}</span>
  `;
  const queue = tracks.map((t) => ({ ...t }));
  const self = { ...track };
  wireFav(row, self);
  row.addEventListener("click", (e) => {
    if (e.target.closest(".row-action") || e.target.closest("[data-fav]")) return;
    const entry = byLibId(track.id);
    if (entry) playTrack(entry, state.library);
    else playTrack(self, queue);
  });
  row.querySelector(".row-action").addEventListener("click", async (e) => {
    e.stopPropagation();
    const entry = byLibId(track.id) || await ensureDownloaded(self);
    if (entry) openPlaylistPickerDirect(e.currentTarget, entry.navidrome_id);
  });
  return row;
}

// Rapproche un tag artiste (fichier déjà téléchargé) du nom d'un artiste du
// catalogue. Égalité normalisée, ou bien l'artiste figure comme collaborateur
// dans un tag « A, B » / « A feat. B » / « A & B » / « A / B ».
function artistTagMatches(entryArtist, targetName) {
  const target = normalize(targetName).trim();
  if (!target) return false;
  const a = normalize(entryArtist).trim();
  if (!a) return false;
  if (a === target) return true;
  return a
    .split(/\s*(?:,|&|\/|;|\bfeat\.?(?=\s|$)|\bfeaturing(?=\s|$)|\bft\.?(?=\s|$))\s*/)
    .some((tok) => tok.trim() === target);
}

// Ligne d'un morceau DÉJÀ dans la bibliothèque, affichée sur la page artiste.
// Lecture via Navidrome (navidrome_id), favori et ajout à une playlist comme
// partout ailleurs. File d'attente = tes autres morceaux de cet artiste.
function renderArtistLibraryRow(track, queue) {
  const row = document.createElement("div");
  row.className = "track-row";
  row.innerHTML = `
    ${coverHtml(track, track.id)}
    <div>
      <div class="track-row-title">${track.title}</div>
      <div class="track-row-artist">${track.artist || ""}</div>
    </div>
    <span class="track-row-status cached">Bibliothèque</span>
    <span class="row-actions">
      ${favBtnHtml(track)}
      <button class="row-action" title="Ajouter à une playlist">＋</button>
    </span>
    <span class="track-row-duration">${formatTime(track.duration)}</span>
  `;
  wireFav(row, track);
  row.addEventListener("click", (e) => {
    if (e.target.closest(".row-action") || e.target.closest("[data-fav]")) return;
    playTrack(track, queue);
  });
  row.querySelector(".row-action").addEventListener("click", (e) => {
    e.stopPropagation();
    openPlaylistPickerDirect(e.currentTarget, track.navidrome_id);
  });
  return row;
}

async function openArtist(browseId) {
  activateView("artist");
  const head = $("#artistHead");
  const body = $("#artistBody");
  head.innerHTML = "";
  body.innerHTML = `<div class="empty-state">Chargement de l'artiste…</div>`;

  try {
    const res = await apiFetch(`/api/artist/${encodeURIComponent(browseId)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const artist = await res.json();

    const cover = artist.cover
      ? `<img src="${artist.cover}" alt="" loading="lazy">`
      : `<div class="album-card-fallback">${initials(artist.name)}</div>`;

    head.innerHTML = `
      <div class="artist-head">
        <div class="artist-photo">${cover}</div>
        <div class="artist-headinfo">
          <div class="cat-album-kicker">Artiste</div>
          <h1 class="view-title">${artist.name}</h1>
          ${artist.subscribers ? `<div class="view-sub">${artist.subscribers}</div>` : ``}
        </div>
      </div>
    `;

    body.innerHTML = "";

    // Section « Dans ta bibliothèque » : tous tes morceaux déjà téléchargés de
    // cet artiste, pas seulement ceux qui recoupent les Populaires du catalogue.
    const owned = state.library.filter((t) => artistTagMatches(t.artist, artist.name));
    if (owned.length) {
      const h = document.createElement("h2");
      h.className = "artist-section-title";
      h.textContent = `Dans ta bibliothèque · ${owned.length}`;
      body.appendChild(h);
      const list = document.createElement("div");
      list.className = "track-list";
      owned.forEach((t) => list.appendChild(renderArtistLibraryRow(t, owned)));
      body.appendChild(list);
    }

    // Section populaires
    const songs = artist.songs || [];
    if (songs.length) {
      const h = document.createElement("h2");
      h.className = "artist-section-title";
      h.textContent = "Populaires";
      body.appendChild(h);
      const list = document.createElement("div");
      list.className = "track-list";
      songs.forEach((t) => list.appendChild(renderArtistSongRow(t, songs)));
      body.appendChild(list);
    }

    // Sections albums et singles -> réutilisent la carte album + openCatalogAlbum
    const addReleases = (title, releases) => {
      if (!releases || !releases.length) return;
      const h = document.createElement("h2");
      h.className = "artist-section-title";
      h.textContent = title;
      body.appendChild(h);
      const strip = document.createElement("div");
      strip.className = "album-strip";
      releases.forEach((r) => strip.appendChild(renderAlbumCard(r)));
      body.appendChild(strip);
    };
    addReleases("Albums", artist.albums);
    addReleases("Singles & EP", artist.singles);

    if (!owned.length && !songs.length && !(artist.albums || []).length && !(artist.singles || []).length) {
      body.innerHTML = `<div class="empty-state">Aucun contenu disponible pour cet artiste.</div>`;
    }
  } catch (err) {
    body.innerHTML = `<div class="empty-state">Erreur : ${err.message}</div>`;
  }
}

$("#backToSearchBtn2").addEventListener("click", () => activateView("search"));

// ---------------------------------------------------------------------------
// Téléchargement (recherche -> bibliothèque locale -> Navidrome)
// ---------------------------------------------------------------------------
async function ensureDownloaded(track) {
  const existing = byLibId(track.id);
  if (existing) return existing;

  const el = document.querySelector(`[data-track-id="${track.id}"]`);
  el?.classList.add("is-loading");
  toast(`Téléchargement de "${track.title}"…`);

  try {
    const res = await apiFetch("/api/library", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(track),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const entry = await res.json();
    state.library.push(entry);
    renderAll();
    return entry;
  } catch (err) {
    toast(`Échec du téléchargement : ${err.message}`);
    return null;
  } finally {
    el?.classList.remove("is-loading");
  }
}

function handleTrackActivate(track) {
  const existing = byLibId(track.id);
  if (existing) {
    // Déjà téléchargé (ajouté à une playlist auparavant) -> flux Navidrome.
    playTrack(existing, state.library);
    return;
  }
  // Lecture à la demande : streaming direct, AUCUN téléchargement sur le NAS.
  // Le téléchargement réel n'a lieu que si l'utilisateur ajoute ce morceau
  // à une playlist (voir openPlaylistPicker -> ensureDownloaded).
  const queue = state.search.results.length ? state.search.results : [track];
  playTrack(track, queue);
}

// ---------------------------------------------------------------------------
// Import — upload manuel de fichiers audio déjà présents sur le disque,
// avec choix obligatoire d'une playlist de destination (existante ou nouvelle).
// Tous les fichiers d'une sélection partent dans UNE seule requête : le NAS
// ne déclenche alors qu'un scan Navidrome pour l'ensemble, au lieu d'un par
// fichier (chaque scan coûte plusieurs secondes sur le DS218).
// ---------------------------------------------------------------------------
const dropzone = $("#dropzone");
const fileInput = $("#fileInput");
const importPlaylistSelect = $("#importPlaylistSelect");
const importNewPlaylistName = $("#importNewPlaylistName");
const importProgressEl = $("#importProgress");
const importLockedNote = $("#importLockedNote");

// Doit rester aligné sur AUDIO_EXTENSIONS dans upload_server.py.
const AUDIO_EXTENSIONS = [
  ".mp3", ".m4a", ".m4b", ".mp4", ".aac", ".flac",
  ".wav", ".wave", ".aif", ".aiff", ".aifc",
  ".ogg", ".oga", ".opus", ".wma", ".ape", ".wv", ".mpc",
];
const ACCEPTED_EXTENSIONS = [...AUDIO_EXTENSIONS, ".zip"];

// Formats que le NAS doit transcoder : sert uniquement à prévenir l'utilisateur
// que l'import prendra plus longtemps (la décision réelle se prend côté serveur
// sur le codec, pas sur l'extension — un .m4a en ALAC est converti, en AAC non).
const TRANSCODED_EXTENSIONS = [
  ".wav", ".wave", ".aif", ".aiff", ".aifc",
  ".ogg", ".oga", ".opus", ".wma", ".ape", ".wv", ".mpc",
];

function fileExtension(name) {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i).toLowerCase();
}

// Renvoie { playlist_id } ou { playlist_name } si un choix valide est fait,
// sinon null (dropzone désactivée dans ce cas — voir syncImportDropzoneState).
function currentImportPlaylistChoice() {
  const val = importPlaylistSelect.value;
  if (val === "__new__") {
    const name = importNewPlaylistName.value.trim();
    return name ? { playlist_name: name } : null;
  }
  return val ? { playlist_id: val } : null;
}

function syncImportDropzoneState() {
  const ready = !!currentImportPlaylistChoice();
  dropzone.classList.toggle("is-disabled", !ready);
  importLockedNote?.classList.toggle("is-hidden", ready);
}

async function populateImportPlaylistSelect() {
  await loadPlaylists();
  const previous = importPlaylistSelect.value;
  importPlaylistSelect.innerHTML = `
    <option value="" disabled>Choisir une playlist…</option>
    <option value="__new__">＋ Nouvelle playlist</option>
  ` + state.playlists.map((pl) =>
    `<option value="${pl.id}">${pl.name} (${pl.songCount})</option>`
  ).join("");
  importPlaylistSelect.value = state.playlists.some((pl) => pl.id === previous) || previous === "__new__"
    ? previous
    : "";
  syncImportDropzoneState();
}

importPlaylistSelect.addEventListener("change", () => {
  importNewPlaylistName.classList.toggle("is-hidden", importPlaylistSelect.value !== "__new__");
  if (importPlaylistSelect.value === "__new__") importNewPlaylistName.focus();
  syncImportDropzoneState();
});
importNewPlaylistName.addEventListener("input", syncImportDropzoneState);

fileInput.addEventListener("change", (e) => {
  if (e.target.files.length) uploadFiles(Array.from(e.target.files));
  fileInput.value = "";
});

["dragenter", "dragover"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add("is-dragover");
  })
);
["dragleave", "drop"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove("is-dragover");
  })
);
dropzone.addEventListener("drop", (e) => {
  const files = Array.from(e.dataTransfer.files || []);
  if (files.length) uploadFiles(files);
});

// ---------------------------------------------------------------------------
// Ouverture des .zip dans le navigateur
// ---------------------------------------------------------------------------
// Une archive part en un seul morceau : impossible à découper, donc refusée
// par Cloudflare dès 100 Mo. On l'éclate ici en fichiers individuels, que le
// découpage en lots sait ensuite faire passer. Lecture du "central directory"
// en fin d'archive, plus fiable que d'enchaîner les en-têtes locaux.
const ZIP_EOCD_SIG = 0x06054b50;
const ZIP_CD_SIG = 0x02014b50;

function findZipEOCD(view) {
  // Le commentaire d'archive peut atteindre 65535 octets : on remonte depuis
  // la fin jusqu'à la signature.
  const max = Math.min(view.byteLength, 65535 + 22);
  for (let i = 22; i <= max; i++) {
    const off = view.byteLength - i;
    if (view.getUint32(off, true) === ZIP_EOCD_SIG) return off;
  }
  return -1;
}

function readZipEntries(buffer) {
  const view = new DataView(buffer);
  const eocd = findZipEOCD(view);
  if (eocd < 0) throw new Error("archive illisible");

  const count = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  // Zip64 : les champs 32 bits saturent au-delà de 4 Go.
  if (cdOffset === 0xffffffff || count === 0xffff) {
    throw new Error("archive zip64 non supportée");
  }

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== ZIP_CD_SIG) break;
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = new TextDecoder("utf-8").decode(new Uint8Array(buffer, p + 46, nameLen));
    entries.push({ name, method, compressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function extractZipEntry(buffer, entry) {
  const view = new DataView(buffer);
  // L'en-tête local a ses propres longueurs de nom/extra, souvent différentes
  // de celles du central directory : il faut les relire ici.
  const nameLen = view.getUint16(entry.localOffset + 26, true);
  const extraLen = view.getUint16(entry.localOffset + 28, true);
  const start = entry.localOffset + 30 + nameLen + extraLen;
  const raw = buffer.slice(start, start + entry.compressedSize);

  if (entry.method === 0) return raw;   // stocké tel quel
  if (entry.method !== 8) throw new Error(`compression ${entry.method} non supportée`);
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return await new Response(stream).arrayBuffer();
}

// Remplace chaque .zip de la sélection par les fichiers audio qu'il contient.
// Les autres fichiers passent tels quels.
async function expandZips(files, onProgress) {
  const out = [];
  const failed = [];
  for (const file of files) {
    if (fileExtension(file.name) !== ".zip") {
      out.push(file);
      continue;
    }
    try {
      if (onProgress) onProgress(`Ouverture de ${file.name}…`);
      const buffer = await file.arrayBuffer();
      const entries = readZipEntries(buffer).filter((e) => {
        const base = e.name.split("/").pop();
        return base && !base.startsWith(".") && AUDIO_EXTENSIONS.includes(fileExtension(base));
      });
      if (!entries.length) {
        failed.push({ filename: file.name, reason: "aucun fichier audio dans l'archive" });
        continue;
      }
      for (const entry of entries) {
        const base = entry.name.split("/").pop();
        if (onProgress) onProgress(`Extraction de ${base}…`);
        const data = await extractZipEntry(buffer, entry);
        out.push(new File([data], base, { type: "application/octet-stream" }));
      }
    } catch (err) {
      // Repli : on laisse l'archive telle quelle, le NAS sait aussi la dézipper.
      // Elle ne passera que si elle tient sous la limite de taille.
      console.warn(`Zip non ouvert côté navigateur (${file.name}) :`, err);
      out.push(file);
    }
  }
  return { files: out, failed };
}

// Cloudflare (plan gratuit) refuse tout corps de requête au-delà de 100 Mo :
// la requête est bloquée à la frontière, sans en-têtes CORS, ce que le
// navigateur signale comme une erreur CORS trompeuse. On découpe donc
// l'envoi en lots. Marge volontairement large : le multipart ajoute son
// propre encodage par-dessus la taille des fichiers.
const UPLOAD_BATCH_MAX_BYTES = 70 * 1024 * 1024;

// Un fichier seul au-delà de cette taille ne passera par aucun découpage.
const SINGLE_FILE_MAX_BYTES = 95 * 1024 * 1024;

function splitIntoBatches(files) {
  const batches = [];
  let current = [];
  let size = 0;
  for (const f of files) {
    if (current.length && size + f.size > UPLOAD_BATCH_MAX_BYTES) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(f);
    size += f.size;
  }
  if (current.length) batches.push(current);
  return batches;
}

function formatSize(bytes) {
  return bytes >= 1024 * 1024
    ? `${Math.round(bytes / 1024 / 1024)} Mo`
    : `${Math.round(bytes / 1024)} ko`;
}

async function uploadFiles(rawFiles) {
  const choice = currentImportPlaylistChoice();
  if (!choice) {
    toast("Choisis d'abord une playlist de destination.");
    return;
  }

  const resultEl = $("#importResult");

  // Les archives sont ouvertes ici : un .zip de 105 Mo ne franchirait jamais
  // le tunnel d'un bloc, alors que les pistes qu'il contient passent en lots.
  const { files, failed: zipFailed } = await expandZips(rawFiles, (msg) =>
    renderImportProgress(importProgressEl, msg, 0, 1)
  );

  const tooBig = files.filter((f) => f.size > SINGLE_FILE_MAX_BYTES);
  const sized = files.filter((f) => f.size <= SINGLE_FILE_MAX_BYTES);
  const accepted = sized.filter((f) => ACCEPTED_EXTENSIONS.includes(fileExtension(f.name)));
  const refused = sized.filter((f) => !ACCEPTED_EXTENSIONS.includes(fileExtension(f.name)));

  if (!accepted.length) {
    clearImportProgress();
    resultEl.innerHTML = "";
    toast(tooBig.length
      ? `Fichier trop volumineux (${formatSize(tooBig[0].size)}). Passe par File Station.`
      : (rawFiles.length === 1
          ? `Format non supporté : ${rawFiles[0].name}`
          : "Aucun fichier audio dans cette sélection."));
    return;
  }

  const batches = splitIntoBatches(accepted);
  renderImportQueue(accepted);
  const allTracks = [];
  const allRejected = [
    ...zipFailed,
    ...refused.map((f) => ({ filename: f.name, reason: "format non supporté" })),
    ...tooBig.map((f) => ({
      filename: f.name,
      reason: `trop volumineux (${formatSize(f.size)}) pour le tunnel`,
    })),
  ];
  let playlistInfo = null;
  // Le 1er lot peut créer la playlist ; les suivants doivent la viser par id,
  // sinon on se retrouverait avec plusieurs playlists du même nom.
  let target = { ...choice };

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const prefix = batches.length > 1 ? `Lot ${b + 1}/${batches.length} — ` : "";

    try {
      renderImportProgress(importProgressEl, prefix + `Envoi de ${batch.length} fichier(s)…`, 0, batch.length);

      const formData = new FormData();
      batch.forEach((f) => formData.append("file", f));
      if (target.playlist_id) formData.append("playlist_id", target.playlist_id);
      if (target.playlist_name) formData.append("playlist_name", target.playlist_name);

      const res = await apiFetch("/upload", { method: "POST", body: formData });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
      const start = await res.json();
      allRejected.push(...(start.rejected || []));

      // Le NAS convertit en tâche de fond : on suit l'avancement plutôt que
      // de laisser la requête ouverte (Cloudflare la couperait à 100 s).
      const job = await pollImportJob(start.job_id, prefix, importProgressEl);
      allTracks.push(...(job.tracks || []));
      allRejected.push(...(job.rejected || []));
      if (job.playlist) {
        playlistInfo = job.playlist;
        target = { playlist_id: job.playlist.id };
      }
    } catch (err) {
      allRejected.push(...batch.map((f) => ({
        filename: f.name,
        reason: `échec de l'envoi : ${err.message}`,
      })));
    }
  }

  const playlist = playlistInfo || { id: "", name: choice.playlist_name || "la playlist" };
  clearImportProgress();
  if (allTracks.length) {
    toast(`${allTracks.length > 1 ? `${allTracks.length} morceaux importés` : "1 morceau importé"} dans "${playlist.name}"`);
  } else {
    toast("Aucun morceau importé.");
  }
  renderImportResult({ tracks: allTracks, rejected: allRejected, playlist });

  if (importPlaylistSelect.value === "__new__" && playlistInfo) {
    importNewPlaylistName.value = "";
    await populateImportPlaylistSelect();
    importPlaylistSelect.value = playlistInfo.id;
    importNewPlaylistName.classList.add("is-hidden");
    syncImportDropzoneState();
  }
}

// Carte de progression. `done === 0` (ou total inconnu) => barre indéterminée
// (envoi en cours, pas d'octets exposés par fetch) ; sinon barre déterminée.
function renderImportProgress(el, label, done, total) {
  const determinate = total > 0 && done > 0;
  const pct = determinate ? Math.round((done / total) * 100) : 0;
  const count = total > 1 ? `${done} / ${total}` : "";
  el.innerHTML = `
    <div class="import-progress-card">
      <div class="import-progress-head">
        <span class="import-spinner"></span>
        <span class="import-progress-label">${label}</span>
        ${count ? `<span class="import-progress-count">${count}</span>` : ""}
      </div>
      <div class="import-progress-bar ${determinate ? "" : "indeterminate"}">
        <div class="import-progress-fill" style="width:${pct}%"></div>
      </div>
    </div>`;
}

function clearImportProgress() {
  if (importProgressEl) importProgressEl.innerHTML = "";
}

// File d'attente affichée pendant le traitement : la liste des fichiers acceptés,
// en attente de confirmation du NAS. Le résultat définitif (rendu ensuite par
// renderImportResult) fait autorité.
function renderImportQueue(files) {
  const el = $("#importResult");
  el.innerHTML = `<div class="import-list">` + files.map((f) => `
    <div class="import-row pending">
      <div class="import-row-cover" style="background:${coverGradient(f.name)}">${initials(f.name.replace(/\.[^.]+$/, ""))}</div>
      <div class="import-row-main">
        <div class="import-row-title">${f.name}</div>
        <div class="import-row-sub">${formatSize(f.size)}</div>
      </div>
      <span class="import-chip wait">En file</span>
    </div>`).join("") + `</div>`;
}

// Interroge /api/import/<id> jusqu'à la fin. Intervalle volontairement lâche :
// le DS218 a mieux à faire que répondre à un sondage serré pendant qu'il
// transcode.
async function pollImportJob(jobId, prefix, resultEl) {
  const DELAY_MS = 2000;
  const MAX_SILENCE_MS = 10 * 60 * 1000;   // garde-fou si le serveur redémarre
  const startedAt = Date.now();

  while (true) {
    await new Promise((r) => setTimeout(r, DELAY_MS));

    let job;
    try {
      const res = await apiFetch(`/api/import/${jobId}`);
      if (res.status === 404) throw new Error("import introuvable (serveur redémarré ?)");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      job = await res.json();
    } catch (err) {
      if (Date.now() - startedAt > MAX_SILENCE_MS) throw err;
      continue;   // coupure réseau passagère : on retente
    }

    renderImportProgress(resultEl, prefix + (job.step || "Traitement…"), job.done, job.total);

    if (job.state === "done") return job;
    if (job.state === "error") throw new Error(job.error || "import échoué");
    if (Date.now() - startedAt > MAX_SILENCE_MS) {
      throw new Error("délai dépassé — vérifie le log du NAS");
    }
  }
}

function renderImportResult(data) {
  const resultEl = $("#importResult");
  const okN = data.tracks.length;
  const skipN = (data.rejected || []).length;

  const summary = document.createElement("div");
  summary.className = "import-summary";
  summary.innerHTML =
    `<span>${okN ? (okN > 1 ? `${okN} morceaux importés` : "1 morceau importé") : "Aucun import"}</span>`
    + (okN ? `<span class="import-summary-chip ok">${okN} ✓</span>` : "")
    + (skipN ? `<span class="import-summary-chip skip">${skipN} ignoré${skipN > 1 ? "s" : ""}</span>` : "");

  const list = document.createElement("div");
  list.className = "import-list";
  data.tracks.forEach((entry) => list.appendChild(renderImportedTrackRow(entry, data.playlist.name)));
  (data.rejected || []).forEach((entry) => list.appendChild(renderRejectedRow(entry)));

  resultEl.innerHTML = "";
  resultEl.appendChild(summary);
  resultEl.appendChild(list);
}

function renderRejectedRow(entry) {
  const row = document.createElement("div");
  row.className = "import-row error";
  row.innerHTML = `
    <div class="import-row-cover err">✕</div>
    <div class="import-row-main">
      <div class="import-row-title">${entry.filename}</div>
      <div class="import-row-sub">Non importé — ${entry.reason}</div>
    </div>
    <span class="import-chip skip">Ignoré</span>
  `;
  return row;
}

function renderImportedTrackRow(entry, playlistName) {
  const row = document.createElement("div");
  row.className = "import-row";
  const status = entry.navidrome_id
    ? (entry.added_to_playlist ? `Ajouté à « ${playlistName} »` : "Ajouté à ta bibliothèque")
    : "Indexation en cours…";
  // L'artiste vient des tags lus par le NAS ; absent sur un fichier mal taggé.
  const subtitle = entry.artist ? `${entry.artist} · ${status}` : status;
  row.innerHTML = `
    <div class="import-row-cover" style="background:${coverGradient(entry.filename)}">${initials(entry.title)}</div>
    <div class="import-row-main">
      <div class="import-row-title">${entry.title}</div>
      <div class="import-row-sub">${subtitle}</div>
    </div>
    <button class="playlist-add-btn" data-add title="Ajouter à une playlist">＋</button>
    <span class="import-chip ok">Importé</span>
  `;
  row.querySelector("[data-add]").addEventListener("click", (e) => {
    e.stopPropagation();
    openPlaylistPickerDirect(e.currentTarget, entry.navidrome_id);
  });
  return row;
}

// ---------------------------------------------------------------------------
// Lecteur — préfère le flux Navidrome (navidrome_id), sinon repli local
// ---------------------------------------------------------------------------
// --- Robustesse lecture ------------------------------------------------------
// Ignore l'AbortError (interruption bénigne quand on change vite de morceau)
// et réessaie UNE fois, en douceur, un chargement qui échoue de façon
// transitoire (NAS mono-thread occupé, hoquet du tunnel Cloudflare, etc.).
let playGen = 0;         // incrémenté à chaque nouveau morceau lancé
let loadCycle = 0;       // incrémenté à chaque tentative de chargement (1re + retry)
let cycleFailed = false; // évite de compter 2× le même échec (rejet play() + event "error")
let hasRetried = false;  // un seul retry auto par morceau
let attemptUrl = null;   // URL du morceau courant, pour le retry

function startPlay(url) {
  playGen++;
  attemptUrl = url;
  hasRetried = false;
  loadAndPlay(url);
}

function loadAndPlay(url) {
  const gen = playGen;
  const cycle = ++loadCycle;
  cycleFailed = false;
  audioEl.pause();       // coupe un éventuel chargement en cours → moins de races
  audioEl.src = url;
  audioEl.play().catch((err) => {
    // Remplacé par un morceau plus récent : bénin, on ignore.
    if (err && err.name === "AbortError") return;
    registerPlayFailure(gen, cycle);
  });
}

function registerPlayFailure(gen, cycle) {
  if (gen !== playGen) return;     // un autre morceau a été lancé depuis
  if (cycle !== loadCycle) return; // signal issu d'un ancien cycle de chargement
  if (cycleFailed) return;         // rejet play() + event "error" arrivent ensemble → 1 seule fois
  cycleFailed = true;
  if (!hasRetried) {
    hasRetried = true;
    setTimeout(() => {
      if (gen !== playGen) return; // annulé si l'utilisateur a changé de morceau entre-temps
      const sep = attemptUrl.includes("?") ? "&" : "?";
      loadAndPlay(attemptUrl + sep + "r=" + Date.now()); // cache-buster → requête neuve
    }, 700);
  } else {
    toast("Lecture impossible. Réessaie dans un instant.");
  }
}

function playTrack(track, queue) {
  const key = track.navidrome_id || track.id;
  if (state.currentTrackId === key) {
    togglePlayPause();
    return;
  }

  if (state.currentTrackObj) {
    state.playHistory.push(state.currentTrackObj);
    if (state.playHistory.length > 50) state.playHistory.shift();
  }

  state.currentTrackId = key;
  state.currentTrackObj = track;
  state.playQueue = queue && queue.length ? queue : [track];

  let trackStreamUrl, cachePillLabel;
  if (track.navidrome_id) {
    // Téléchargé + synchronisé Navidrome (ajouté à une playlist).
    trackStreamUrl = streamUrlWithKey(`/api/stream-nd/${encodeURIComponent(track.navidrome_id)}`);
    cachePillLabel = "Navidrome";
  } else if (track.filename) {
    // Téléchargé (ajout playlist en cours) mais pas encore resynchro Navidrome.
    trackStreamUrl = streamUrlWithKey(`/api/stream/${encodeURIComponent(track.id)}`);
    cachePillLabel = "Local";
  } else {
    // Jamais téléchargé : streaming à la demande, rien n'est écrit sur le NAS.
    trackStreamUrl = streamUrlWithKey(`/api/stream-direct/${encodeURIComponent(track.id)}`);
    cachePillLabel = "Streaming";
  }

  startPlay(trackStreamUrl);

  $("#playerTitle").textContent = track.title;
  $("#playerArtist").textContent = track.artist;
  $("#playerCover").innerHTML = coverHtml(track, key, "", true);
  $("#playerCover").style.background = coverGradient(key);
  $("#playerCachePill").textContent = cachePillLabel;
  $("#playerCachePill").className = "cache-pill cached";
  updatePlayerLike();
}

function togglePlayPause() {
  if (!state.currentTrackId) return;
  if (audioEl.paused) audioEl.play().catch(() => {});
  else audioEl.pause();
}

const ICON_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';

audioEl.addEventListener("play", () => {
  state.isPlaying = true;
  $("#playBtn").innerHTML = ICON_PAUSE;
  $("#playBtn").title = "Pause";
  document.querySelector(".player")?.classList.add("is-playing");
});
audioEl.addEventListener("pause", () => {
  state.isPlaying = false;
  $("#playBtn").innerHTML = ICON_PLAY;
  $("#playBtn").title = "Lecture";
  document.querySelector(".player")?.classList.remove("is-playing");
});
audioEl.addEventListener("loadedmetadata", () => {
  $("#timeTotal").textContent = formatTime(audioEl.duration);
});

// ── Scrobble ────────────────────────────────────────────────────────────────
// Navidrome n'enregistre une écoute que si un client la lui signale
// explicitement. Sans cet appel, la base reste vide et aucune recommandation
// personnalisée n'est possible.
//
// Le seuil suit la convention Last.fm : 30 s de lecture, ou la moitié du
// morceau si celui-ci dure moins d'une minute. playGen sert de clé
// anti-doublon — il est incrémenté à chaque nouveau morceau lancé — donc un
// retour en arrière dans la piste ne renvoie rien, alors qu'une relecture
// complète compte bien comme une seconde écoute.
let scrobbledGen = -1;

async function sendScrobble(track) {
  // Seuls les morceaux connus de Navidrome sont scrobblables : un ID YouTube
  // joué en streaming direct n'a aucun équivalent en base, l'API renverrait
  // une erreur à chaque piste.
  if (!track || !track.navidrome_id) return;
  try {
    await apiFetch("/api/scrobble", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: track.navidrome_id }),
    });
  } catch {
    // Échec silencieux et volontaire : une écoute perdue ne doit jamais
    // perturber la lecture en cours.
  }
}
audioEl.addEventListener("timeupdate", () => {
  const pct = audioEl.duration ? (audioEl.currentTime / audioEl.duration) * 100 : 0;
  $("#progressFill").style.width = `${pct}%`;
  $("#timeCurrent").textContent = formatTime(audioEl.currentTime);

  // Seuil d'écoute atteint -> on notifie Navidrome (cf. sendScrobble).
  if (scrobbledGen !== playGen && audioEl.duration) {
    const threshold = Math.min(30, audioEl.duration / 2);
    if (audioEl.currentTime >= threshold) {
      scrobbledGen = playGen;
      sendScrobble(state.currentTrackObj);
    }
  }
});
audioEl.addEventListener("ended", playNextTrack);
audioEl.addEventListener("error", () => {
  if (state.currentTrackId) registerPlayFailure(playGen, loadCycle);
});

function playNextTrack() {
  // Priorité aux morceaux insérés manuellement ("Lecture ensuite").
  if (state.queuedNext.length) {
    const next = state.queuedNext.shift();
    updateQueueBadge();
    playTrack(next, state.playQueue);
    return;
  }

  const pool = state.playQueue;
  if (!pool.length) return;

  let next;
  if (state.shuffle && pool.length > 1) {
    const candidates = pool.filter((t) => (t.navidrome_id || t.id) !== state.currentTrackId);
    next = candidates[Math.floor(Math.random() * candidates.length)];
  } else {
    const idx = pool.findIndex((t) => (t.navidrome_id || t.id) === state.currentTrackId);
    next = pool[(idx + 1) % pool.length];
  }
  if (next) playTrack(next, pool);
}

function playPrevTrack() {
  if (state.playHistory.length) {
    const prevTrack = state.playHistory.pop();
    playTrack(prevTrack, state.playQueue);
    return;
  }
  const pool = state.playQueue;
  if (!pool.length) return;
  const idx = pool.findIndex((t) => (t.navidrome_id || t.id) === state.currentTrackId);
  const prev = pool[(idx - 1 + pool.length) % pool.length];
  if (prev) playTrack(prev, pool);
}

$("#shuffleBtn").addEventListener("click", () => {
  state.shuffle = !state.shuffle;
  $("#shuffleBtn").classList.toggle("is-active", state.shuffle);
  toast(state.shuffle ? "Lecture aléatoire activée" : "Lecture aléatoire désactivée");
});

$("#playBtn").addEventListener("click", () => {
  if (!state.currentTrackId) {
    if (state.library[0]) playTrack(state.library[0], state.library);
    else toast("Rien à lire — cherche et télécharge un morceau d'abord.");
    return;
  }
  togglePlayPause();
});
$("#nextBtn").addEventListener("click", playNextTrack);
$("#prevBtn").addEventListener("click", playPrevTrack);

$("#volumeSlider").addEventListener("input", (e) => {
  audioEl.volume = e.target.value / 100;
});
audioEl.volume = $("#volumeSlider").value / 100;

$("#progressTrack").addEventListener("click", (e) => {
  if (!audioEl.duration) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const ratio = (e.clientX - rect.left) / rect.width;
  audioEl.currentTime = ratio * audioEl.duration;
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function loadLibrary() {
  try {
    const res = await apiFetch("/api/library");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.library = await res.json();
  } catch (err) {
    toast(`Impossible de charger la bibliothèque : ${err.message}`);
  }
  renderAll();
}

// ---------------------------------------------------------------------------
// Page d'accès — le mot de passe est validé par le BACKEND (/api/auth), pas
// en JS. Tant qu'il n'est pas bon, l'appli reste verrouillée. Une fois validé,
// il est mémorisé sur l'appareil (comme avant) et envoyé sur chaque requête.
// ---------------------------------------------------------------------------
async function validateKey(candidate) {
  try {
    const res = await fetch(apiUrl("/api/auth"), { headers: { "X-API-Key": candidate } });
    return res.ok;
  } catch {
    return false;
  }
}

function showAccessGate() {
  $("#accessGate").classList.remove("is-hidden");
  document.body.classList.add("is-locked");
  // Réinitialise l'état (utile après une déconnexion).
  $("#accessLogo")?.classList.remove("playing");
  const btn = $("#accessBtn");
  if (btn) { btn.disabled = false; btn.textContent = "Accéder"; }
  const userInput = $("#accessUsername");
  const input = $("#accessPassword");
  if (userInput) userInput.value = "";
  if (input) input.value = "";
  setTimeout(() => (userInput || input)?.focus(), 50);
}

// Déconnexion : oublie le mot de passe sur cet appareil et reverrouille.
// (prêt pour de vrais comptes plus tard — ici, un seul mot de passe partagé)
function logout() {
  localStorage.removeItem("mymusic_api_key");
  state.favorites = new Set();
  try { $("#audioEl").pause(); } catch {}
  showAccessGate();
}

$("#userBtn")?.addEventListener("click", (e) => {
  e.stopPropagation();
  openTrackMenu(e.currentTarget, [
    { label: "Déconnexion", icon: "⏻", danger: true, onClick: logout },
  ]);
});

// Cœur de la barre de lecture. On passe un bouton jetable à toggleFavorite :
// il y écrit son état de chargement (texte « … ») sans toucher au SVG réel,
// puis syncFavButtons -> updatePlayerLike remet le vrai cœur à jour.
$("#playerLike")?.addEventListener("click", () => {
  if (!state.currentTrackObj) return;
  toggleFavorite(state.currentTrackObj, document.createElement("button"));
});

// Bouton « + » de la section playlists de la sidebar : même action que le
// bouton de la vue Playlists.
$("#sidebarCreateBtn")?.addEventListener("click", () => $("#createPlaylistBtn")?.click());

function unlockApp() {
  $("#accessGate").classList.add("is-hidden");
  document.body.classList.remove("is-locked");
  loadFavorites();   // cœurs pleins dès le premier rendu
  loadLibrary();
  loadPlaylists();   // remplit la sidebar + les tuiles d'accueil dès le départ
}

async function attemptAccess() {
  const userInput = $("#accessUsername");
  const input = $("#accessPassword");
  const btn = $("#accessBtn");
  const err = $("#accessError");
  const username = (userInput?.value || "").trim();
  const password = input.value.trim();
  if (!username || !password) return;

  btn.disabled = true;
  btn.textContent = "Vérification…";
  err.textContent = "";

  // On échange (identifiant + mot de passe Navidrome) contre un token de
  // session. Le token remplace l'ancien mot de passe partagé dans localStorage :
  // tout le reste de l'appli (apiFetch, streamUrlWithKey) est inchangé.
  let token = "";
  try {
    const res = await fetch(apiUrl("/api/login"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (res.ok) token = (await res.json()).token || "";
  } catch {}

  if (token) {
    localStorage.setItem("mymusic_api_key", token);
    // Animation égaliseur du logo, puis on déverrouille.
    const logo = $("#accessLogo");
    if (logo) {
      logo.classList.add("playing");
      btn.textContent = "Accéder";
      await new Promise((r) => setTimeout(r, 820));
    }
    unlockApp();
  } else {
    err.textContent = "Identifiants incorrects.";
    input.value = "";
    input.focus();
    btn.disabled = false;
    btn.textContent = "Accéder";
  }
}

$("#accessBtn").addEventListener("click", attemptAccess);
$("#accessUsername")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("#accessPassword")?.focus();
});
$("#accessPassword").addEventListener("keydown", (e) => {
  if (e.key === "Enter") attemptAccess();
});

// ---------------------------------------------------------------------------
// Boot — on ne démarre l'appli que si le mot de passe stocké est encore valide.
// ---------------------------------------------------------------------------
async function boot() {
  const stored = getApiKey();
  if (stored && await validateKey(stored)) {
    unlockApp();
  } else {
    localStorage.removeItem("mymusic_api_key");
    showAccessGate();
  }
}

boot();
