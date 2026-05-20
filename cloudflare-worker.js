/**
 * Cloudflare Worker — pegar o fusionar con tu Worker en api-musica.a-cambon.workers.dev
 *
 * Variables secretas (Dashboard → Worker → Settings → Variables):
 *   B2_KEY_ID_1, B2_APP_KEY_1, B2_BUCKET_ID_1
 *   (cuenta 2: B2_KEY_ID_2, B2_APP_KEY_2, B2_BUCKET_ID_2, …)
 *
 * Rutas:
 *   GET /list-library?account=1  → lista carpetas (discos) y pistas desde B2
 *   GET /get-song?account=1&file=ruta/archivo.flac  → audio/imagen (Range + CORS)
 */

const AUDIO_EXT = /\.(flac|mp3|m4a|aac|ogg|wav)$/i;
const COVER_NAMES = new Set(['portada.jpg', 'portada.jpeg', 'portada.png', 'cover.jpg']);

function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Content-Type',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
    ...extra
  };
}

/** Lee variable de entorno (tolera espacio accidental al final del nombre en Cloudflare) */
function getEnvVar(env, logicalName, account) {
  const n = String(account || '1');
  const wanted = [`${logicalName}_${n}`];
  if (n === '1') wanted.push(logicalName);
  if (logicalName === 'B2_APP_KEY') wanted.push(`B2_APPLICATION_KEY_${n}`, 'B2_APPLICATION_KEY');

  for (const w of wanted) {
    if (env[w] != null && String(env[w]).trim()) return String(env[w]).trim();
  }
  for (const key of Object.keys(env)) {
    if (wanted.includes(key.trim())) {
      const v = env[key];
      if (v != null && String(v).trim()) return String(v).trim();
    }
  }
  return '';
}

function envStatus(env, account) {
  const n = String(account || '1');
  const rawKeys = Object.keys(env).filter((k) => k.trim().startsWith('B2_'));
  const badNames = rawKeys.filter((k) => k !== k.trim());
  return {
    account: n,
    B2_KEY_ID: !!getEnvVar(env, 'B2_KEY_ID', n),
    B2_APP_KEY: !!getEnvVar(env, 'B2_APP_KEY', n),
    B2_BUCKET_ID: !!getEnvVar(env, 'B2_BUCKET_ID', n),
    b2KeysFound: rawKeys,
    warningBadKeyNames: badNames.length
      ? `Espacio extra en el nombre: ${badNames.map((k) => JSON.stringify(k)).join(', ')} — renómbralo en Cloudflare`
      : null
  };
}

function getAccountConfig(env, account) {
  const n = String(account || '1');
  const keyId = getEnvVar(env, 'B2_KEY_ID', n);
  const appKey = getEnvVar(env, 'B2_APP_KEY', n);
  const bucketId = getEnvVar(env, 'B2_BUCKET_ID', n);

  const missing = [];
  if (!keyId) missing.push(`B2_KEY_ID_${n}`);
  if (!appKey) missing.push(`B2_APP_KEY_${n}`);
  if (!bucketId) missing.push(`B2_BUCKET_ID_${n}`);

  if (missing.length) {
    throw new Error(
      `Faltan secretos en el Worker: ${missing.join(', ')}. ` +
        'Cloudflare → Worker → Settings → Variables → Secrets (Encrypt). ' +
        'Tras añadirlos, pulsa Deploy de nuevo.'
    );
  }
  return { keyId, appKey, bucketId };
}

async function b2Authorize(keyId, appKey) {
  const credentials = btoa(`${keyId}:${appKey}`);
  const res = await fetch('https://api.backblazeb2.com/b2api/v2/b2_authorize_account', {
    headers: { Authorization: `Basic ${credentials}` }
  });
  if (!res.ok) throw new Error(`B2 authorize: ${res.status}`);
  return res.json();
}

