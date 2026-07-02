/* ==========================================================================
   mymusic — front-end "catalogue à la demande"
   --------------------------------------------------------------------------
   Ce fichier tourne 100% en local (aucune dépendance backend) pour la démo.
   Il définit un contrat d'API clair à trois endpoints à brancher plus tard
   sur ton NAS (voir README.md du dossier) :

     GET  /api/search?q=...          -> index de métadonnées (pas de fichier)
     POST /api/playlists/:id/tracks  -> ajoute un morceau -> déclenche le cache
     GET  /api/stream/:trackId       -> flux audio du morceau (si en cache)

   Tant que ce n'est pas branché, la lecture utilise une synthèse Web Audio
   (un accord généré) pour que l'interface reste réellement interactive.
   ========================================================================== */

// ---------------------------------------------------------------------------
// 1. "Index mondial" simulé — en prod, ceci vient de GET /api/search (yt-dlp
//    ytsearch --flat-playlist, métadonnées seules, rien n'est stocké ici).
// ---------------------------------------------------------------------------
const WORLD_INDEX = [
  { id: "t1",  title: "Blinding Lights",        artist: "The Weeknd",        duration: 200 },
  { id: "t2",  title: "Motion Sickness",        artist: "Phoebe Bridgers",   duration: 231 },
  { id: "t3",  title: "Redbone",                artist: "Childish Gambino",  duration: 326 },
  { id: "t4",  title: "Saldré",                 artist: "Rosalía",           duration: 172 },
  { id: "t5",  title: "Time",                   artist: "Pink Floyd",        duration: 413 },
  { id: "t6",  title: "太陽",                    artist: "Kenshi Yonezu",     duration: 244 },
  { id: "t7",  title: "Silver Springs",         artist: "Fleetwood Mac",     duration: 320 },
  { id: "t8",  title: "Nuvole Bianche",         artist: "Ludovico Einaudi",  duration: 365 },
  { id: "t9",  title: "Cissy Strut",            artist: "The Meters",        duration: 265 },
  { id: "t10", title: "Le Vent Nous Portera",   artist: "Noir Désir",        duration: 268 },
  { id: "t11", title: "Alright",                artist: "Kendrick Lamar",    duration: 219 },
  { id: "t12", title: "Porcelain",              artist: "Moby",              duration: 240 },
];

// ---------------------------------------------------------------------------
// 2. État applicatif local (persistant seulement en mémoire pour la démo)
//    -> en prod, "playlist" reflète ta vraie playlist Navidrome, et
//       "cachedIds" reflète les fichiers réellement présents sur le NAS.
// ---------------------------------------------------------------------------
const state = {
  playlist: ["t1", "t4"],
  cachedIds: new Set(["t1", "t4"]), // seuls les morceaux en playlist sont "stockés"
  currentTrackId: null,
  isPlaying: false,
};

const AVG_MP3_MB = 4.2; // hypothèse ~192kbps pour l'estimation de stockage affichée

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const byId = (id) => WORLD_INDEX.find((t) => t.id === id);

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function coverGradient(seed) {
  // Génère un dégradé déterministe à partir de l'id — pas d'images externes,
  // pas de vraies pochettes à héberger.
  let hash = 0;
  for (const c of seed) hash = (hash * 31 + c.charCodeAt(0)) % 360;
  const h1 = hash;
  const h2 = (hash + 55) % 360;
  return `linear-gradient(135deg, hsl(${h1} 70% 55%), hsl(${h2} 65% 40%))`;
}

function initials(title) {
  return title
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
  toast._t = setTimeout(() => el.classList.remove("is-visible"), 2200);
}

// ---------------------------------------------------------------------------
// 3. Rendu — cartes (grille) et lignes (listes playlist / cache)
// ---------------------------------------------------------------------------
function renderCard(track) {
  const cached = state.cachedIds.has(track.id);
  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = `
    <div class="cache-dot ${cached ? "is-cached" : ""}" title="${cached ? "Stocké localement" : "À la demande — sera mis en cache si ajouté à une playlist"}"></div>
    <div class="card-cover" style="background:${coverGradient(track.id)}">
      ${initials(track.title)}
      <div class="card-play" data-play="${track.id}">▶</div>
    </div>
    <div class="card-title">${track.title}</div>
    <div class="card-artist">${track.artist}</div>
  `;
  card.addEventListener("click", (e) => {
    if (e.target.closest("[data-play]")) {
      playTrack(track.id);
    } else {
      openTrackMenu(track);
    }
  });
  return card;
}

