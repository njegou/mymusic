/* ==========================================================================
   mymusic — front-end "catalogue à la demande"
   --------------------------------------------------------------------------
   Contrat d'API attendu côté NAS (à exposer via ton tunnel Cloudflare) :

     GET  {API_BASE}/api/search?q=...
          -> [{ id, title, artist, duration }]
          Recherche live (ex: yt-dlp ytsearch --flat-playlist --dump-json).
          Ne stocke rien, ne fait que renvoyer des métadonnées.

     GET  {API_BASE}/api/library
          -> [{ id, title, artist, duration }]
          Tout ce qui a déjà été téléchargé et existe physiquement sur le NAS.

     POST {API_BASE}/api/library      body: { id, title, artist, duration }
          -> déclenche le téléchargement (yt-dlp + ffmpeg) s'il n'est pas déjà
             présent, puis répond quand le fichier est prêt à être streamé.
             Doit renvoyer un statut 2xx en cas de succès.

     GET  {API_BASE}/api/stream/:id
          -> flux audio du fichier (uniquement s'il est dans la bibliothèque).

   Le fichier est prévu pour être servi depuis le même domaine que l'API
   (ton tunnel Cloudflare) : les appels /api/... sont donc relatifs et il
   n'y a rien à configurer côté utilisateur. Voir le README pour le détail
   du déploiement (servir ces 3 fichiers directement depuis le NAS, à côté
   de tes endpoints /api/*, plutôt que sur GitHub Pages).
   ========================================================================== */

const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------------------
// 1. Zéro configuration côté utilisateur : l'URL du backend est fixée ici,
//    une fois pour toutes. Ce frontend étant sur GitHub Pages (domaine
//    différent du NAS), il faut une URL complète — pas de same-origin
//    possible sans héberger les fichiers directement sur le NAS.
//    -> à remplacer par le hostname public que tu ajoutes à ton tunnel
//       Cloudflare pour exposer le port 5050 (voir README).
// ---------------------------------------------------------------------------
const API_BASE = "https://api.mymusic-nj.com";

function apiUrl(path) {
  return `${API_BASE}${path}`;
}

// ---------------------------------------------------------------------------
// 2. État applicatif
// ---------------------------------------------------------------------------
const state = {
  library: [],           // tout ce qui est réellement stocké sur le NAS
  currentTrackId: null,
  isPlaying: false,
  search: { query: "", page: 0, results: [] },
};

const PAGE_SIZE = 20; // doit correspondre au page_size côté backend

const AVG_MP3_MB = 4.2; // hypothèse ~192kbps pour l'estimation de stockage affichée
const audioEl = $("#audioEl");

const byLibId = (id) => state.library.find((t) => t.id === id);

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
  const h1 = hash;
  const h2 = (hash + 55) % 360;
  return `linear-gradient(135deg, hsl(${h1} 70% 55%), hsl(${h2} 65% 40%))`;
}

function initials(title) {
  return (title || "?")
    .split(" ")
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("is-visible");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("is-visible"), 2400);
}

function isCached(id) {
  return state.library.some((t) => t.id === id);
}

// ---------------------------------------------------------------------------
// 3. Rendu
// ---------------------------------------------------------------------------
function renderCard(track) {
  const cached = isCached(track.id);
  const card = document.createElement("div");
  card.className = "card";
  card.dataset.trackId = track.id;
  card.innerHTML = `
    <div class="cache-dot ${cached ? "is-cached" : ""}" title="${cached ? "Téléchargé, stocké sur le NAS" : "Pas encore téléchargé — le sera à la lecture"}"></div>
    <div class="card-cover" style="background:${coverGradient(track.id)}">
      ${initials(track.title)}
      <div class="card-play" data-play="${track.id}">▶</div>
    </div>
    <div class="card-title">${track.title}</div>
    <div class="card-artist">${track.artist}</div>
  `;
  card.addEventListener("click", () => handleTrackActivate(track));
  return card;
}

