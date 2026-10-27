// Proxy gratuito (Cloudflare Workers) para la lista de juegos de Steam.
// Hace de puente entre la página (GitHub Pages) y Steam / IsThereAnyDeal / GitHub.
// Las claves viven aquí como secretos, nunca en la página pública.

const ITAD = "https://api.isthereanydeal.com";
const STEAM_SHOP = 61; // id de Steam en IsThereAnyDeal
const MAX_POR_ENVIO = 6; // el plan gratis limita las subconsultas por petición
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const ETIQUETAS = { 2: "Año Nuevo Lunar", 3: "rebajas de primavera", 6: "rebajas de verano", 7: "rebajas de verano", 11: "rebajas de otoño", 12: "rebajas de invierno" };

class HttpError extends Error {
  constructor(msg, status = 500) { super(msg); this.status = status; }
}

export default {
  async fetch(req, env) {
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Password",
      "Cache-Control": "no-store",
    };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });

    try {
      const url = new URL(req.url);
      const partes = url.pathname.split("/").filter(Boolean); // ["games","123","refresh"]
      let data;

      if (req.method === "GET" && partes[0] === "search") {
        data = await buscar(url.searchParams.get("q") || "");
      } else if (req.method === "GET" && partes[0] === "games") {
        data = (await leerJuegos(env)).lista;
      } else if (partes[0] === "games") {
        autenticar(req, env);
        if (req.method === "POST" && partes.length === 1) data = await agregar(env, await req.json());
        else if (req.method === "POST" && partes[2] === "refresh") data = await actualizar(env, Number(partes[1]));
        else if (req.method === "DELETE" && partes.length === 2) data = await eliminar(env, Number(partes[1]));
        else throw new HttpError("Ruta no encontrada", 404);
      } else {
        throw new HttpError("Ruta no encontrada", 404);
      }
      return json(data, 200, cors);
    } catch (e) {
      return json({ error: e.message }, e.status || 500, cors);
    }
  },
};

const json = (data, status, headers) =>
  new Response(JSON.stringify(data), { status, headers: { ...headers, "Content-Type": "application/json; charset=utf-8" } });

function autenticar(req, env) {
  if (!env.APP_PASSWORD || req.headers.get("X-Password") !== env.APP_PASSWORD) throw new HttpError("No autorizado", 401);
}

/* ---------- BÚSQUEDA CON CORRECCIÓN DE ERRORES ---------- */

const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

