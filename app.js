const { WORKER_URL } = window.CONFIG;
const $ = (s) => document.querySelector(s);
const cop = new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 });

let juegos = [];
let orden = { col: "nombre", dir: 1 };
let seleccion = new Map(); // appid -> nombre
let busquedaId = 0;
let temporizador;

const COLUMNAS = [
  { k: "portada", t: "Portada" },
  { k: "nombre", t: "Juego", ord: true },
  { k: "precioBaseCOP", t: "Precio base (COP)", ord: true },
  { k: "minimoHistoricoCOP", t: "Mínimo histórico (COP)", ord: true },
  { k: "cuandoComprar", t: "Cuándo conviene comprar", ord: true },
  { k: "acciones", t: "" },
];

/* ---------- Utilidades ---------- */
function el(tag, props = {}, ...hijos) {
  const { dataset, ...resto } = props;
  const e = Object.assign(document.createElement(tag), resto);
  if (dataset) Object.assign(e.dataset, dataset);
  e.append(...hijos.filter((h) => h != null));
  return e;
}

let tt;
function aviso(texto) {
  const t = $("#toast");
  t.textContent = texto;
  t.classList.add("ver");
  clearTimeout(tt);
  tt = setTimeout(() => t.classList.remove("ver"), 3800);
}

function clave() {
  let c = localStorage.getItem("clave");
  if (!c) {
    c = prompt("Contraseña para modificar la lista:");
    if (c) localStorage.setItem("clave", c);
  }
  if (!c) throw new Error("Se necesita la contraseña");
  return c;
}

async function api(ruta, { method = "GET", body, auth = false } = {}) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (auth) headers["X-Password"] = clave();
  const r = await fetch(WORKER_URL + ruta, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) {
    localStorage.removeItem("clave");
    throw new Error("Contraseña incorrecta");
  }
  if (!r.ok) throw new Error(data.error || `Error ${r.status}`);
  return data;
}

/* ---------- Tabla ---------- */
function pintarEncabezado() {
  const tr = $("#encabezado");
  tr.replaceChildren(
    ...COLUMNAS.map((c) => {
      const flecha = orden.col === c.k ? (orden.dir === 1 ? " ▲" : " ▼") : "";
      const th = el("th", { textContent: c.t + flecha, className: c.ord ? "ordenable" : "" });
      if (c.ord) th.onclick = () => { orden = { col: c.k, dir: orden.col === c.k ? -orden.dir : 1 }; pintar(); };
      return th;
    })
  );
}

function pintar() {
  pintarEncabezado();
  const { col, dir } = orden;
  const lista = [...juegos].sort((a, b) => {
    const x = a[col], y = b[col];
    if (x == null) return 1;
    if (y == null) return -1;
    return (typeof x === "string" ? x.localeCompare(y, "es") : x - y) * dir;
  });

  $("#cuerpo").replaceChildren(
    ...lista.map((j) => {
      const base = el("td", { className: "precio", dataset: { label: "Precio base (COP)" } }, cop.format(j.precioBaseCOP));
      if (j.descuento > 0) base.append(el("span", { className: "nota oferta", textContent: `Ahora ${cop.format(j.precioActualCOP)} (-${j.descuento}%)` }));

      const min = el("td", { className: "precio", dataset: { label: "Mínimo histórico (COP)" } });
      if (j.minimoHistoricoCOP == null) min.textContent = "—";
      else {
        min.append((j.minimoAproximado ? "≈ " : "") + cop.format(j.minimoHistoricoCOP));
        if (j.minimoFecha) min.append(el("span", { className: "nota", textContent: new Date(j.minimoFecha + "T00:00:00").toLocaleDateString("es-CO", { month: "short", year: "numeric" }) }));
      }

      const img = el("img", { src: j.portada, alt: `Portada de ${j.nombre}`, loading: "lazy" });
      return el("tr", {},
        el("td", { className: "portada" }, img),
        el("td", { className: "nombre", dataset: { label: "Juego" }, textContent: j.nombre }),
        base,
        min,
        el("td", { className: "cuando", dataset: { label: "Cuándo conviene comprar" }, textContent: j.cuandoComprar || "—" }),
        el("td", { className: "acciones" },
          el("button", { className: "icono", title: "Actualizar precios", textContent: "↻", onclick: () => actualizar(j) }),
          el("button", { className: "icono", title: "Quitar de la lista", textContent: "✕", onclick: () => quitar(j) }))
      );
    })
  );

  $("#vacio").hidden = juegos.length > 0;
  $("#resumen").textContent = juegos.length === 1 ? "1 juego en la lista" : `${juegos.length} juegos en la lista`;
}