function renderRow(track) {
  const row = document.createElement("div");
  row.className = "track-row";
  row.dataset.trackId = track.id;
  row.innerHTML = `
    <div class="track-row-cover" style="background:${coverGradient(track.id)}">${initials(track.title)}</div>
    <div>
      <div class="track-row-title">${track.title}</div>
      <div class="track-row-artist">${track.artist}</div>
    </div>
    <span class="track-row-status cached">En bibliothèque</span>
    <span></span>
    <span class="track-row-duration">${formatTime(track.duration)}</span>
  `;
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

function renderList(container, tracks, emptyMsg) {
  container.innerHTML = "";
  if (!tracks.length) {
    container.innerHTML = `<div class="empty-state">${emptyMsg}</div>`;
    return;
  }
  tracks.forEach((t) => container.appendChild(renderRow(t)));
}

function renderAll() {
  renderGrid(
    $("#homeGrid"),
    [...state.library].slice(-8).reverse(),
    "Rien de téléchargé pour l'instant — cherche un morceau et lance la lecture."
  );
  renderList($("#libraryList"), state.library, "Ta bibliothèque est vide pour l'instant.");
  updateStorageMeter();
}

function updateStorageMeter() {
  const mb = state.library.length * AVG_MP3_MB;
  $("#storageLabel").textContent = mb >= 1000 ? `${(mb / 1000).toFixed(2)} Go` : `${mb.toFixed(0)} Mo`;
  const pct = Math.min(100, (mb / 2000) * 100);
  $("#storageFill").style.width = `${Math.max(pct, mb ? 3 : 0)}%`;
}

// ---------------------------------------------------------------------------
// 4. Navigation
// ---------------------------------------------------------------------------
document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => activateView(btn.dataset.view, btn));
});

function activateView(view, btn) {
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("is-active"));
  (btn || document.querySelector(`.nav-item[data-view="${view}"]`)).classList.add("is-active");
  document.querySelectorAll(".view").forEach((v) => v.classList.add("is-hidden"));
  $(`#view-${view}`).classList.remove("is-hidden");
}

// ---------------------------------------------------------------------------
// 5. Recherche live — GET /api/search?q=...
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
  searchDebounce = setTimeout(() => runSearch(q, 0), 350); // évite de spammer le backend à chaque frappe
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

    const total = state.search.results.length;
    $("#searchSub").textContent = `${total} résultat(s) chargé(s) — le fichier n'est téléchargé qu'à la lecture.`;
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
// 6. Bibliothèque — GET /api/library au chargement
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

// ---------------------------------------------------------------------------
// 7. Activation d'un morceau : lecture directe si déjà téléchargé,
//    sinon téléchargement (POST /api/library) puis lecture.
// ---------------------------------------------------------------------------
async function handleTrackActivate(track) {
  if (isCached(track.id)) {
    playTrack(track);
    return;
  }
  await downloadThenPlay(track);
}

async function downloadThenPlay(track) {
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

    if (!isCached(track.id)) state.library.push(track);
    renderAll();
    toast(`"${track.title}" est téléchargé — lecture…`);
    playTrack(track);
  } catch (err) {
    toast(`Échec du téléchargement : ${err.message}`);
  } finally {
    el?.classList.remove("is-loading");
  }
}

// ---------------------------------------------------------------------------
// 8. Lecteur — vrai élément <audio> streamé depuis GET /api/stream/:id
// ---------------------------------------------------------------------------
function playTrack(track) {
  if (state.currentTrackId === track.id) {
    togglePlayPause();
    return;
  }
  state.currentTrackId = track.id;
  audioEl.src = apiUrl(`/api/stream/${encodeURIComponent(track.id)}`);
  audioEl.play().catch((err) => toast(`Lecture impossible : ${err.message}`));

  $("#playerTitle").textContent = track.title;
  $("#playerArtist").textContent = track.artist;
  $("#playerCover").style.background = coverGradient(track.id);
  $("#playerCachePill").textContent = "En bibliothèque";
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
  if (state.currentTrackId) toast("Erreur de streaming — vérifie /api/stream côté backend.");
});

function playNextTrack() {
  const pool = state.library;
  if (!pool.length) return;
  const idx = pool.findIndex((t) => t.id === state.currentTrackId);
  const next = pool[(idx + 1) % pool.length];
  if (next) playTrack(next);
}

function playPrevTrack() {
  const pool = state.library;
  if (!pool.length) return;
  const idx = pool.findIndex((t) => t.id === state.currentTrackId);
  const prev = pool[(idx - 1 + pool.length) % pool.length];
  if (prev) playTrack(prev);
}

$("#playBtn").addEventListener("click", () => {
  if (!state.currentTrackId) {
    if (state.library[0]) playTrack(state.library[0]);
    else toast("Ta bibliothèque est vide — cherche et lance un morceau d'abord.");
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
loadLibrary();