function lev(a, b) {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
const sim = (a, b) => 1 - lev(a, b) / Math.max(a.length, b.length, 1);

function puntaje(consulta, titulo) {
  const q = norm(consulta), t = norm(titulo);
  if (!q || !t) return 0;
  if (t.includes(q)) return 1;
  const tp = t.split(" ");
  const porPalabra = q.split(" ").reduce((s, w) => s + Math.max(...tp.map((x) => sim(w, x))), 0) / q.split(" ").length;
  return Math.max(sim(q, t), sim(q, t.slice(0, q.length)), porPalabra);
}

async function steamSearch(term) {
  const r = await fetch(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&l=spanish&cc=co`);
  if (!r.ok) return [];
  const d = await r.json();
  return (d.items || [])
    .filter((i) => i.type === "app")
    .map((i) => ({
      appid: i.id,
      nombre: i.name,
      miniatura: i.tiny_image,
      precio: i.price ? i.price.final / 100 : 0,
      moneda: i.price?.currency || null,
    }));
}

async function buscar(q) {
  q = q.trim();
  if (q.length < 2) return { resultados: [], sugerido: false };

  const exactos = await steamSearch(q);
  if (exactos.length) return { resultados: exactos, sugerido: false };

  // Sin resultados: probamos variantes del texto y ordenamos por parecido.
  const palabras = norm(q).split(" ");
  const variantes = new Set();
  for (const w of palabras) {
    if (w.length >= 3) variantes.add(w);
    if (w.length >= 4) variantes.add(w.slice(0, -1));
  }
  if (q.length > 3) variantes.add(q.slice(0, -1));
  variantes.delete(q);

  const listas = await Promise.all([...variantes].slice(0, 6).map((v) => steamSearch(v).catch(() => [])));
  const unicos = new Map();
  for (const l of listas) for (const j of l) unicos.set(j.appid, j);

  const resultados = [...unicos.values()]
    .map((j) => ({ ...j, p: puntaje(q, j.nombre) }))
    .filter((j) => j.p >= 0.5)
    .sort((a, b) => b.p - a.p)
    .slice(0, 10)
    .map(({ p, ...j }) => j);

  return { resultados, sugerido: true };
}

/* ---------- DATOS DEL JUEGO ---------- */

async function detallesSteam(appid) {
  const r = await fetch(`https://store.steampowered.com/api/appdetails?appids=${appid}&cc=co&l=spanish`);
  if (!r.ok) throw new Error("Steam no respondió");
  const d = (await r.json())[String(appid)];
  if (!d?.success) throw new Error(`Steam no tiene datos del juego ${appid}`);
  const x = d.data, p = x.price_overview;
  return {
    appid,
    nombre: x.name,
    portada: x.header_image,
    precioBaseCOP: p ? Math.round(p.initial / 100) : 0,
    precioActualCOP: p ? Math.round(p.final / 100) : 0,
    descuento: p?.discount_percent || 0,
  };
}

const tasas = new Map();
async function tasaCOP(moneda) {
  if (moneda === "COP") return 1;
  if (!tasas.has(moneda)) {
    try {
      const d = await (await fetch(`https://open.er-api.com/v6/latest/${moneda}`)).json();
      tasas.set(moneda, d.rates?.COP ?? null);
    } catch { tasas.set(moneda, null); }
  }
  return tasas.get(moneda);
}

// Historial de precios en Steam (IsThereAnyDeal), convertido a COP.
async function historial(env, appid) {
  if (!env.ITAD_KEY) return null;
  const opts = { headers: { "ITAD-API-Key": env.ITAD_KEY } };
  const l = await (await fetch(`${ITAD}/games/lookup/v1?appid=${appid}`, opts)).json();
  const id = l?.game?.id;
  if (!id) return null;
  // Por defecto la API solo devuelve los últimos 3 meses, por eso se pide desde el año 2000.
  const h = await (await fetch(`${ITAD}/games/history/v2?id=${id}&country=CO&shops=${STEAM_SHOP}&since=2000-01-01T00:00:00Z`, opts)).json();
  if (!Array.isArray(h)) return null;

  const crudos = h
    .filter((e) => !e.shop || e.shop.id === STEAM_SHOP)
    .map((e) => ({ fecha: new Date(e.timestamp), precio: e.deal?.price?.amount, moneda: e.deal?.price?.currency, cut: e.deal?.cut || 0 }))
    .filter((e) => e.precio != null && !isNaN(e.fecha));
  if (!crudos.length) return null;

  let aproximado = false;
  const eventos = [];
  for (const e of crudos) {
    const t = await tasaCOP(e.moneda);
    if (t == null) return null;
    if (t !== 1) aproximado = true;
    eventos.push({ ...e, precio: Math.round(e.precio * t) });
  }
  return { eventos, aproximado };
}

function predecir(eventos, minimo, precioActual, descuentoActual) {
  const conOferta = eventos.filter((e) => e.cut > 0);
  if (!conOferta.length) return "Sin ofertas registradas todavía";
  if (descuentoActual > 0 && precioActual <= minimo * 1.1) return "Comprar ya: está en su mínimo histórico o muy cerca";

  const cerca = conOferta.filter((e) => e.precio <= minimo * 1.25);
  const base = cerca.length >= 2 ? cerca : conOferta;
  const porMes = new Map(); // mes -> Set de años
  for (const e of base) {
    const m = e.fecha.getUTCMonth() + 1;
    if (!porMes.has(m)) porMes.set(m, new Set());
    porMes.get(m).add(e.fecha.getUTCFullYear());
  }
  const [mes, anios] = [...porMes.entries()].sort((a, b) => b[1].size - a[1].size)[0];
  const totalAnios = new Set(base.map((e) => e.fecha.getUTCFullYear())).size;
  const et = ETIQUETAS[mes] ? ` (${ETIQUETAS[mes]})` : "";
  return `Probable en ${MESES[mes - 1]}${et} · hubo ofertas ese mes en ${anios.size} de ${totalAnios} años`;
}

async function construirJuego(env, appid, previo = {}) {
  const s = await detallesSteam(appid);
  let minimoHistoricoCOP = null, minimoFecha = null, minimoAproximado = false, cuandoComprar = "Sin datos de historial";
  try {
    const h = await historial(env, appid);
    if (h) {
      const min = h.eventos.reduce((a, b) => (b.precio < a.precio ? b : a));
      minimoHistoricoCOP = Math.min(min.precio, s.precioActualCOP || min.precio);
      minimoFecha = min.fecha.toISOString().slice(0, 10);
      minimoAproximado = h.aproximado;
      cuandoComprar = predecir(h.eventos, minimoHistoricoCOP, s.precioActualCOP, s.descuento);
    }
  } catch { /* RNF-07: el juego se guarda igual, con "sin dato" */ }
  const ahora = new Date().toISOString();
  return { ...s, minimoHistoricoCOP, minimoFecha, minimoAproximado, cuandoComprar, agregado: previo.agregado || ahora, actualizado: ahora };
}

/* ---------- GUARDADO EN GITHUB (juegos.json) ---------- */

const b64enc = (s) => { const b = new TextEncoder().encode(s); let t = ""; b.forEach((c) => (t += String.fromCharCode(c))); return btoa(t); };
const b64dec = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, "")), (c) => c.charCodeAt(0)));

