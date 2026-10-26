# Mi lista de Steam

Página web (GitHub Pages) + proxy gratuito (Cloudflare Workers) + lista guardada en `juegos.json` dentro del mismo repositorio.

```
index.html, style.css, app.js, config.js   -> la página (GitHub Pages)
worker/worker.js, worker/wrangler.toml     -> el proxy (Cloudflare Workers)
juegos.json                                -> tu lista (la escribe el proxy)
```

## Puesta en marcha

### 1. Repositorio y página
1. Crea un repositorio **público** en GitHub llamado `lista-steam` y sube todo este contenido.
2. En el repositorio: **Settings → Pages → Deploy from a branch → main / (root)**.
3. Tu página quedará en `https://TU-USUARIO.github.io/lista-steam/`.

### 2. Claves que vas a necesitar
- **API key de IsThereAnyDeal:** registra una app en https://isthereanydeal.com/apps/
- **Token de GitHub (fine-grained):** Settings → Developer settings → Personal access tokens → Fine-grained tokens. Elige **solo este repositorio** y el permiso **Contents: Read and write**.
- **Una contraseña tuya** para poder agregar y quitar juegos.

### 3. Desplegar el proxy
```bash
cd worker
# 1) edita wrangler.toml: GITHUB_REPO y ALLOWED_ORIGIN con tu usuario
npx wrangler login
npx wrangler secret put ITAD_KEY
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put APP_PASSWORD
npx wrangler deploy
```
`wrangler deploy` te muestra la URL del Worker (algo como `https://lista-steam.usuario.workers.dev`).

### 4. Conectar la página con el proxy
Edita `config.js`, pon esa URL en `WORKER_URL`, y sube el cambio a GitHub.

## Uso
- **+ Añadir juego:** escribe el nombre, marca uno o varios resultados y pulsa «Agregar seleccionados». La primera vez te pide la contraseña (se guarda en ese navegador).
- Si el nombre tiene errores, aparece «¿Quisiste decir…?» con los juegos parecidos.
- **↻** actualiza los precios de un juego y **✕** lo quita.
- Clic en el encabezado de una columna para ordenar.

## Puntos que hay que probar la primera vez
Estas partes dependen de servicios externos y no pude probarlas contra los servicios reales:
1. **Moneda:** si IsThereAnyDeal no entrega COP, el proxy convierte desde su moneda y marca el valor con «≈».
2. **Historial de IsThereAnyDeal:** el endpoint `games/history/v2` y la forma de su respuesta están tomados de su documentación. Si el mínimo histórico sale vacío («—»), revisa esa función (`historial` en `worker.js`).
3. **Corrección de nombres:** con textos muy distintos al nombre real puede no sugerir nada; se ajusta en la función `buscar`.
4. **Límite:** máximo 6 juegos por envío (límite de subconsultas del plan gratuito).

## Seguridad
- El repositorio público deja la lista visible; las claves viven solo como secretos del Worker.
- Solo quien tenga la contraseña puede modificar la lista.
- El Worker solo acepta peticiones desde el origen indicado en `ALLOWED_ORIGIN` para el navegador.
