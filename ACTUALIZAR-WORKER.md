# Actualizar el Worker en Cloudflare (añadir list-library)

## Por qué ves este error

Al abrir `.../list-library?account=1` el Worker responde:

> Falta el parámetro "file" en la petición.

Eso significa que **solo está desplegado `get-song`**. Esa ruta exige `file`; no conoce `list-library` todavía.

Los secretos B2 (`B2_KEY_ID_1`, etc.) están bien. Falta **actualizar el código** del Worker.

---

## Opción A — Reemplazar todo el código (recomendado)

1. Entra en [Cloudflare Dashboard](https://dash.cloudflare.com) → **Workers y Pages**.
2. Abre el Worker **api-musica** (o el que usa `api-musica.a-cambon.workers.dev`).
3. **Editar código** → borra el contenido actual.
4. Copia **todo** el archivo `cloudflare-worker.js` de este proyecto y pégalo.
5. **Guardar y desplegar** (Deploy).

Prueba otra vez:

`https://api-musica.a-cambon.workers.dev/list-library?account=1`

Debe devolver JSON: `{"albums":[...]}`

**Nota:** Si tu `get-song` antiguo funcionaba distinto, prueba también una canción y una portada después del despliegue.

---

## Opción B — Solo añadir list-library (si quieres conservar tu get-song)

Al **inicio** de tu función `fetch` (antes de comprobar `file`), añade:

```javascript
const url = new URL(request.url);
const path = url.pathname;

if (path === '/list-library' || path.endsWith('/list-library')) {
  const account = url.searchParams.get('account') || '1';
  try {
    const albums = await buildLibrary(env, account); // ver list-library-snippet.js
    return new Response(JSON.stringify({ albums }), {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json; charset=utf-8'
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
    });
  }
}

// ... aquí sigue tu código actual de get-song (comprueba file) ...
```

Las funciones `buildLibrary`, `b2Authorize`, etc. están en `list-library-snippet.js` (mismo proyecto).

---

## Error: `Cuenta B2 "1" no configurada` o `Faltan secretos...`

El código nuevo está desplegado, pero **no encuentra** las variables. Revisa:

1. **Workers y Pages** → el Worker correcto (`api-musica`) → **Settings** → **Variables**.
2. Pestaña **Secrets** (o Variables de entorno) — deben existir **exactamente** (mayúsculas):

| Nombre exacto | Valor (desde Backblaze) |
|---------------|-------------------------|
| `B2_KEY_ID_1` | keyID de la Application Key |
| `B2_APP_KEY_1` | applicationKey (solo se ve al crear la clave) |
| `B2_BUCKET_ID_1` | ID del bucket (no el nombre `alemusic-1`) |

3. **No** uses solo `B2_KEY_ID` sin `_1` salvo que sea cuenta única y el Worker acepta fallback (cuenta 1).
4. Después de crear o editar secretos → **Deploy** otra vez el Worker.
5. **Dónde sacar `B2_BUCKET_ID_1`:** Backblaze → Buckets → `alemusic-1` → en detalles aparece **Bucket ID** (serie de letras/números, no el nombre).

Si ayer creaste secretos con otros nombres, renómbralos o créalos de nuevo con los nombres de la tabla.

### Sigues viendo `Cuenta B2 "1" no configurada`

Ese texto es del **código viejo**. El código nuevo dice `Faltan secretos en el Worker: B2_...`.

1. Vuelve a **Editar código** y pega otra vez **todo** `cloudflare-worker.js`.
2. Pulsa **Deploy** (arriba a la derecha). Solo guardar variables **no** actualiza el Worker.
3. Abre: `https://api-musica.a-cambon.workers.dev/debug-env?account=1`
   - Debe mostrar `"deployedCodeVersion": "2026-03-v2"` y `"ok": true`.
   - Si `b2KeysFound` está vacío `[]`, las variables no están ligadas → Deploy otra vez.
4. Luego: `/list-library?account=1`

**Plaintext** en Variables está bien; tras añadir `B2_BUCKET_ID_1` hace falta **Deploy** sí o sí.

---

## Permisos de la Application Key en B2

La clave B2 debe poder **leer** el bucket (listar y descargar). En Backblaze → Application Keys → tu clave → acceso al bucket `alemusic-1`.

---

## Después del despliegue

1. `list-library?account=1` → JSON con discos.
2. `serve.ps1` → http://127.0.0.1:8080/ → la web carga carpetas sola.
3. Sube la web a GitHub Pages (sin cambiar secretos; siguen en Cloudflare).