function ghFetch(env, method, body) {
  const base = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${env.DATA_PATH || "juegos.json"}`;
  return fetch(method === "GET" ? `${base}?ref=${env.BRANCH || "main"}` : base, {
    method,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "lista-steam-worker",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// Texto del error que devuelve GitHub (ayuda a saber qué falló).
async function motivo(r) {
  try { return (await r.json()).message || "sin detalle"; } catch { return "sin detalle"; }
}

async function leerJuegos(env) {
  const r = await ghFetch(env, "GET");
  if (r.status === 404) return { lista: [], sha: null };
  if (!r.ok) throw new HttpError(`GitHub respondió ${r.status}: ${await motivo(r)} (revisa token y repositorio)`, 502);
  const d = await r.json();
  return { lista: JSON.parse(b64dec(d.content) || "[]"), sha: d.sha };
}

// Aplica un cambio a la lista y lo guarda; si hubo un guardado en medio (409) reintenta una vez.
async function modificar(env, mensaje, cambio) {
  for (let intento = 0; intento < 2; intento++) {
    const { lista, sha } = await leerJuegos(env);
    const nueva = await cambio(lista);
    const r = await ghFetch(env, "PUT", { message: mensaje, content: b64enc(JSON.stringify(nueva.lista, null, 2) + "\n"), sha: sha || undefined, branch: env.BRANCH || "main" });
    if (r.ok) return nueva;
    if (r.status !== 409 && r.status !== 422) throw new HttpError(`No pude guardar en GitHub (${r.status}: ${await motivo(r)})`, 502);
  }
  throw new HttpError("Conflicto al guardar, intenta de nuevo", 409);
}

/* ---------- ACCIONES ---------- */

async function agregar(env, body) {
  const ids = [...new Set((body?.appids || []).map(Number).filter(Number.isInteger))];
  if (!ids.length) throw new HttpError("No se envió ningún juego", 400);
  if (ids.length > MAX_POR_ENVIO) throw new HttpError(`Agrega máximo ${MAX_POR_ENVIO} juegos por vez`, 400);

  const res = await modificar(env, `Agregar ${ids.length} juego(s)`, async (lista) => {
    const existentes = new Set(lista.map((j) => j.appid));
    const omitidos = ids.filter((i) => existentes.has(i));
    const nuevos = ids.filter((i) => !existentes.has(i));
    const r = await Promise.allSettled(nuevos.map((i) => construirJuego(env, i)));
    const agregados = r.filter((x) => x.status === "fulfilled").map((x) => x.value);
    const errores = r.map((x, k) => (x.status === "rejected" ? { appid: nuevos[k], error: x.reason.message } : null)).filter(Boolean);
    return { lista: [...lista, ...agregados], agregados, omitidos, errores };
  });
  return { lista: res.lista, agregados: res.agregados, omitidos: res.omitidos, errores: res.errores };
}

async function actualizar(env, appid) {
  const res = await modificar(env, `Actualizar precios ${appid}`, async (lista) => {
    const i = lista.findIndex((j) => j.appid === appid);
    if (i < 0) throw new HttpError("Ese juego no está en la lista", 404);
    const copia = [...lista];
    copia[i] = await construirJuego(env, appid, lista[i]);
    return { lista: copia };
  });
  return { lista: res.lista };
}

async function eliminar(env, appid) {
  const res = await modificar(env, `Quitar juego ${appid}`, async (lista) => ({ lista: lista.filter((j) => j.appid !== appid) }));
  return { lista: res.lista };
}
