---
name: b2-cloudflare-ale-music
description: >-
  Arquitectura Ale Music Box: GitHub Pages estático, Backblaze B2 privado,
  proxy Cloudflare Worker (get-song). Usar al editar MUSIC_LIBRARY, Worker,
  rutas de archivos FLAC/portada, o depurar 401/CORS/bloqueadores.
---

# Ale Music Box — B2 + Cloudflare Worker

## Arquitectura (no romper)

```
GitHub Pages (HTML/CSS/JS)
    → fetch get-song?account=N&file=ruta/exacta
Cloudflare Worker (api-musica.*.workers.dev)
    → Backblaze B2 bucket privado (alemusic-1, alemusic-2, …)
```

- La web **no** puede hablar con B2 sola (las claves secretas no van en GitHub).
- Al abrir: `GET /list-library?account=1` → el Worker lista B2 y devuelve JSON con carpetas y `.flac`.
- La música vive **solo en B2**; en el PC no hace falta copiar discos, solo desplegar el Worker.
- Cada **carpeta** en el bucket = un disco. Dentro: `portada.jpg` + archivos `.flac`.
- Nombre carpeta recomendado: `Artista - Álbum` (la web separa artista y álbum).
- `file` en la respuesta = nombre **exacto** del archivo en B2; `title` = texto limpio en pantalla.

## Worker get-song

- URL: `https://api-musica.a-cambon.workers.dev/get-song`
- Params: `account` (default `1`), `file` (ruta completa dentro del bucket).
- Debe soportar **Range requests** para seek en FLAC.
- Debe enviar **CORS**: `Access-Control-Allow-Origin: *` (o el dominio de GitHub Pages).
- Si devuelve **401**: la app no cargará audio ni portadas hasta configurar auth en Worker o token.

## Errores frecuentes y causa

| Síntoma | Causa probable |
|--------|----------------|
| Solo 1 disco | `MUSIC_LIBRARY` tiene una entrada; no usar auto-discovery vacío |
| Disco sin canciones | `tracks: []` o `catalog.json` vacío; poner lista en `MUSIC_LIBRARY` |
| Nombre mal en B2 | `file` distinto del nombre real; copiar desde B2 o `sync-library.ps1` |
| `ERR_BLOCKED_BY_CLIENT` | uBlock/AdBlock bloquea `*.workers.dev`; incógnito o desactivar |
| No suena FLAC | Chrome/Edge; usar **Firefox** en móvil |
| Portada rota | 401 Worker, ruta incorrecta, o bloqueador |
| Ecualizador rompe audio | Activar EQ solo tras abrir panel; requiere CORS |

## Añadir discos (flujo correcto)

1. En Backblaze B2: crear carpeta `Artista - Álbum` con `portada.jpg` y los `.flac`.
2. Recargar la web → aparece solo (vía `/list-library`).
3. No editar `MUSIC_LIBRARY` a mano salvo emergencia.
4. `sync-library.ps1` es solo ayuda opcional offline, no obligatorio.

## Local vs producción

- **Local:** `serve.ps1` puerto **8080**; proxy `/api/media` evita bloqueo a workers.dev.
- **Portadas local:** `covers/<folder>/portada.jpg` (opcional).
- **Producción:** URLs directas al Worker desde GitHub Pages.

## Backblaze B2 (recordatorio)

- Object storage S3-compatible; buckets privados.
- Multi-cuenta: varios buckets 10 GB → `account: '1'`, `'2'` en Worker.
- No listar desde navegador sin API; por eso el índice es estático.

## Cloudflare Workers (recordatorio)

- Workers = proxy/API sin servidor propio.
- R2 es almacenamiento CF; este proyecto usa **B2**, no R2.
- No implementar `list-folder` en la app hasta que el Worker lo exponga y funcione.

## Archivos del proyecto

| Archivo | Rol |
|---------|-----|
| `app.js` | `MUSIC_LIBRARY` + app |
| `index.html` / `styles.css` | UI MD3 |
| `serve.ps1` | Servidor local + proxy |
| `sync-library.ps1` | Generar entradas desde carpetas PC |
| `copy-portada.ps1` | Copiar portada a `covers/` |

No depender de `library.js` ni `catalog.json` en runtime salvo que el usuario lo pida explícitamente.