function renderRow(track, { showAdd = false } = {}) {
  const cached = state.cachedIds.has(track.id);
  const row = document.createElement("div");
  row.className = "track-row";
  row.innerHTML = `
    <div class="track-row-cover" style="background:${coverGradient(track.id)}">${initials(track.title)}</div>
    <div>
      <div class="track-row-title">${track.title}</div>
      <div class="track-row-artist">${track.artist}</div>
    </div>
    <span class="track-row-status ${cached ? "cached" : "ondemand"}">${cached ? "En cache" : "À la demande"}</span>
    ${showAdd ? `<button class="ctl-btn" data-add="${track.id}" title="Ajouter à la playlist">＋</button>` : `<span></span>`}
    <span class="track-row-duration">${formatTime(track.duration)}</span>
  `;
  row.addEventListener("click", (e) => {
    if (e.target.closest("[data-add]")) {
      addToPlaylist(track.id);
    } else {
      playTrack(track.id);
    }
  });
  return row;
}

function renderGrid(container, tracks) {
  container.innerHTML = "";
  if (!tracks.length) {
    container.innerHTML = `<div class="empty-state">Aucun résultat dans l'index.</div>`;
    return;
  }
  tracks.forEach((t) => container.appendChild(renderCard(t)));
}

function renderList(container, ids, opts) {
  container.innerHTML = "";
  if (!ids.length) {
    container.innerHTML = `<div class="empty-state">Rien ici pour l'instant.</div>`;
    return;
  }
  ids.map(byId).filter(Boolean).forEach((t) => container.appendChild(renderRow(t, opts)));
}

function renderAll() {
  renderGrid($("#homeGrid"), WORLD_INDEX.slice(0, 8));
  renderList($("#playlistList"), state.playlist, { showAdd: false });
  renderList($("#cachedList"), [...state.cachedIds], { showAdd: false });
  updateStorageMeter();
}

function updateStorageMeter() {
  const mb = state.cachedIds.size * AVG_MP3_MB;
  $("#storageLabel").textContent = mb >= 1000 ? `${(mb / 1000).toFixed(2)} Go` : `${mb.toFixed(0)} Mo`;
  // Barre purement indicative, plafonnée à un repère visuel (ex: 2 Go)
  const pct = Math.min(100, (mb / 2000) * 100);
  $("#storageFill").style.width = `${Math.max(pct, 3)}%`;
}

// ---------------------------------------------------------------------------
// 4. Navigation entre vues
// ---------------------------------------------------------------------------
document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("is-active"));
    btn.classList.add("is-active");
    document.querySelectorAll(".view").forEach((v) => v.classList.add("is-hidden"));
    $(`#view-${btn.dataset.view}`).classList.remove("is-hidden");
  });
});

// ---------------------------------------------------------------------------
// 5. Recherche — en prod: fetch('/api/search?q=...') vers ton yt-dlp ytsearch
// ---------------------------------------------------------------------------
$("#searchInput").addEventListener("input", (e) => {
  const q = e.target.value.trim().toLowerCase();
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("is-active"));
  $('.nav-item[data-view="search"]').classList.add("is-active");
  document.querySelectorAll(".view").forEach((v) => v.classList.add("is-hidden"));
  $("#view-search").classList.remove("is-hidden");

  if (!q) {
    $("#searchSub").textContent = "Tape une requête ci-dessus pour interroger l'index complet.";
    renderGrid($("#searchGrid"), []);
    return;
  }
  const results = WORLD_INDEX.filter(
    (t) => t.title.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q)
  );
  $("#searchSub").textContent = `${results.length} résultat(s) dans l'index — aucun fichier n'est stocké tant qu'il n'est pas ajouté à une playlist.`;
  renderGrid($("#searchGrid"), results);
});

// ---------------------------------------------------------------------------
// 6. Ajout à une playlist -> déclenche la mise en cache (simulation)
//    En prod: POST /api/playlists/:id/tracks -> le serveur télécharge via
//    yt-dlp si le morceau n'est pas déjà dans /volume1/music/mymusic, puis
//    répond quand le fichier est prêt.
// ---------------------------------------------------------------------------
function addToPlaylist(trackId) {
  const track = byId(trackId);
  if (state.playlist.includes(trackId)) {
    toast(`Déjà dans la playlist : ${track.title}`);
    return;
  }
  state.playlist.push(trackId);

  if (state.cachedIds.has(trackId)) {
    toast(`Ajouté (déjà en cache) : ${track.title}`);
    renderAll();
    return;
  }

  toast(`Mise en cache de "${track.title}"…`);
  // Simulation du temps de téléchargement yt-dlp + ffmpeg
  setTimeout(() => {
    state.cachedIds.add(trackId);
    toast(`"${track.title}" est maintenant en cache`);
    renderAll();
  }, 1200);
}

function openTrackMenu(track) {
  addToPlaylist(track.id);
}

// ---------------------------------------------------------------------------
// 7. Lecteur — synthèse Web Audio pour la démo (aucun fichier audio externe).
//    En prod: remplacer playTrack() par un <audio> pointant vers
//    GET /api/stream/:trackId (flux Subsonic si en cache, sinon le backend
//    peut streamer directement depuis la source sans persister le fichier).
// ---------------------------------------------------------------------------
let audioCtx = null;
let oscillators = [];
let gainNode = null;
let playStartTime = 0;
let pausedAt = 0;
let rafId = null;

function ensureAudioCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    gainNode = audioCtx.createGain();
    gainNode.gain.value = $("#volumeSlider").value / 100;
    gainNode.connect(audioCtx.destination);
  }
}

function stopSynth() {
  oscillators.forEach((o) => {
    try { o.stop(); } catch (e) {}
  });
  oscillators = [];
  cancelAnimationFrame(rafId);
}

function startSynth(durationSec) {
  ensureAudioCtx();
  stopSynth();
  // Petit accord évolutif, juste pour donner un retour audio réel au clic play
  const baseFreqs = [110, 164.81, 220, 277.18];
  baseFreqs.forEach((f, i) => {
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.type = i === 0 ? "sine" : "triangle";
    osc.frequency.value = f;
    g.gain.value = 0.05 / (i + 1);
    osc.connect(g);
    g.connect(gainNode);
    osc.start();
    oscillators.push(osc);

    // Légère dérive de pitch façon "pad" pour que ce ne soit pas un bip statique
    osc.frequency.linearRampToValueAtTime(f * 1.015, audioCtx.currentTime + durationSec);
  });
}

function playTrack(trackId) {
  const track = byId(trackId);
  if (!track) return;

  if (state.currentTrackId === trackId && state.isPlaying) {
    pausePlayback();
    return;
  }

  state.currentTrackId = trackId;
  state.isPlaying = true;
  pausedAt = 0;
  playStartTime = performance.now();

  const cached = state.cachedIds.has(trackId);
  $("#playerTitle").textContent = track.title;
  $("#playerArtist").textContent = track.artist;
  $("#playerCover").style.background = coverGradient(track.id);
  $("#playerCachePill").textContent = cached ? "En cache" : "À la demande";
  $("#playerCachePill").className = `cache-pill ${cached ? "cached" : "ondemand"}`;
  $("#timeTotal").textContent = formatTime(track.duration);
  $("#playBtn").textContent = "⏸";

  if (!cached) {
    toast(`Flux à la demande — "${track.title}" (rien n'est stocké tant qu'il n'est pas ajouté à une playlist)`);
  }

  startSynth(track.duration);
  tickProgress();
}

function pausePlayback() {
  state.isPlaying = false;
  pausedAt += (performance.now() - playStartTime) / 1000;
  stopSynth();
  $("#playBtn").textContent = "▶";
}

function resumePlayback() {
  if (!state.currentTrackId) return;
  state.isPlaying = true;
  playStartTime = performance.now();
  const track = byId(state.currentTrackId);
  startSynth(Math.max(track.duration - pausedAt, 0.5));
  $("#playBtn").textContent = "⏸";
  tickProgress();
}

function tickProgress() {
  if (!state.isPlaying || !state.currentTrackId) return;
  const track = byId(state.currentTrackId);
  const elapsed = pausedAt + (performance.now() - playStartTime) / 1000;

  if (elapsed >= track.duration) {
    stopSynth();
    state.isPlaying = false;
    pausedAt = 0;
    $("#playBtn").textContent = "▶";
    $("#progressFill").style.width = "0%";
    $("#timeCurrent").textContent = "0:00";
    playNextTrack();
    return;
  }

  $("#progressFill").style.width = `${(elapsed / track.duration) * 100}%`;
  $("#timeCurrent").textContent = formatTime(elapsed);
  rafId = requestAnimationFrame(tickProgress);
}

function playNextTrack() {
  const pool = state.playlist.length ? state.playlist : WORLD_INDEX.map((t) => t.id);
  const idx = pool.indexOf(state.currentTrackId);
  const next = pool[(idx + 1) % pool.length];
  if (next) playTrack(next);
}

function playPrevTrack() {
  const pool = state.playlist.length ? state.playlist : WORLD_INDEX.map((t) => t.id);
  const idx = pool.indexOf(state.currentTrackId);
  const prev = pool[(idx - 1 + pool.length) % pool.length];
  if (prev) playTrack(prev);
}

$("#playBtn").addEventListener("click", () => {
  if (!state.currentTrackId) {
    playTrack(state.playlist[0] || WORLD_INDEX[0].id);
  } else if (state.isPlaying) {
    pausePlayback();
  } else {
    resumePlayback();
  }
});
$("#nextBtn").addEventListener("click", playNextTrack);
$("#prevBtn").addEventListener("click", playPrevTrack);

$("#volumeSlider").addEventListener("input", (e) => {
  if (gainNode) gainNode.gain.value = e.target.value / 100;
});

$("#progressTrack").addEventListener("click", (e) => {
  if (!state.currentTrackId) return;
  const track = byId(state.currentTrackId);
  const rect = e.currentTarget.getBoundingClientRect();
  const ratio = (e.clientX - rect.left) / rect.width;
  pausedAt = ratio * track.duration;
  if (state.isPlaying) {
    playStartTime = performance.now();
    startSynth(Math.max(track.duration - pausedAt, 0.5));
  } else {
    $("#progressFill").style.width = `${ratio * 100}%`;
    $("#timeCurrent").textContent = formatTime(pausedAt);
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
renderAll();