async function cargar() {
  try {
    juegos = await api("/games");
    pintar();
  } catch (e) {
    $("#resumen").textContent = "No pude cargar la lista: " + e.message;
  }
}

async function actualizar(j) {
  try {
    aviso(`Actualizando ${j.nombre}…`);
    juegos = (await api(`/games/${j.appid}/refresh`, { method: "POST", auth: true })).lista;
    pintar();
    aviso("Precios actualizados");
  } catch (e) { aviso(e.message); }
}

async function quitar(j) {
  if (!confirm(`¿Quitar «${j.nombre}» de la lista?`)) return;
  try {
    juegos = (await api(`/games/${j.appid}`, { method: "DELETE", auth: true })).lista;
    pintar();
  } catch (e) { aviso(e.message); }
}

/* ---------- Modal: búsqueda y selección múltiple ---------- */
const modal = $("#modal");

function abrirModal() {
  seleccion.clear();
  $("#q").value = "";
  $("#resultados").replaceChildren();
  $("#estado").textContent = "Escribe al menos 2 letras.";
  actualizarContador();
  modal.showModal();
  $("#q").focus();
}

function actualizarContador() {
  const n = seleccion.size;
  $("#contador").textContent = n === 1 ? "1 seleccionado" : `${n} seleccionados`;
  $("#btnAgregar").disabled = n === 0;
}

function pintarResultados(d, q) {
  const enLista = new Set(juegos.map((j) => j.appid));
  const ul = $("#resultados");
  if (!d.resultados.length) {
    ul.replaceChildren();
    $("#estado").textContent = `No encontré nada parecido a «${q}». Prueba con otra escritura.`;
    return;
  }
  $("#estado").textContent = d.sugerido
    ? `No encontré «${q}» tal cual. ¿Quisiste decir alguno de estos?`
    : `${d.resultados.length} resultado(s). Marca los que quieras agregar.`;

  ul.replaceChildren(
    ...d.resultados.map((r) => {
      const ya = enLista.has(r.appid);
      const cb = el("input", { type: "checkbox", disabled: ya, checked: seleccion.has(r.appid) });
      cb.onchange = () => {
        cb.checked ? seleccion.set(r.appid, r.nombre) : seleccion.delete(r.appid);
        actualizarContador();
      };
      const precio = r.precio ? cop.format(r.precio) : "Gratis / sin precio";
      return el("li", {},
        el("label", { className: ya ? "ya" : "" },
          cb,
          el("img", { src: r.miniatura, alt: "", loading: "lazy" }),
          el("span", { className: "info" }, el("b", { textContent: r.nombre }), el("span", { className: "nota", textContent: ya ? "Ya está en tu lista" : precio }))
        )
      );
    })
  );
}

async function buscar(q) {
  const id = ++busquedaId;
  $("#estado").textContent = "Buscando…";
  try {
    const d = await api("/search?q=" + encodeURIComponent(q));
    if (id === busquedaId) pintarResultados(d, q);
  } catch (e) {
    if (id === busquedaId) $("#estado").textContent = "Error al buscar: " + e.message;
  }
}

$("#q").addEventListener("input", (e) => {
  clearTimeout(temporizador);
  const q = e.target.value.trim();
  if (q.length < 2) { $("#resultados").replaceChildren(); $("#estado").textContent = "Escribe al menos 2 letras."; return; }
  temporizador = setTimeout(() => buscar(q), 450);
});

$("#btnAgregar").onclick = async () => {
  const btn = $("#btnAgregar");
  btn.disabled = true;
  $("#estado").textContent = "Agregando y consultando precios…";
  try {
    const d = await api("/games", { method: "POST", auth: true, body: { appids: [...seleccion.keys()] } });
    juegos = d.lista;
    pintar();
    modal.close();
    const partes = [`${d.agregados.length} agregado(s)`];
    if (d.omitidos.length) partes.push(`${d.omitidos.length} ya estaba(n)`);
    if (d.errores.length) partes.push(`${d.errores.length} con error`);
    aviso(partes.join(" · "));
  } catch (e) {
    $("#estado").textContent = e.message;
    btn.disabled = seleccion.size === 0;
  }
};

$("#btnAbrir").onclick = abrirModal;
$("#btnCerrar").onclick = () => modal.close();

cargar();
