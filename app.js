/**
 * Ale Music Box — GitHub Pages + Backblaze B2 + Cloudflare Worker
 * Al abrir la web: el Worker lista carpetas en B2 y la página las muestra sola.
 * La música NO está en tu PC ni en GitHub; solo en Backblaze.
 */

// =============================================================================
// Configuración
// =============================================================================

const WORKER_ORIGIN = 'https://api-musica.a-cambon.workers.dev';
const WORKER_BASE = `${WORKER_ORIGIN}/get-song`;

/** Cuentas B2 a leer (1 = alemusic-1, 2 = segundo bucket gratuito, etc.) */
const B2_ACCOUNTS = ['1'];

/** Se rellena al entrar, leyendo B2 vía Worker /list-library */
let MUSIC_LIBRARY = [];
const ACCESS_PASSWORD = '5112';
const SESSION_KEY = 'aleMusicBox_auth';
const THEME_KEY = 'aleMusicBox_theme';
const EQ_KEY = 'aleMusicBox_eq';
const SKIP_SECONDS = 10;

const EQ_FREQUENCIES = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const EQ_MIN_DB = -12;
const EQ_MAX_DB = 12;
const EQ_DEFAULT_DB = 0;
const EQ_Q = 1.4;

const state = {
  currentTrack: null,
  queue: [],
  queueIndex: -1,
  isSeeking: false,
  eqEnabled: false,
  eqReady: false,
  suppressAudioErrors: false
};

let audioErrorDebounce = null;

let audioContext = null;
let audioSource = null;
let eqFilters = [];

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const dom = {
  loginScreen: $('#login-screen'),
  loginForm: $('#login-form'),
  loginPassword: $('#login-password'),
  loginError: $('#login-error'),
  app: $('#app'),
  library: $('#library'),
  searchInput: $('#search-input'),
  themeChips: $$('.theme-chip'),
  audio: $('#audio'),
  playerTitle: $('#player-title'),
  playerArtist: $('#player-artist'),
  playerError: $('#player-error'),
  progressBar: $('#progress-bar'),
  timeCurrent: $('#time-current'),
  timeDuration: $('#time-duration'),
  btnPlay: $('#btn-play'),
  iconPlay: $('#icon-play'),
  iconPause: $('#icon-pause'),
  btnRewind: $('#btn-rewind'),
  btnForward: $('#btn-forward'),
  btnEq: $('#btn-eq'),
  eqBackdrop: $('#eq-backdrop'),
  eqPanel: $('#eq-panel'),
  eqSliders: $('#eq-sliders'),
  eqReset: $('#eq-reset'),
  eqClose: $('#eq-close')
};

// =============================================================================
// URLs de medios (Worker; en local opcional proxy /api/media)
// =============================================================================

function isLocalDev() {
  const h = location.hostname;
  return h === 'localhost' || h === '127.0.0.1';
}

