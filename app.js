/* ==========================================================================
   mymusic — front-end
   --------------------------------------------------------------------------
   Contrat d'API (voir upload_server.py sur le NAS) :

     GET  /api/search?q=...&page=0        recherche live YouTube, 20/page
     GET  /api/library                     morceaux téléchargés via cet outil
     POST /api/library      { id, title, artist, duration }
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
// État
// ---------------------------------------------------------------------------
const state = {
  library: [],            // tout ce que CET outil a téléchargé (suivi local)
  playlists: [],          // playlists Navidrome (liste)
  playQueue: [],          // liste de lecture en cours (pour next/prev)
  currentTrackId: null,   // navidrome_id si dispo, sinon youtube id
  isPlaying: false,
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
  const card = document.createElement("div");
  card.className = "card";
  card.dataset.trackId = track.id;
  card.innerHTML = `
    <div class="cache-dot ${cached ? "is-cached" : ""}" title="${cached ? "Téléchargé" : "Pas encore téléchargé — le sera à la lecture"}"></div>
    <div class="card-cover" style="background:${coverGradient(track.id)}">
      ${initials(track.title)}
      <div class="card-play" data-play>▶</div>
    </div>
    <div class="card-title-row">
      <div class="card-title-wrap">
        <div class="card-title">${track.title}</div>
        <div class="card-artist">${track.artist}</div>
      </div>
      <button class="playlist-add-btn" data-add title="Ajouter à une playlist">＋</button>
    </div>
  `;
  card.querySelector("[data-play]").addEventListener("click", (e) => {
    e.stopPropagation();
    handleTrackActivate(track);
  });
  card.querySelector("[data-add]").addEventListener("click", (e) => {
    e.stopPropagation();
    openPlaylistPicker(e.currentTarget, track);
  });
  card.addEventListener("click", () => handleTrackActivate(track));
  return card;
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
    "Rien de téléchargé pour l'instant — cherche un morceau et lance la lecture."
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
    const res = await fetch(apiUrl("/api/playlists"));
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
    <div class="track-row-cover" style="background:${coverGradient(track.id)}">${initials(track.title)}</div>
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
    const res = await fetch(apiUrl(`/api/playlists/${encodeURIComponent(id)}`));
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
    const res = await fetch(apiUrl("/api/playlists"), {
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
  const res = await fetch(apiUrl(`/api/playlists/${encodeURIComponent(playlistId)}/tracks`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ songId }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

function closeAnyPicker() {
  document.querySelectorAll(".playlist-picker").forEach((p) => p.remove());
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

  const picker = document.createElement("div");
  picker.className = "playlist-picker";
  if (!state.playlists.length) {
    picker.innerHTML = `<div class="picker-empty">Aucune playlist — crée-en une d'abord.</div>`;
  } else {
    state.playlists.forEach((pl) => {
      const btn = document.createElement("button");
      btn.textContent = pl.name;
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        try {
          await addTrackToPlaylist(pl.id, entry.navidrome_id);
          toast(`Ajouté à "${pl.name}"`);
        } catch (err) {
          toast(`Erreur : ${err.message}`);
        }
        picker.remove();
      });
      picker.appendChild(btn);
    });
  }

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

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    activateView(btn.dataset.view, btn);
    if (btn.dataset.view === "library") {
      $("#playlistDetailWrap").classList.add("is-hidden");
      $("#playlistsListWrap").classList.remove("is-hidden");
      loadPlaylists();
    }
  });
});

function activateView(view, btn) {
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("is-active"));
  (btn || document.querySelector(`.nav-item[data-view="${view}"]`)).classList.add("is-active");
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
    const res = await fetch(apiUrl(`/api/search?q=${encodeURIComponent(q)}&page=${page}`));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const results = await res.json();

    if (page === 0) {
      state.search = { query: q, page: 0, results };
    } else {
      state.search.results = state.search.results.concat(results);
      state.search.page = page;
    }

    $("#searchSub").textContent = `${state.search.results.length} résultat(s) chargé(s) — le fichier n'est téléchargé qu'à la lecture.`;
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
    const res = await fetch(apiUrl("/api/library"), {
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

async function handleTrackActivate(track) {
  const existing = byLibId(track.id);
  if (existing) {
    playTrack(existing, state.library);
    return;
  }
  const entry = await ensureDownloaded(track);
  if (entry) {
    toast(`"${entry.title}" est prêt — lecture…`);
    playTrack(entry, state.library);
  }
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

  state.currentTrackId = key;
  state.playQueue = queue && queue.length ? queue : [track];

  const streamUrl = track.navidrome_id
    ? apiUrl(`/api/stream-nd/${encodeURIComponent(track.navidrome_id)}`)
    : apiUrl(`/api/stream/${encodeURIComponent(track.id)}`);

  audioEl.src = streamUrl;
  audioEl.play().catch((err) => toast(`Lecture impossible : ${err.message}`));

  $("#playerTitle").textContent = track.title;
  $("#playerArtist").textContent = track.artist;
  $("#playerCover").style.background = coverGradient(key);
  $("#playerCachePill").textContent = track.navidrome_id ? "Navidrome" : "Local";
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
  const idx = pool.findIndex((t) => (t.navidrome_id || t.id) === state.currentTrackId);
  const next = pool[(idx + 1) % pool.length];
  if (next) playTrack(next, pool);
}

function playPrevTrack() {
  const pool = state.playQueue;
  if (!pool.length) return;
  const idx = pool.findIndex((t) => (t.navidrome_id || t.id) === state.currentTrackId);
  const prev = pool[(idx - 1 + pool.length) % pool.length];
  if (prev) playTrack(prev, pool);
}

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
    const res = await fetch(apiUrl("/api/library"));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.library = await res.json();
  } catch (err) {
    toast(`Impossible de charger la bibliothèque : ${err.message}`);
  }
  renderAll();
}

loadLibrary();
