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
     GET  /api/playlists/<id>              détail (morceaux)
     POST /api/playlists/<id>/tracks       { songId }
     GET  /api/stream-nd/<navidrome_id>    flux proxié Navidrome (préféré)
     POST /upload  multipart: file (audio ou .zip, champ répétable) + playlist_id OU playlist_name
                    -> { tracks: [{filename,title,artist,navidrome_id,added_to_playlist}],
                         rejected: [{filename,reason}], playlist: {id,name} }
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
function coverUrlWithKey(coverArt) {
  if (!coverArt) return null;
  return `${apiUrl("/api/cover/" + encodeURIComponent(coverArt))}?key=${encodeURIComponent(getApiKey())}`;
}

// ---------------------------------------------------------------------------
// État
// ---------------------------------------------------------------------------
const state = {
  library: [],            // tout ce que CET outil a téléchargé (suivi local)
  playlists: [],          // playlists Navidrome (liste)
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
const AVG_MP3_MB = 4.2;
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

function renderAll() {
  renderGrid(
    $("#homeGrid"),
    [...state.library].slice(-8).reverse(),
    "Rien dans ta bibliothèque pour l'instant — ajoute un morceau à une playlist pour le télécharger sur le NAS."
  );
  updateStorageMeter();
}

function updateStorageMeter() {
  const mb = state.library.length * AVG_MP3_MB;
  $("#storageLabel").textContent = mb >= 1000 ? `${(mb / 1000).toFixed(2)} Go` : `${mb.toFixed(0)} Mo`;
  const pct = Math.min(100, (mb / 2000) * 100);
  $("#storageFill").style.width = `${Math.max(pct, mb ? 3 : 0)}%`;
}

// ---------------------------------------------------------------------------
// Rendu — playlists (liste + détail)
// ---------------------------------------------------------------------------
function renderPlaylistRow(pl) {
  const row = document.createElement("div");
  row.className = "track-row";
  row.innerHTML = `
    <div class="track-row-cover" style="background:${coverGradient(pl.id)}">${initials(pl.name)}</div>
    <div>
      <div class="track-row-title">${pl.name}</div>
      <div class="track-row-artist">${pl.songCount || 0} morceau(x)</div>
    </div>
    <span></span><span></span><span></span>
  `;
  row.addEventListener("click", () => openPlaylistDetail(pl.id, pl.name));
  return row;
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
}

function renderPlaylistTrackRow(track, queueRaw, playlistId, editable) {
  const row = document.createElement("div");
  row.className = "track-row";
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
    // "Retirer" seulement si Navidrome autorise la modif (playlist possédée,
    // non-smart). Sinon l'action échouerait avec "not authorized".
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
  $("#playlistsListWrap").classList.add("is-hidden");
  $("#playlistDetailWrap").classList.remove("is-hidden");
  $("#playlistDetailTitle").textContent = name;
  const container = $("#playlistDetailTracks");
  container.innerHTML = `<div class="empty-state">Chargement…</div>`;
  try {
    const res = await apiFetch(`/api/playlists/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    container.innerHTML = "";
    if (!data.tracks.length) {
      container.innerHTML = `<div class="empty-state">Playlist vide — ajoute des morceaux depuis la recherche (bouton ＋).</div>`;
      return;
    }
    data.tracks.forEach((t) => container.appendChild(renderPlaylistTrackRow(t, data.tracks, id, data.editable)));
  } catch (err) {
    container.innerHTML = `<div class="empty-state">Erreur : ${err.message}</div>`;
  }
}

$("#backToPlaylistsBtn").addEventListener("click", () => {
  $("#playlistDetailWrap").classList.add("is-hidden");
  $("#playlistsListWrap").classList.remove("is-hidden");
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
$("#searchInput").addEventListener("input", (e) => {
  activateView("search");
  const q = e.target.value.trim();

  clearTimeout(searchDebounce);
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

async function runSearch(q, page) {
  if (page === 0) { runAlbumSearch(q); runArtistSearch(q); }   // en parallèle
  try {
    const res = await apiFetch(`/api/search?q=${encodeURIComponent(q)}&page=${page}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const results = await res.json();

    if (page === 0) {
      state.search = { query: q, page: 0, results };
    } else {
      state.search.results = state.search.results.concat(results);
      state.search.page = page;
    }

    $("#searchSub").textContent = `${state.search.results.length} résultat(s) chargé(s) — lecture en streaming, téléchargement sur le NAS uniquement si ajouté à une playlist.`;
    renderSearchResults(results.length === PAGE_SIZE);
  } catch (err) {
    $("#searchSub").textContent = `Erreur de recherche : ${err.message}. Vérifie l'URL du backend et le CORS.`;
    if (page === 0) renderGrid($("#searchGrid"), [], "");
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
async function runAlbumSearch(q) {
  const wrap = $("#searchAlbums");
  wrap.innerHTML = `<div class="album-strip-title">Albums</div><div class="empty-state">Recherche d'albums…</div>`;
  wrap.classList.remove("is-hidden");
  try {
    const res = await apiFetch(`/api/search-albums?q=${encodeURIComponent(q)}&limit=6`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const albums = await res.json();
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

$("#backToSearchBtn").addEventListener("click", () => activateView("search"));

// ---------------------------------------------------------------------------
// Catalogue ARTISTES — page artiste : populaires + albums + singles.
// Les morceaux se lisent/téléchargent comme ceux d'un album ; les albums et
// singles rebranchent sur openCatalogAlbum (la vue album déjà construite).
// ---------------------------------------------------------------------------
async function runArtistSearch(q) {
  const wrap = $("#searchArtists");
  wrap.innerHTML = `<div class="album-strip-title">Artistes</div><div class="empty-state">Recherche d'artistes…</div>`;
  wrap.classList.remove("is-hidden");
  try {
    const res = await apiFetch(`/api/search-artists?q=${encodeURIComponent(q)}&limit=4`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const artists = await res.json();
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

    if (!songs.length && !(artist.albums || []).length && !(artist.singles || []).length) {
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
  dropzone.classList.toggle("is-disabled", !currentImportPlaylistChoice());
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

async function uploadFiles(files) {
  const accepted = files.filter((f) => ACCEPTED_EXTENSIONS.includes(fileExtension(f.name)));
  const refused = files.filter((f) => !ACCEPTED_EXTENSIONS.includes(fileExtension(f.name)));

  if (!accepted.length) {
    toast(files.length === 1
      ? `Format non supporté : ${files[0].name}`
      : "Aucun fichier audio dans cette sélection.");
    return;
  }

  const choice = currentImportPlaylistChoice();
  if (!choice) {
    toast("Choisis d'abord une playlist de destination.");
    return;
  }

  const resultEl = $("#importResult");
  const willTranscode = accepted.some((f) => TRANSCODED_EXTENSIONS.includes(fileExtension(f.name)));
  const label = accepted.length === 1 ? `"${accepted[0].name}"` : `${accepted.length} fichiers`;
  resultEl.innerHTML = `<div class="empty-state">Envoi de ${label}…${
    willTranscode ? "<br>Conversion en MP3 sur le NAS, ça peut prendre une minute." : ""
  }</div>`;

  const formData = new FormData();
  accepted.forEach((f) => formData.append("file", f));   // champ répété = liste côté serveur
  if (choice.playlist_id) formData.append("playlist_id", choice.playlist_id);
  if (choice.playlist_name) formData.append("playlist_name", choice.playlist_name);

  try {
    const res = await apiFetch("/upload", { method: "POST", body: formData });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    const n = data.tracks.length;
    toast(`${n > 1 ? `${n} morceaux importés` : `"${data.tracks[0]?.filename || label}" importé`} dans "${data.playlist.name}"`);
    // Les fichiers écartés par le navigateur rejoignent ceux écartés par le NAS.
    const rejected = [
      ...(data.rejected || []),
      ...refused.map((f) => ({ filename: f.name, reason: "format non supporté" })),
    ];
    renderImportResult({ ...data, rejected });
    if (importPlaylistSelect.value === "__new__") {
      importNewPlaylistName.value = "";
      await populateImportPlaylistSelect();
      importPlaylistSelect.value = data.playlist.id;
      importNewPlaylistName.classList.add("is-hidden");
      syncImportDropzoneState();
    }
  } catch (err) {
    // Un gros lot peut dépasser le temps d'attente du navigateur alors que le
    // NAS finit correctement : on le dit plutôt que d'annoncer un échec sec.
    resultEl.innerHTML = `<div class="empty-state">Échec de l'import : ${err.message}${
      willTranscode ? "<br>Si la conversion était longue, l'import a pu aboutir malgré tout — vérifie la playlist." : ""
    }</div>`;
  }
}

function renderImportResult(data) {
  const resultEl = $("#importResult");
  resultEl.innerHTML = "";
  data.tracks.forEach((entry) => resultEl.appendChild(renderImportedTrackRow(entry, data.playlist.name)));
  (data.rejected || []).forEach((entry) => resultEl.appendChild(renderRejectedRow(entry)));
}

function renderRejectedRow(entry) {
  // Styles en ligne : style.css n'a pas de classe pour cet état, autant ne pas
  // dépendre d'une feuille à modifier en parallèle.
  const row = document.createElement("div");
  row.className = "track-row";
  row.style.opacity = "0.55";
  row.innerHTML = `
    <div class="track-row-cover" style="background:#3a3a42;color:#8a8a93">✕</div>
    <div>
      <div class="track-row-title">${entry.filename}</div>
      <div class="track-row-artist">Non importé — ${entry.reason}</div>
    </div>
    <span></span><span></span><span></span>
  `;
  return row;
}

function renderImportedTrackRow(entry, playlistName) {
  const row = document.createElement("div");
  row.className = "track-row";
  const status = entry.navidrome_id
    ? (entry.added_to_playlist ? `Ajouté à « ${playlistName} »` : "Ajouté à ta bibliothèque")
    : "Indexation en cours…";
  // L'artiste vient des tags lus par le NAS ; absent sur un fichier mal taggé.
  const subtitle = entry.artist ? `${entry.artist} · ${status}` : status;
  row.innerHTML = `
    <div class="track-row-cover" style="background:${coverGradient(entry.filename)}">${initials(entry.title)}</div>
    <div>
      <div class="track-row-title">${entry.title}</div>
      <div class="track-row-artist">${subtitle}</div>
    </div>
    <span></span>
    <button class="playlist-add-btn" data-add title="Ajouter à une playlist">＋</button>
    <span></span>
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

  audioEl.src = trackStreamUrl;
  audioEl.play().catch((err) => toast(`Lecture impossible : ${err.message}`));

  $("#playerTitle").textContent = track.title;
  $("#playerArtist").textContent = track.artist;
  $("#playerCover").innerHTML = coverHtml(track, key, "", true);
  $("#playerCover").style.background = coverGradient(key);
  $("#playerCachePill").textContent = cachePillLabel;
  $("#playerCachePill").className = "cache-pill cached";
}

function togglePlayPause() {
  if (!state.currentTrackId) return;
  if (audioEl.paused) audioEl.play();
  else audioEl.pause();
}

audioEl.addEventListener("play", () => {
  state.isPlaying = true;
  $("#playBtn").textContent = "⏸";
});
audioEl.addEventListener("pause", () => {
  state.isPlaying = false;
  $("#playBtn").textContent = "▶";
});
audioEl.addEventListener("loadedmetadata", () => {
  $("#timeTotal").textContent = formatTime(audioEl.duration);
});
audioEl.addEventListener("timeupdate", () => {
  const pct = audioEl.duration ? (audioEl.currentTime / audioEl.duration) * 100 : 0;
  $("#progressFill").style.width = `${pct}%`;
  $("#timeCurrent").textContent = formatTime(audioEl.currentTime);
});
audioEl.addEventListener("ended", playNextTrack);
audioEl.addEventListener("error", () => {
  if (state.currentTrackId) toast("Erreur de streaming.");
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
  const input = $("#accessPassword");
  if (input) input.value = "";
  setTimeout(() => input?.focus(), 50);
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

function unlockApp() {
  $("#accessGate").classList.add("is-hidden");
  document.body.classList.remove("is-locked");
  loadFavorites();   // cœurs pleins dès le premier rendu
  loadLibrary();
}

async function attemptAccess() {
  const input = $("#accessPassword");
  const btn = $("#accessBtn");
  const err = $("#accessError");
  const candidate = input.value.trim();
  if (!candidate) return;

  btn.disabled = true;
  btn.textContent = "Vérification…";
  err.textContent = "";

  if (await validateKey(candidate)) {
    localStorage.setItem("mymusic_api_key", candidate);
    // Animation égaliseur du logo, puis on déverrouille.
    const logo = $("#accessLogo");
    if (logo) {
      logo.classList.add("playing");
      btn.textContent = "Accéder";
      await new Promise((r) => setTimeout(r, 820));
    }
    unlockApp();
  } else {
    err.textContent = "Mot de passe incorrect.";
    input.value = "";
    input.focus();
    btn.disabled = false;
    btn.textContent = "Accéder";
  }
}

$("#accessBtn").addEventListener("click", attemptAccess);
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