function buildFilePath(folder, file) {
  const base = folder.replace(/\/$/, '');
  const name = file.replace(/^\//, '');
  return `${base}/${name}`;
}

function getMediaUrl(account, filePath) {
  const params = new URLSearchParams({
    account: String(account || '1'),
    file: filePath
  });
  if (isLocalDev()) {
    return `/api/media?${params.toString()}`;
  }
  return `${WORKER_BASE}?${params.toString()}`;
}

function getCoverUrl(album) {
  return getMediaUrl(album.account, buildFilePath(album.folder, 'portada.jpg'));
}

function getLocalCoverUrl(album) {
  return `covers/${encodeURI(album.folder)}/portada.jpg`;
}

// =============================================================================
// Utilidades
// =============================================================================

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function normalizeSearch(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function albumSearchText(album) {
  return normalizeSearch(`${album.artist} ${album.album}`);
}

function compareAlbums(a, b) {
  const opts = { sensitivity: 'base', numeric: true };
  const byArtist = a.artist.localeCompare(b.artist, 'es', opts);
  if (byArtist !== 0) return byArtist;
  const byAlbum = a.album.localeCompare(b.album, 'es', opts);
  if (byAlbum !== 0) return byAlbum;
  return a.folder.localeCompare(b.folder, 'es', opts);
}

function sortAlbums(albums) {
  return [...albums].sort(compareAlbums);
}

function showPlayerError(msg) {
  if (!dom.playerError) return;
  dom.playerError.textContent = msg || '';
  dom.playerError.hidden = !msg;
}

function clearPlayerErrorIfPlaying() {
  if (
    dom.audio &&
    !dom.audio.paused &&
    dom.audio.currentTime > 0 &&
    dom.audio.readyState >= 2 &&
    !dom.audio.error
  ) {
    showPlayerError('');
  }
}

function networkErrorMessage() {
  return isLocalDev()
    ? 'Error de red. ¿Está serve.ps1 en marcha?'
    : 'Error de red (get-song). Revisa el Worker en Cloudflare.';
}

function flattenTracks(album) {
  const list = [];
  const add = (track, volumeName = null) => {
    list.push({
      account: album.account,
      artist: album.artist,
      album: album.album,
      volume: volumeName,
      number: track.number,
      title: track.title,
      filePath: buildFilePath(album.folder, track.file)
    });
  };

  if (album.volumes?.length) {
    for (const vol of album.volumes) {
      for (const t of vol.tracks) add(t, vol.name);
    }
  } else if (album.tracks?.length) {
    for (const t of album.tracks) add(t);
  }
  return list;
}

// =============================================================================
// Ecualizador (solo al abrir el panel; no bloquea la reproducción inicial)
// =============================================================================

function initEqualizer() {
  if (state.eqReady) return true;
  try {
    if (!dom.audio.crossOrigin) dom.audio.crossOrigin = 'anonymous';
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    audioSource = audioContext.createMediaElementSource(dom.audio);
    let prev = audioSource;
    eqFilters = EQ_FREQUENCIES.map((freq) => {
      const f = audioContext.createBiquadFilter();
      f.type = 'peaking';
      f.frequency.value = freq;
      f.Q.value = EQ_Q;
      f.gain.value = EQ_DEFAULT_DB;
      prev.connect(f);
      prev = f;
      return f;
    });
    const masterGain = audioContext.createGain();
    masterGain.gain.value = 1;
    prev.connect(masterGain);
    masterGain.connect(audioContext.destination);
    state.eqReady = true;
    loadEqFromStorage();
    return true;
  } catch (e) {
    console.warn('Ecualizador no disponible:', e);
    return false;
  }
}

async function resumeAudioContext() {
  if (!audioContext) return;
  if (audioContext.state === 'suspended') await audioContext.resume();
}

/** Activa el grafo Web Audio y recupera el sonido si estaba reproduciendo */
async function activateEqualizer() {
  if (state.eqReady) {
    await resumeAudioContext();
    return true;
  }

  const wasPlaying = !dom.audio.paused && dom.audio.currentTime > 0;
  const savedTime = dom.audio.currentTime;

  state.suppressAudioErrors = true;
  try {
    if (wasPlaying) dom.audio.pause();

    if (!initEqualizer()) {
      if (wasPlaying) {
        dom.audio.currentTime = savedTime;
        try {
          await dom.audio.play();
        } catch {
          /* ignore */
        }
      }
      return false;
    }

    buildEqUI();
    await resumeAudioContext();
    dom.audio.currentTime = savedTime;

    if (wasPlaying) {
      try {
        await dom.audio.play();
      } catch (e) {
        console.warn('EQ: reanudar tras conectar grafo', e);
      }
    }
    clearPlayerErrorIfPlaying();
    return true;
  } finally {
    setTimeout(() => {
      state.suppressAudioErrors = false;
    }, 800);
  }
}

function loadEqFromStorage() {
  try {
    const raw = localStorage.getItem(EQ_KEY);
    if (!raw) return;
    const gains = JSON.parse(raw);
    if (!Array.isArray(gains)) return;
    gains.forEach((db, i) => {
      if (eqFilters[i] && typeof db === 'number') {
        eqFilters[i].gain.value = Math.max(EQ_MIN_DB, Math.min(EQ_MAX_DB, db));
      }
    });
  } catch {
    /* ignore */
  }
}

function saveEqToStorage() {
  if (!eqFilters.length) return;
  localStorage.setItem(
    EQ_KEY,
    JSON.stringify(eqFilters.map((f) => f.gain.value))
  );
}

function buildEqUI() {
  if (dom.eqSliders.children.length) return;
  EQ_FREQUENCIES.forEach((freq, i) => {
    const band = document.createElement('div');
    band.className = 'eq-band';
    const label = document.createElement('label');
    label.setAttribute('for', `eq-${i}`);
    label.textContent = freq >= 1000 ? `${freq / 1000}k` : String(freq);
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.id = `eq-${i}`;
    slider.className = 'eq-slider';
    slider.min = String(EQ_MIN_DB);
    slider.max = String(EQ_MAX_DB);
    slider.step = '0.5';
    slider.value = String(eqFilters[i]?.gain.value ?? EQ_DEFAULT_DB);
    slider.addEventListener('input', () => {
      resumeAudioContext();
      const db = parseFloat(slider.value);
      if (eqFilters[i]) eqFilters[i].gain.value = db;
      saveEqToStorage();
    });
    band.append(label, slider);
    dom.eqSliders.appendChild(band);
  });
}

function resetEq() {
  eqFilters.forEach((f) => {
    f.gain.value = EQ_DEFAULT_DB;
  });
  dom.eqSliders.querySelectorAll('.eq-slider').forEach((s) => {
    s.value = String(EQ_DEFAULT_DB);
  });
  saveEqToStorage();
}

// =============================================================================
// Reproductor
// =============================================================================

function setPlayIcon(playing) {
  const isPlaying =
    typeof playing === 'boolean' ? playing : !dom.audio.paused && !dom.audio.ended;
  dom.btnPlay.classList.toggle('is-playing', isPlaying);
  dom.btnPlay.setAttribute('aria-label', isPlaying ? 'Pausar' : 'Reproducir');
}

function isChromeBrowser() {
  return /Chrome\//i.test(navigator.userAgent) && !/Edg\//i.test(navigator.userAgent);
}

async function probeMediaUrl(url) {
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-1023' } });
    const ct = (res.headers.get('Content-Type') || '').toLowerCase();
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, detail: `Worker ${res.status}: ${text.slice(0, 120)}` };
    }
    if (ct.includes('json') || ct.includes('text/html') || ct.includes('text/plain')) {
      const text = await res.text().catch(() => '');
      return { ok: false, detail: `No es audio (${ct}): ${text.slice(0, 120)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: err.message };
  }
}

function waitForAudioReady(timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    if (dom.audio.readyState >= 2) {
      resolve();
      return;
    }
    const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    const onReady = () => {
      clearTimeout(timer);
      resolve();
    };
    const onErr = () => {
      clearTimeout(timer);
      reject(dom.audio.error || new Error('audio-error'));
    };
    dom.audio.addEventListener('canplay', onReady, { once: true });
    dom.audio.addEventListener('error', onErr, { once: true });
  });
}

function setAudioSource(url) {
  dom.audio.pause();
  dom.audio.removeAttribute('src');
  while (dom.audio.firstChild) dom.audio.removeChild(dom.audio.firstChild);
  const source = document.createElement('source');
  source.src = url;
  source.type = 'audio/flac';
  dom.audio.appendChild(source);
  dom.audio.load();
}

async function loadTrack(track) {
  state.currentTrack = track;
  const url = getMediaUrl(track.account, track.filePath);
  dom.playerTitle.textContent = track.title;
  dom.playerArtist.textContent = track.volume
    ? `${track.artist} — ${track.album} (${track.volume})`
    : `${track.artist} — ${track.album}`;

  showPlayerError('Cargando…');

  $$('.track-item.playing').forEach((el) => el.classList.remove('playing'));
  document
    .querySelector(`.track-item[data-file="${CSS.escape(track.filePath)}"]`)
    ?.classList.add('playing');

  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist,
      album: track.volume ? `${track.album} · ${track.volume}` : track.album
    });
  }

  const probe = await probeMediaUrl(url);
  if (!probe.ok) {
    showPlayerError(`get-song: ${probe.detail}`);
    setPlayIcon(false);
    throw new Error(probe.detail);
  }

  setAudioSource(url);
  setPlayIcon(false);
}

async function playAudio() {
  if (!state.currentTrack) return;

  if (isChromeBrowser()) {
    showPlayerError('Chrome no reproduce FLAC. Usa Firefox.');
    return;
  }

  if (state.eqEnabled) {
    if (!state.eqReady) {
      const ok = await activateEqualizer();
      if (!ok) showPlayerError('Ecualizador no disponible. Recarga la página.');
    } else {
      await resumeAudioContext();
    }
  }

  try {
    await waitForAudioReady();
    await dom.audio.play();
    setPlayIcon(true);
    showPlayerError('');
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'playing';
    }
  } catch (e) {
    console.error('playAudio', e, dom.audio.error);
    if (!dom.playerError.textContent || dom.playerError.textContent === 'Cargando…') {
      showPlayerError(
        'No se pudo reproducir. F12 → Red: revisa get-song o /api/media.'
      );
    }
    setPlayIcon(false);
  }
}

async function loadAndPlay(track) {
  try {
    await loadTrack(track);
    await playAudio();
  } catch (err) {
    console.error('loadAndPlay', err);
  }
}

function pauseAudio() {
  dom.audio.pause();
  setPlayIcon(false);
  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = 'paused';
  }
}

function togglePlayPause() {
  if (dom.audio.paused) {
    if (state.currentTrack && dom.audio.readyState < 2) {
      loadAndPlay(state.currentTrack);
    } else {
      playAudio();
    }
  } else {
    pauseAudio();
  }
}

function skip(delta) {
  if (!Number.isFinite(dom.audio.duration)) return;
  dom.audio.currentTime = Math.max(
    0,
    Math.min(dom.audio.duration, dom.audio.currentTime + delta)
  );
}

function updateProgressUI() {
  const { currentTime, duration } = dom.audio;
  dom.timeCurrent.textContent = formatTime(currentTime);
  if (Number.isFinite(duration) && duration > 0) {
    dom.timeDuration.textContent = formatTime(duration);
    if (!state.isSeeking) {
      dom.progressBar.value = String((currentTime / duration) * 100);
    }
  }
}

function playNextInQueue() {
  if (state.queueIndex < state.queue.length - 1) {
    state.queueIndex += 1;
    loadAndPlay(state.queue[state.queueIndex]);
  }
}

// =============================================================================
// UI biblioteca
// =============================================================================

function setupCover(wrap, album) {
  const img = document.createElement('img');
  img.className = 'album-cover';
  img.alt = '';
  img.loading = 'lazy';
  img.width = 72;
  img.height = 72;

  const urls = isLocalDev()
    ? [getLocalCoverUrl(album), getCoverUrl(album)]
    : [getCoverUrl(album)];

  let i = 0;
  const onErr = () => {
    i += 1;
    if (i < urls.length) {
      img.src = urls[i];
    } else {
      wrap.classList.add('cover-missing');
      img.remove();
    }
  };
  img.addEventListener('error', onErr);
  img.addEventListener('load', () => {
    if (img.naturalWidth > 0) wrap.classList.remove('cover-missing');
  });
  wrap.appendChild(img);
  img.src = urls[0];
}

function renderTrackItem(track, album) {
  const filePath = buildFilePath(album.folder, track.file);
  const li = document.createElement('li');
  li.className = 'track-item';
  li.dataset.file = filePath;
  li.innerHTML = `
    <span class="track-number">${track.number}</span>
    <span class="track-title">${track.title}</span>
  `;
  li.addEventListener('click', () => {
    const q = flattenTracks(album);
    state.queue = q;
    state.queueIndex = q.findIndex((t) => t.filePath === filePath);
    loadAndPlay(q[state.queueIndex]);
  });
  return li;
}

function renderTrackList(tracks, album) {
  const ul = document.createElement('ul');
  ul.className = 'track-list';
  [...tracks]
    .sort((a, b) => a.number - b.number)
    .forEach((t) => ul.appendChild(renderTrackItem(t, album)));
  return ul;
}

function renderAlbumCard(album) {
  const card = document.createElement('article');
  card.className = 'album-card';
  card.dataset.search = albumSearchText(album);

  const header = document.createElement('button');
  header.type = 'button';
  header.className = 'album-header';

  const coverWrap = document.createElement('div');
  coverWrap.className = 'album-cover-wrap';
  setupCover(coverWrap, album);

  const meta = document.createElement('div');
  meta.className = 'album-meta';
  meta.innerHTML = `
    <p class="album-artist">${album.artist}</p>
    <h2 class="album-title">${album.album}</h2>
  `;

  const chevron = document.createElement('span');
  chevron.className = 'album-chevron';
  chevron.innerHTML =
    '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg>';

  header.append(coverWrap, meta, chevron);

  const body = document.createElement('div');
  body.className = 'album-body';

  if (album.volumes?.length) {
    for (const vol of album.volumes) {
      const block = document.createElement('div');
      block.className = 'volume-block';
      const vh = document.createElement('button');
      vh.type = 'button';
      vh.className = 'volume-header';
      vh.innerHTML = `<span>${vol.name}</span><svg class="volume-chevron" viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg>`;
      const vt = document.createElement('div');
      vt.className = 'volume-tracks';
      vt.appendChild(renderTrackList(vol.tracks, album));
      vh.addEventListener('click', (e) => {
        e.stopPropagation();
        block.classList.toggle('expanded');
      });
      block.append(vh, vt);
      body.appendChild(block);
    }
  } else if (album.tracks?.length) {
    body.appendChild(renderTrackList(album.tracks, album));
  } else {
    const p = document.createElement('p');
    p.className = 'album-empty';
    p.textContent = 'Carpeta sin archivos de audio en B2.';
    body.appendChild(p);
  }

  header.addEventListener('click', () => card.classList.toggle('expanded'));
  card.append(header, body);
  return card;
}

function renderLibrary() {
  dom.library.innerHTML = '';
  sortAlbums(MUSIC_LIBRARY).forEach((album) => {
    dom.library.appendChild(renderAlbumCard(album));
  });
}

let searchHighlightTimer = null;

function scrollToFirstMatch(query) {
  const q = normalizeSearch(query.trim());
  $$('.album-card').forEach((c) => c.classList.remove('search-highlight'));
  if (!q) return;
  const match = [...$$('.album-card')].find((c) => c.dataset.search.includes(q));
  if (!match) return;
  match.classList.add('search-highlight');
  match.classList.add('expanded');
  match.scrollIntoView({ behavior: 'smooth', block: 'center' });
  clearTimeout(searchHighlightTimer);
  searchHighlightTimer = setTimeout(() => match.classList.remove('search-highlight'), 2500);
}

// =============================================================================
// Temas y login
// =============================================================================

function applyTheme(id) {
  document.documentElement.setAttribute('data-theme', id);
  const colors = {
    ocre: '#F5E6CA',
    bosque: '#EFF5E8',
    mar: '#E8F0F5',
    lavanda: '#EEE8F5'
  };
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = colors[id] || colors.ocre;
  dom.themeChips.forEach((chip) => {
    chip.classList.toggle('active', chip.dataset.theme === id);
  });
  localStorage.setItem(THEME_KEY, id);
}

async function fetchLibraryFromBackblaze() {
  const albums = [];
  for (const account of B2_ACCOUNTS) {
    const url = isLocalDev()
      ? `/api/library?account=${encodeURIComponent(account)}`
      : `${WORKER_ORIGIN}/list-library?account=${encodeURIComponent(account)}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(
        `Backblaze (cuenta ${account}): error ${res.status}. ¿Tienes /list-library en el Worker?`
      );
    }
    const data = await res.json();
    if (Array.isArray(data.albums)) albums.push(...data.albums);
  }
  return albums;
}

