/**
 * PEGAR en tu Worker de Cloudflare (junto con tu get-song existente).
 * Coloca la comprobación de list-library ANTES de pedir el parámetro "file".
 */

const AUDIO_EXT = /\.(flac|mp3|m4a|aac|ogg|wav)$/i;

function getB2Config(env, account) {
  const n = String(account || '1');
  return {
    keyId: env[`B2_KEY_ID_${n}`],
    appKey: env[`B2_APP_KEY_${n}`],
    bucketId: env[`B2_BUCKET_ID_${n}`]
  };
}

async function b2Authorize(keyId, appKey) {
  const res = await fetch('https://api.backblazeb2.com/b2api/v2/b2_authorize_account', {
    headers: { Authorization: 'Basic ' + btoa(keyId + ':' + appKey) }
  });
  if (!res.ok) throw new Error('B2 authorize: ' + res.status);
  return res.json();
}

async function b2ListAllFiles(apiUrl, token, bucketId) {
  const files = [];
  let start = null;
  do {
    const body = { bucketId, maxFileCount: 10000 };
    if (start) body.startFileName = start;
    const res = await fetch(apiUrl + '/b2api/v2/b2_list_file_names', {
      method: 'POST',
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error('B2 list: ' + res.status);
    const data = await res.json();
    files.push.apply(files, data.files || []);
    start = data.nextFileName;
  } while (start);
  return files;
}

function displayTitle(name) {
  return name.replace(/\.(flac|mp3|m4a|aac|ogg|wav)$/i, '').replace(/^\d+\.-\s*/, '').trim();
}

function trackNum(name) {
  const m = name.match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : 9999;
}

async function buildLibrary(env, account) {
  const cfg = getB2Config(env, account);
  if (!cfg.keyId || !cfg.appKey || !cfg.bucketId) {
    throw new Error('Faltan secretos B2_KEY_ID_' + account + ' etc.');
  }
  const auth = await b2Authorize(cfg.keyId, cfg.appKey);
  const raw = await b2ListAllFiles(auth.apiUrl, auth.authorizationToken, cfg.bucketId);
  const byFolder = new Map();

  for (let i = 0; i < raw.length; i++) {
    const path = raw[i].fileName;
    const slash = path.indexOf('/');
    if (slash === -1) continue;
    const folder = path.slice(0, slash);
    const file = path.slice(slash + 1);
    if (!AUDIO_EXT.test(file)) continue;
    if (file.toLowerCase() === 'portada.jpg') continue;
    if (!byFolder.has(folder)) byFolder.set(folder, []);
    byFolder.get(folder).push(file);
  }

  const albums = [];
  for (const [folder, files] of byFolder) {
    const sep = folder.indexOf(' - ');
    const artist = sep === -1 ? 'Desconocido' : folder.slice(0, sep).trim();
    const album = sep === -1 ? folder : folder.slice(sep + 3).trim();
    const tracks = files
      .sort(function (a, b) {
        return trackNum(a) - trackNum(b) || a.localeCompare(b);
      })
      .map(function (file, idx) {
        return {
          number: trackNum(file) || idx + 1,
          title: displayTitle(file),
          file: file
        };
      });
    albums.push({
      account: String(account),
      artist: artist,
      album: album,
      folder: folder,
      tracks: tracks
    });
  }
  albums.sort(function (a, b) {
    return a.album.localeCompare(b.album, 'es');
  });
  return albums;
}

// En tu export default { async fetch(request, env) { ... } }:
//
// const url = new URL(request.url);
// if (url.pathname.indexOf('list-library') !== -1) {
//   const account = url.searchParams.get('account') || '1';
//   const albums = await buildLibrary(env, account);
//   return new Response(JSON.stringify({ albums: albums }), {
//     headers: {
//       'Access-Control-Allow-Origin': '*',
//       'Content-Type': 'application/json; charset=utf-8'
//     }
//   });
// }
// // DESPUÉS: tu lógica de get-song que pide "file"
