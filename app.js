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
function getApiKey() {
  let key = localStorage.getItem("mymusic_api_key");
  if (!key) {
    key = (prompt("Clé d'accès mymusic :") || "").trim();
    if (key) localStorage.setItem("mymusic_api_key", key);
  }
  return key;
}

// À utiliser pour tous les appels JSON (recherche, playlists, library, upload).
async function apiFetch(path, options = {}) {
  const headers = { ...(options.headers || {}), "X-API-Key": getApiKey() };
  const res = await fetch(apiUrl(path), { ...options, headers });
  if (res.status === 401) {
    localStorage.removeItem("mymusic_api_key");
    toast("Clé d'accès invalide — recharge la page pour la ressaisir.");
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
  albums: [],             // albums Navidrome (collection, regroupée par tags)
  albumSort: "recent",    // tri courant de la vue Albums
  playQueue: [],          // liste de lecture en cours (pour next/prev)
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
    <button class="playlist-add-btn" data-add title="Ajouter à une playlist">＋</button>
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

function renderPlaylistTrackRow(track, queueRaw) {
  const row = document.createElement("div");
  row.className = "track-row";
  row.innerHTML = `
    ${coverHtml(track, track.id)}
    <div>
      <div class="track-row-title">${track.title}</div>
      <div class="track-row-artist">${track.artist}</div>
    </div>
    <span class="track-row-status cached">Navidrome</span>
    <span></span>
    <span class="track-row-duration">${formatTime(track.duration)}</span>
  `;
  const queue = queueRaw.map((t) => ({ ...t, navidrome_id: t.id }));
  row.addEventListener("click", () => playTrack({ ...track, navidrome_id: track.id }, queue));
  return row;
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
    data.tracks.forEach((t) => container.appendChild(renderPlaylistTrackRow(t, data.tracks)));
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
// Albums — collection Navidrome (regroupée par tags ALBUM / ALBUMARTIST)
// Réutilise exactement le patron des playlists : liste -> détail -> tracklist,
// et la lecture passe par playTrack(navidrome_id) -> /api/stream-nd/.
// ---------------------------------------------------------------------------
function renderAlbumRow(album) {
  const cover = coverUrlWithKey(album.coverArt);
  const albumForCover = { title: album.name, cover };
  const row = document.createElement("div");
  row.className = "track-row";
  row.innerHTML = `
    ${coverHtml(albumForCover, album.id)}
    <div>
      <div class="track-row-title">${album.name}</div>
      <div class="track-row-artist">${album.artist}${album.year ? " · " + album.year : ""}</div>
    </div>
    <span class="track-row-status cached">${album.songCount} titre${album.songCount > 1 ? "s" : ""}</span>
    <span></span>
    <span></span>
  `;
  row.addEventListener("click", () => openAlbumDetail(album.id));
  return row;
}

async function loadAlbums(sort = "recent") {
  state.albumSort = sort;
  const container = $("#albumsGrid");
  container.innerHTML = `<div class="empty-state">Chargement des albums…</div>`;
  try {
    const res = await apiFetch(`/api/albums?sort=${encodeURIComponent(sort)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.albums = await res.json();
  } catch (err) {
    container.innerHTML = `<div class="empty-state">Impossible de charger les albums : ${err.message}</div>`;
    return;
  }
  container.innerHTML = "";
  if (!state.albums.length) {
    container.innerHTML = `<div class="empty-state">Aucun album pour l'instant.</div>`;
    return;
  }
  state.albums.forEach((a) => container.appendChild(renderAlbumRow(a)));
}

function renderAlbumTrackRow(track, tracks) {
  const row = document.createElement("div");
  row.className = "track-row";
  const num = track.track ? String(track.track) : "";
  row.innerHTML = `
    <div class="track-row-cover" style="display:flex;align-items:center;justify-content:center;font-variant-numeric:tabular-nums;opacity:.85;">${num || initials(track.title)}</div>
    <div>
      <div class="track-row-title">${track.title}</div>
      <div class="track-row-artist">${track.artist}</div>
    </div>
    <span class="track-row-status cached">Navidrome</span>
    <span></span>
    <span class="track-row-duration">${formatTime(track.duration)}</span>
  `;
  const queue = tracks.map((t) => ({ ...t, navidrome_id: t.id }));
  row.addEventListener("click", () => playTrack({ ...track, navidrome_id: track.id }, queue));
  return row;
}

async function openAlbumDetail(id) {
  activateView("albums");
  $("#albumsListWrap").classList.add("is-hidden");
  $("#albumDetailWrap").classList.remove("is-hidden");
  const head = $("#albumDetailHead");
  const container = $("#albumDetailTracks");
  head.innerHTML = "";
  container.innerHTML = `<div class="empty-state">Chargement…</div>`;

  try {
    const res = await apiFetch(`/api/albums/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const album = await res.json();

    const cover = coverUrlWithKey(album.coverArt);
    const albumForCover = { title: album.name, cover };
    // On propage la pochette de l'album sur chaque morceau (pour le lecteur).
    const tracks = (album.tracks || []).map((t) => ({ ...t, cover }));

    head.innerHTML = `
      <div style="display:flex;gap:20px;align-items:flex-end;flex-wrap:wrap;margin-bottom:22px;">
        <div style="width:168px;height:168px;border-radius:12px;overflow:hidden;flex-shrink:0;box-shadow:0 8px 30px rgba(0,0,0,.45);">
          ${coverHtml(albumForCover, album.id, "", true)}
        </div>
        <div style="flex:1;min-width:220px;">
          <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.6;">Album</div>
          <h1 class="view-title" style="margin:4px 0 6px;">${album.name}</h1>
          <div class="view-sub" style="margin:0;">${album.artist}${album.year ? " · " + album.year : ""} · ${album.songCount} titre${album.songCount > 1 ? "s" : ""}</div>
          <div style="display:flex;gap:10px;margin-top:16px;">
            <button class="primary-btn" id="albumPlayBtn">▶ Lecture</button>
            <button class="primary-btn" id="albumShuffleBtn" style="background:transparent;border:1px solid rgba(255,255,255,.18);">🔀 Aléatoire</button>
          </div>
        </div>
      </div>
    `;

    container.innerHTML = "";
    if (!tracks.length) {
      container.innerHTML = `<div class="empty-state">Cet album ne contient aucun morceau.</div>`;
      return;
    }
    tracks.forEach((t) => container.appendChild(renderAlbumTrackRow(t, tracks)));

    const queue = tracks.map((t) => ({ ...t, navidrome_id: t.id }));
    $("#albumPlayBtn").addEventListener("click", () => {
      if (queue[0]) playTrack(queue[0], queue);
    });
    $("#albumShuffleBtn").addEventListener("click", () => {
      if (!queue.length) return;
      state.shuffle = true;
      $("#shuffleBtn").classList.add("is-active");
      const first = queue[Math.floor(Math.random() * queue.length)];
      playTrack(first, queue);
    });
  } catch (err) {
    container.innerHTML = `<div class="empty-state">Erreur : ${err.message}</div>`;
  }
}

$("#backToAlbumsBtn").addEventListener("click", () => {
  $("#albumDetailWrap").classList.add("is-hidden");
  $("#albumsListWrap").classList.remove("is-hidden");
});

document.querySelectorAll("[data-album-sort]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-album-sort]").forEach((b) => {
      b.style.background = b === btn ? "#6d5efc" : "transparent";
    });
    loadAlbums(btn.dataset.albumSort);
  });
});

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
    if (btn.dataset.view === "albums") {
      $("#albumDetailWrap").classList.add("is-hidden");
      $("#albumsListWrap").classList.remove("is-hidden");
      if (!state.albums.length) loadAlbums(state.albumSort);
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
    renderGrid($("#searchGrid"), [], "");
    return;
  }

  $("#searchSub").textContent = "Recherche en cours…";
  searchDebounce = setTimeout(() => runSearch(q, 0), 350);
});

async function runSearch(q, page) {
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
// Import — upload manuel d'un mp3 déjà présent sur le disque
// ---------------------------------------------------------------------------
const dropzone = $("#dropzone");
const fileInput = $("#fileInput");

fileInput.addEventListener("change", (e) => {
  if (e.target.files[0]) uploadMp3(e.target.files[0]);
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
  const file = e.dataTransfer.files[0];
  if (file) uploadMp3(file);
});

async function uploadMp3(file) {
  if (!file.name.toLowerCase().endsWith(".mp3")) {
    toast("Seuls les fichiers .mp3 sont acceptés.");
    return;
  }

  const resultEl = $("#importResult");
  resultEl.innerHTML = `<div class="empty-state">Envoi de "${file.name}"…</div>`;

  const formData = new FormData();
  formData.append("file", file);

  try {
    const res = await apiFetch("/upload", { method: "POST", body: formData });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const entry = await res.json();
    toast(`"${file.name}" importé`);
    renderImportResult(entry);
  } catch (err) {
    resultEl.innerHTML = `<div class="empty-state">Échec de l'import : ${err.message}</div>`;
  }
}

function renderImportResult(entry) {
  const resultEl = $("#importResult");
  resultEl.innerHTML = "";
  const row = document.createElement("div");
  row.className = "track-row";
  row.innerHTML = `
    <div class="track-row-cover" style="background:${coverGradient(entry.filename)}">${initials(entry.title)}</div>
    <div>
      <div class="track-row-title">${entry.title}</div>
      <div class="track-row-artist">${entry.navidrome_id ? "Ajouté à ta bibliothèque" : "Indexation en cours…"}</div>
    </div>
    <span></span>
    <button class="playlist-add-btn" data-add title="Ajouter à une playlist">＋</button>
    <span></span>
  `;
  row.querySelector("[data-add]").addEventListener("click", (e) => {
    e.stopPropagation();
    openPlaylistPickerDirect(e.currentTarget, entry.navidrome_id);
  });
  resultEl.appendChild(row);
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

loadLibrary();