function showLibraryLoading(text) {
  dom.library.innerHTML = `<p class="library-loading">${text}</p>`;
}

async function showApp() {
  dom.loginScreen.hidden = true;
  dom.app.hidden = false;
  showLibraryLoading('Leyendo discos desde Backblaze…');

  try {
    MUSIC_LIBRARY = await fetchLibraryFromBackblaze();
    if (!MUSIC_LIBRARY.length) {
      showLibraryLoading('No hay carpetas con audio en Backblaze. Sube discos como Carpetas/nombre.flac');
      return;
    }
    renderLibrary();
  } catch (err) {
    console.error(err);
    showLibraryLoading(
      `${err.message}<br><br>Despliega <code>cloudflare-worker.js</code> con las claves B2 en secretos del Worker.`
    );
  }
}

function handleLogin(e) {
  e.preventDefault();
  if (dom.loginPassword.value === ACCESS_PASSWORD) {
    sessionStorage.setItem(SESSION_KEY, 'true');
    dom.loginError.hidden = true;
    showApp();
  } else {
    dom.loginError.hidden = false;
    dom.loginPassword.select();
  }
}

async function toggleEqPanel(open) {
  const on = open ?? dom.eqPanel.hidden;
  dom.eqPanel.hidden = !on;
  if (dom.eqBackdrop) {
    dom.eqBackdrop.hidden = !on;
    dom.eqBackdrop.setAttribute('aria-hidden', on ? 'false' : 'true');
  }
  dom.app.classList.toggle('eq-open', on);
  if (on) {
    state.eqEnabled = true;
    const ok = await activateEqualizer();
    if (!ok) {
      showPlayerError('Ecualizador no disponible (CORS). Recarga la página.');
      return;
    }
    showPlayerError('');
    eqFilters.forEach((f, i) => {
      const s = dom.eqSliders.querySelector(`#eq-${i}`);
      if (s) s.value = String(f.gain.value);
    });
  }
}