async function b2ListAllFiles(apiUrl, authToken, bucketId) {
  const files = [];
  let startFileName = null;
  do {
    const body = { bucketId, maxFileCount: 10000 };
    if (startFileName) body.startFileName = startFileName;
    const res = await fetch(`${apiUrl}/b2api/v2/b2_list_file_names`, {
      method: 'POST',
      headers: {
        Authorization: authToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`B2 list: ${res.status}`);
    const data = await res.json();
    files.push(...(data.files || []));
    startFileName = data.nextFileName;
  } while (startFileName);
  return files;
}

function trackNumberFromFile(name) {
  const base = name.includes('/') ? name.split('/').pop() : name;
  const m = base.match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : 9999;
}

function displayTitle(filename) {
  const base = filename.includes('/') ? filename.split('/').pop() : filename;
  return base
    .replace(/\.(flac|mp3|m4a|aac|ogg|wav)$/i, '')
    .replace(/^\d+\.\s*-?\s*/, '')
    .trim();
}

function volumeLabel(folderName) {
  const m = folderName.match(/^cd[-\s]?(\d+)$/i);
  if (m) return `CD ${m[1]}`;
  return folderName.replace(/-/g, ' ');
}

function parseArtistAlbum(folder) {
  const i = folder.indexOf(' - ');
  if (i === -1) return { artist: 'Desconocido', album: folder };
  return {
    artist: folder.slice(0, i).trim(),
    album: folder.slice(i + 3).trim()
  };
}

async function buildLibrary(env, account) {
  const cfg = getAccountConfig(env, account);
  const auth = await b2Authorize(cfg.keyId, cfg.appKey);
  const rawFiles = await b2ListAllFiles(auth.apiUrl, auth.authorizationToken, cfg.bucketId);

  const byFolder = new Map();
  for (const item of rawFiles) {
    const path = item.fileName;
    const slash = path.indexOf('/');
    if (slash === -1) continue;
    const folder = path.slice(0, slash);
    const file = path.slice(slash + 1);
    if (!AUDIO_EXT.test(file) || COVER_NAMES.has(file.toLowerCase())) continue;
    if (!byFolder.has(folder)) byFolder.set(folder, []);
    byFolder.get(folder).push(file);
  }

  const albums = [];
  for (const [folder, files] of byFolder) {
    if (!files.length) continue;
    const { artist, album } = parseArtistAlbum(folder);
    const hasSubfolders = files.some((f) => f.includes('/'));

    const albumEntry = { account: String(account), artist, album, folder };

    if (hasSubfolders) {
      const volMap = new Map();
      const rootTracks = [];
      for (const rel of files) {
        const slash = rel.indexOf('/');
        if (slash === -1) {
          rootTracks.push(rel);
          continue;
        }
        const volKey = rel.slice(0, slash);
        const trackFile = rel.slice(slash + 1);
        if (!volMap.has(volKey)) volMap.set(volKey, []);
        volMap.get(volKey).push(`${volKey}/${trackFile}`);
      }
      const volumes = [...volMap.entries()]
        .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
        .map(([volKey, volFiles]) => ({
          name: volumeLabel(volKey),
          tracks: volFiles
            .sort((a, b) => {
              const na = trackNumberFromFile(a);
              const nb = trackNumberFromFile(b);
              return na !== nb ? na - nb : a.localeCompare(b);
            })
            .map((file, idx) => ({
              number: trackNumberFromFile(file) || idx + 1,
              title: displayTitle(file),
              file
            }))
        }));
      if (rootTracks.length) {
        volumes.unshift({
          name: 'Disco',
          tracks: rootTracks.map((file, idx) => ({
            number: trackNumberFromFile(file) || idx + 1,
            title: displayTitle(file),
            file
          }))
        });
      }
      albumEntry.volumes = volumes;
    } else {
      albumEntry.tracks = files
        .sort((a, b) => {
          const na = trackNumberFromFile(a);
          const nb = trackNumberFromFile(b);
          return na !== nb ? na - nb : a.localeCompare(b);
        })
        .map((file, idx) => ({
          number: trackNumberFromFile(file) || idx + 1,
          title: displayTitle(file),
          file
        }));
    }

    albums.push(albumEntry);
  }

  albums.sort((a, b) => {
    const opts = { sensitivity: 'base', numeric: true };
    const byArtist = a.artist.localeCompare(b.artist, 'es', opts);
    if (byArtist !== 0) return byArtist;
    const byAlbum = a.album.localeCompare(b.album, 'es', opts);
    if (byAlbum !== 0) return byAlbum;
    return a.folder.localeCompare(b.folder, 'es', opts);
  });
  return albums;
}

function contentType(path) {
  const ext = path.split('.').pop()?.toLowerCase();
  const map = {
    flac: 'audio/flac',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp'
  };
  return map[ext] || 'application/octet-stream';
}

async function handleGetSong(request, env, url) {
  const account = url.searchParams.get('account') || '1';
  const file = url.searchParams.get('file');
  if (!file) {
    return new Response('Missing file', { status: 400, headers: corsHeaders() });
  }

  const cfg = getAccountConfig(env, account);
  const auth = await b2Authorize(cfg.keyId, cfg.appKey);
  const bucketName =
    auth.allowed?.bucketName ||
    auth.bucketName ||
    getEnvVar(env, 'B2_BUCKET_NAME', account);
  if (!bucketName) {
    throw new Error('Falta nombre del bucket (B2_BUCKET_NAME_1 = alemusic-1)');
  }
  const encodedPath = file.split('/').map(encodeURIComponent).join('/');
  const fileUrl = `${auth.downloadUrl}/file/${bucketName}/${encodedPath}`;
  const range = request.headers.get('Range');

  const b2Res = await fetch(fileUrl, {
    headers: {
      Authorization: auth.authorizationToken,
      ...(range ? { Range: range } : {})
    }
  });

  const headers = corsHeaders({
    'Content-Type': contentType(file),
    'Accept-Ranges': 'bytes'
  });
  const cl = b2Res.headers.get('Content-Length');
  const cr = b2Res.headers.get('Content-Range');
  if (cl) headers['Content-Length'] = cl;
  if (cr) headers['Content-Range'] = cr;

  return new Response(b2Res.body, {
    status: b2Res.status,
    headers
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '') || '/';

    try {
      if (path === '/debug-env' || path.endsWith('/debug-env')) {
        const account = url.searchParams.get('account') || '1';
        const status = envStatus(env, account);
        const ok = status.B2_KEY_ID && status.B2_APP_KEY && status.B2_BUCKET_ID;
        return new Response(
          JSON.stringify({
            ok,
            message: ok
              ? 'Variables visibles. Prueba /list-library'
              : status.warningBadKeyNames ||
                'Faltan variables o el Worker no se ha vuelto a desplegar tras añadirlas.',
            status,
            deployedCodeVersion: '2026-03-v3'
          }),
          {
            headers: corsHeaders({ 'Content-Type': 'application/json; charset=utf-8' })
          }
        );
      }

      if (path === '/list-library' || path.endsWith('/list-library')) {
        const account = url.searchParams.get('account') || '1';
        const albums = await buildLibrary(env, account);
        return new Response(JSON.stringify({ albums }), {
          headers: corsHeaders({ 'Content-Type': 'application/json; charset=utf-8' })
        });
      }

      if (path === '/get-song' || path.endsWith('/get-song')) {
        return handleGetSong(request, env, url);
      }

      return new Response('Not found', { status: 404, headers: corsHeaders() });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: corsHeaders({ 'Content-Type': 'application/json' })
      });
    }
  }
};