function bindEvents() {
  dom.loginForm.addEventListener('submit', handleLogin);
  dom.searchInput.addEventListener('input', (e) => scrollToFirstMatch(e.target.value));
  dom.themeChips.forEach((chip) => {
    chip.addEventListener('click', () => applyTheme(chip.dataset.theme));
  });
  dom.btnPlay.addEventListener('click', togglePlayPause);
  dom.btnRewind.addEventListener('click', () => skip(-SKIP_SECONDS));
  dom.btnForward.addEventListener('click', () => skip(SKIP_SECONDS));
  dom.btnEq.addEventListener('click', () => {
    toggleEqPanel();
  });
  dom.eqClose.addEventListener('click', () => toggleEqPanel(false));
  dom.eqBackdrop?.addEventListener('click', () => toggleEqPanel(false));
  dom.eqReset.addEventListener('click', resetEq);

  dom.audio.addEventListener('timeupdate', () => {
    updateProgressUI();
    clearPlayerErrorIfPlaying();
  });
  dom.audio.addEventListener('loadedmetadata', updateProgressUI);
  dom.audio.addEventListener('ended', () => {
    setPlayIcon(false);
    playNextInQueue();
  });
  dom.audio.addEventListener('play', () => {
    setPlayIcon(true);
    clearPlayerErrorIfPlaying();
  });
  dom.audio.addEventListener('playing', () => {
    setPlayIcon(true);
    showPlayerError('');
  });
  dom.audio.addEventListener('pause', () => setPlayIcon(false));
  dom.audio.addEventListener('error', () => {
    if (state.suppressAudioErrors) return;

    clearTimeout(audioErrorDebounce);
    audioErrorDebounce = setTimeout(() => {
      if (state.suppressAudioErrors) return;
      if (!dom.audio.error) return;
      if (!dom.audio.paused && dom.audio.currentTime > 0 && dom.audio.readyState >= 2) {
        showPlayerError('');
        return;
      }

      const code = dom.audio.error?.code;
      let msg = 'Error al cargar el audio desde el Worker.';
      if (code === 2) {
        msg = networkErrorMessage();
      } else if (code === 4) {
        msg = isChromeBrowser()
          ? 'Chrome no reproduce FLAC. Usa Firefox.'
          : 'El Worker no devolvió audio válido. Prueba get-song en el navegador o redeploy.';
      }
      showPlayerError(msg);
      setPlayIcon(false);
      console.error('Audio error', code, dom.audio.currentSrc);
    }, 500);
  });

  dom.progressBar.addEventListener('pointerdown', () => {
    state.isSeeking = true;
  });
  dom.progressBar.addEventListener('input', (e) => {
    if (Number.isFinite(dom.audio.duration)) {
      dom.audio.currentTime = (parseFloat(e.target.value) / 100) * dom.audio.duration;
    }
    updateProgressUI();
  });
  dom.progressBar.addEventListener('pointerup', () => {
    state.isSeeking = false;
  });

  if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('play', () => playAudio());
    navigator.mediaSession.setActionHandler('pause', () => pauseAudio());
    navigator.mediaSession.setActionHandler('seekbackward', () => skip(-SKIP_SECONDS));
    navigator.mediaSession.setActionHandler('seekforward', () => skip(SKIP_SECONDS));
  }
}

function init() {
  applyTheme(localStorage.getItem(THEME_KEY) || 'ocre');
  bindEvents();
  if (sessionStorage.getItem(SESSION_KEY) === 'true') {
    showApp();
  }
}

init();
