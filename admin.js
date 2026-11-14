"use strict";
(function () {
  const KEY = "tienda-admin-v1";
  const $ = (s) => document.querySelector(s);
  const T = window.Theme;
  const DEFAULT_SITE = {
    storeName: "Mi tienda", logo: "", brandMode: "name", heroTitle: "Belleza que se nota",
    heroSubtitle: "Productos seleccionados, con disponibilidad actualizada.", whatsapp: "", currency: "COP", locale: "es-CO",
    hideSoldOut: false, theme: { mode: "auto" }, font: "clasica",
    orderGreeting: "Hola, quiero hacer este pedido:",
    announcement: { text: "", link: "" }, banners: [],
    about: { title: "", text: "", image: "" }, social: {},
  };
  const state = {
    repo: "", token: "", branch: "main",
    products: [], config: null, catalog: { categories: [], products: [] }, site: { ...DEFAULT_SITE },
    tab: "mine", dlg: null,
    draft: null, logoFile: null, logoUrl: "", aboutFile: null, aboutUrl: "", vaultExists: false,
  };

  /* ---------- utilidades ---------- */
  const store = {
    get() {
      for (const name of ["localStorage", "sessionStorage"]) {
        try { const v = JSON.parse(window[name].getItem(KEY) || "null"); if (v && v.token) return v; } catch { /* sin acceso */ }
      }
      return null;
    },
    set(v, remember) {
      this.clear();
      try { (remember ? localStorage : sessionStorage).setItem(KEY, JSON.stringify(v)); } catch { /* sin almacenamiento */ }
    },
    clear() { for (const name of ["localStorage", "sessionStorage"]) { try { window[name].removeItem(KEY); } catch { /* nada */ } } },
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const money = (n) => (n === null || n === undefined || n === "" ? "—" :
    new Intl.NumberFormat(state.site.locale || "es-CO", { style: "currency", currency: state.site.currency || "COP", maximumFractionDigits: 0 }).format(n));

  function say(msg, kind) {
    const el = $("#status");
    el.textContent = msg || "";
    el.className = "status" + (kind ? " " + kind : "");
  }
  const show = (el, on) => { el.hidden = !on; };
  const showErr = (id, msg) => { const el = $(id); el.textContent = msg; show(el, true); };

  const toB64 = (bytes) => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
  const fromB64 = (b64) => Uint8Array.from(atob(b64.replace(/\s/g, "")), (c) => c.charCodeAt(0));
  const encodeText = (t) => toB64(new TextEncoder().encode(t));
  const decodeText = (b64) => new TextDecoder().decode(fromB64(b64));

  /* ---------- usuario y contraseña (token cifrado) ---------- */
  const ITER = 600000;
  async function deriveKey(user, pass, salt, iter) {
    const enc = new TextEncoder();
    const base = await crypto.subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveKey"]);
    const extra = enc.encode(":" + user.trim().toLowerCase());
    const s = new Uint8Array(salt.length + extra.length); s.set(salt); s.set(extra, salt.length);
    return crypto.subtle.deriveKey({ name: "PBKDF2", salt: s, iterations: iter, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  async function makeVault(user, pass, secret) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(user, pass, salt, ITER);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(secret))));
    return { v: 1, kdf: "PBKDF2-SHA256", iter: ITER, salt: toB64(salt), iv: toB64(iv), data: toB64(ct) };
  }
  async function openVault(vault, user, pass) {
    try {
      const key = await deriveKey(user, pass, fromB64(vault.salt), vault.iter || ITER);
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(vault.iv) }, key, fromB64(vault.data));
      return JSON.parse(new TextDecoder().decode(pt));
    } catch { return null; }
  }
  async function fetchVault() {
    try {
      const r = await fetch("admin-vault.json?t=" + Date.now(), { cache: "no-store" });
      if (!r.ok) return null;
      const j = await r.json();
      return j && j.v === 1 && j.data ? j : null;
    } catch { return null; }
  }
  function passProblem(user, pass, pass2) {
    if (user.trim().length < 3) return "El usuario debe tener al menos 3 caracteres.";
    if (pass.length < 10) return "La contraseña debe tener al menos 10 caracteres. Una frase sirve bien, por ejemplo: mi tienda vende cejas lindas.";
    if (/^\d+$/.test(pass) || new Set(pass).size < 5) return "Esa contraseña es muy fácil de adivinar. Usa una frase más larga.";
    if (norm(pass).includes(norm(user.trim())) && user.trim().length >= 4) return "La contraseña no debe contener tu usuario.";
    if (pass !== pass2) return "Las dos contraseñas no coinciden.";
    return "";
  }

  /* ---------- GitHub ---------- */
  class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

  function friendly(status) {
    if (status === 401) return "El token no es válido o ya venció. Cierra sesión y entra con un token nuevo.";
    if (status === 403) return "El token no tiene permiso para esto. Revisa que tenga Contents y Actions en \"Read and write\".";
    if (status === 404) return "No encontré el repositorio o el archivo. Revisa que el nombre sea usuario/repositorio y que el token incluya ese repositorio.";
    if (status === 409 || status === 422) return "Alguien más cambió el archivo al mismo tiempo. Intenta de nuevo.";
    return "No pude conectar con GitHub. Revisa tu conexión e intenta de nuevo.";
  }

  async function gh(path, opts = {}) {
    let res;
    try {
      res = await fetch(`https://api.github.com/repos/${state.repo}${path ? "/" + path : ""}`, {
        cache: "no-store",
        ...opts,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${state.token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          ...(opts.headers || {}),
        },
      });
    } catch { throw new ApiError(0, friendly(0)); }
    return res;
  }

  async function readJson(p) {
    const r = await gh(`contents/${p}?ref=${encodeURIComponent(state.branch)}`);
    if (r.status === 404) return { data: null, sha: null };
    if (!r.ok) throw new ApiError(r.status, friendly(r.status));
    const j = await r.json();
    let text;
    if (j.content) text = decodeText(j.content);
    else {
      const raw = await gh(`contents/${p}?ref=${encodeURIComponent(state.branch)}`, { headers: { Accept: "application/vnd.github.raw+json" } });
      if (!raw.ok) throw new ApiError(raw.status, friendly(raw.status));
      text = await raw.text();
    }
    return { data: JSON.parse(text), sha: j.sha };
  }

  async function putFile(p, b64, sha, message) {
    return gh(`contents/${p}`, {
      method: "PUT",
      body: JSON.stringify({ message, content: b64, branch: state.branch, ...(sha ? { sha } : {}) }),
    });
  }

  // Lee el archivo, aplica el cambio y lo guarda. Si el robot guardó justo antes, reintenta con lo más nuevo.
  async function updateJson(p, mutate, message) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const { data, sha } = await readJson(p);
      const next = mutate(data === null ? null : structuredClone(data));
      const r = await putFile(p, encodeText(JSON.stringify(next, null, 2) + "\n"), sha, message);
      if (r.ok) return next;
      if (r.status !== 409 && r.status !== 422) throw new ApiError(r.status, friendly(r.status));
    }
    throw new ApiError(409, friendly(409));
  }

  async function resizeToB64(file, { max = 900, type = "image/jpeg" } = {}) {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    return c.toDataURL(type, 0.85).split(",")[1];
  }

  async function uploadImage(file, opts = {}) {
    const type = opts.type || "image/jpeg";
    const b64 = await resizeToB64(file, { max: opts.max || 900, type });
    const p = `img/${opts.prefix || ""}${Date.now()}.${type === "image/png" ? "png" : "jpg"}`;
    const r = await putFile(p, b64, null, opts.message || "Subir imagen");
    if (!r.ok) throw new ApiError(r.status, friendly(r.status));
    return p;
  }

  async function loadAll() {
    const repo = await gh("");
    if (!repo.ok) throw new ApiError(repo.status, friendly(repo.status));
    state.branch = (await repo.json()).default_branch || "main";

    const [prods, cfg, site] = await Promise.all([readJson("products.json"), readJson("sync/sync.config.json"), readJson("site.json")]);
    state.products = prods.data?.products || [];
    state.config = cfg.data || { categories: [], soldOutWhenQuantityAtOrBelow: 0 };
    state.config.categories = state.config.categories || [];
    state.site = { ...DEFAULT_SITE, ...(site.data || {}) };
    state.draft = null;

    const cat = await gh(`contents/data/supplier-catalog.json?ref=${encodeURIComponent(state.branch)}`, { headers: { Accept: "application/vnd.github.raw+json" } });
    state.catalog = cat.ok ? await cat.json() : { categories: [], products: [] };
  }

  /* ---------- reglas ---------- */
  function availability(item) {
    const t = state.config?.soldOutWhenQuantityAtOrBelow;
    if (item.deleted) return { ok: false, why: "eliminado en el proveedor" };
    if (item.inactive) return { ok: false, why: "desactivado en el proveedor" };
    if (t !== null && t !== undefined && item.quantity !== null && item.quantity <= t) return { ok: false, why: `cantidad ${item.quantity}` };
    return { ok: true, why: "disponible" };
  }
  const categoryLabel = (id) => {
    const fromCfg = state.config.categories.find((c) => String(c.id) === String(id));
    const fromCat = state.catalog.categories.find((c) => String(c.id) === String(id));
    return fromCfg?.name || fromCat?.name || `Categoría ${id}`;
  };

  // Misma regla que usa el robot y la tienda: se vende si el proveedor lo tiene o si tú tienes stock propio.
  const myStock = (p) => { const n = Math.floor(Number(p.stock)); return Number.isFinite(n) && n > 0 ? n : 0; };
  const supplierHas = (p) => !!p.supplierId && (p.supplierAvailable !== undefined ? p.supplierAvailable !== false : p.available !== false);
  const isAvailable = (p) => myStock(p) > 0 || supplierHas(p);
  function statusOf(p) {
    if (p.hidden) return { key: "hidden", cls: "warn", text: "Oculto" };
    if (!isAvailable(p)) return { key: "out", cls: "out", text: "Agotado" };
    if (p.supplierId && !supplierHas(p)) return { key: "own", cls: "ok", text: "A la venta con tu stock" };
    return { key: "sale", cls: "ok", text: "A la venta" };
  }
  const uniq = (arr) => [...new Set(arr.filter(Boolean))].sort((a, b) => a.localeCompare(b, "es"));
  // Si ya existe "Cuidado capilar", escribir "cuidado Capilar" usa la forma que ya existe, para no duplicar filtros.
  const canon = (v, list) => { v = String(v || "").trim().replace(/\s+/g, " "); const k = norm(v); return list.find((x) => norm(x) === k) || v; };
  function taxonomy() {
    const cats = new Map(), brands = new Set();
    for (const p of state.products) {
      if (p.category) { if (!cats.has(p.category)) cats.set(p.category, new Set()); if (p.subcategory) cats.get(p.category).add(p.subcategory); }
      if (p.brand) brands.add(p.brand);
    }
    return { cats, brands: uniq([...brands]) };
  }
  const subsFor = (cat) => { const t = taxonomy(); const k = norm(cat); for (const [c, subs] of t.cats) if (norm(c) === k) return uniq([...subs]); return []; };
  function guessBrand(name) {
    const n = " " + norm(name) + " ";
    return taxonomy().brands.filter((b) => norm(b).length >= 3 && n.includes(" " + norm(b) + " ")).sort((a, b) => b.length - a.length)[0] || "";
  }

  /* ---------- pestañas ---------- */
  const TABS = ["mine", "add", "cats", "look", "access"];
  function setTab(name) {
    state.tab = name;
    for (const t of TABS) {
      $("#tab-" + t).setAttribute("aria-selected", String(t === name));
      show($("#view-" + t), t === name);
    }
    render();
  }

  /* ---------- Mis productos ---------- */
  function thumb(src, name) {
    return `<div class="thumb">${src ? `<img src="${esc(src)}" alt="" loading="lazy">` : esc((name || "?").trim().charAt(0).toUpperCase())}</div>`;
  }

  const mine = { q: "", cat: "", brand: "", st: "", limit: 50, sel: new Set() };

  function filteredMine() {
    const q = norm(mine.q).trim();
    return state.products.filter((p) => {
      if (mine.cat && p.category !== mine.cat) return false;
      if (mine.brand && p.brand !== mine.brand) return false;
      if (q && !norm([p.name, p.brand, p.category, p.subcategory].join(" ")).includes(q)) return false;
      if (mine.st === "nocat") return !p.category || !p.brand;
      if (mine.st === "own") return myStock(p) > 0;
      if (mine.st === "promo") return Number(p.oldPrice) > Number(p.price);
      if (mine.st === "kit") return !!p.kit;
      if (mine.st === "nophoto") return !p.image;
      if (mine.st) return statusOf(p).key === mine.st || (mine.st === "sale" && statusOf(p).key === "own");
      return true;
    });
  }

  function rowHTML(p) {
    const st = statusOf(p);
    const n = myStock(p);
    const where = [p.category, p.subcategory].filter(Boolean).join(" › ");
    const note = p.supplierId ? (supplierHas(p) ? "" : '<span class="pill warn">El proveedor ya no lo tiene</span>') : '<span class="pill warn">Producto propio</span>';
    const tags = (Number(p.oldPrice) > Number(p.price) ? '<span class="pill ok">Promoción</span>' : "") + (p.kit ? '<span class="pill warn">Kit</span>' : "") + (p.image ? "" : '<span class="pill warn">Sin foto</span>');
    return `<div class="row mrow" data-row="${esc(p.id)}">
      <label class="pick"><input type="checkbox" data-pick="${esc(p.id)}" ${mine.sel.has(p.id) ? "checked" : ""} aria-label="Elegir ${esc(p.name)}"></label>
      ${thumb(p.image, p.name)}
      <div class="row-main">
        <div class="row-name">${esc(p.name)}</div>
        <div class="row-sub"><span>${money(p.price)}</span>${p.brand ? `<span>${esc(p.brand)}</span>` : ""}<span>${esc(where || "Sin categoría")}</span>
          <span class="pill ${st.cls}">${esc(st.text)}</span>${note}${tags}</div>
      </div>
      <div class="stock" role="group" aria-label="Tu stock de ${esc(p.name)}">
        <span class="stock-l">Tu stock</span>
        <button class="step" type="button" data-stock="${esc(p.id)}" data-d="-1" aria-label="Restar una unidad">−</button>
        <input class="stock-in" type="number" inputmode="numeric" min="0" step="1" value="${n}" data-stockin="${esc(p.id)}" aria-label="Unidades en stock de ${esc(p.name)}">
        <button class="step" type="button" data-stock="${esc(p.id)}" data-d="1" aria-label="Sumar una unidad">+</button>
      </div>
      <button class="btn btn-ghost" type="button" data-edit="${esc(p.id)}">Editar</button>
    </div>`;
  }

  function renderBulkBar(total) {
    const n = mine.sel.size;
    show($("#bulkbar"), n > 0);
    $("#bulk-n").textContent = n === 1 ? "1 producto elegido" : `${n} productos elegidos`;
    const all = $("#m-all");
    all.checked = total > 0 && n >= total && filteredMine().every((p) => mine.sel.has(p.id));
    $("#m-all-label").textContent = total ? `Seleccionar los ${total} que ves` : "Seleccionar todos";
  }

  function renderMine() {
    const list = state.products;
    const t = taxonomy();
    const fill = (sel, first, items, cur) => {
      sel.innerHTML = `<option value="">${first}</option>` + items.map((x) => `<option value="${esc(x)}">${esc(x)}</option>`).join("");
      sel.value = items.includes(cur) ? cur : "";
      return sel.value;
    };
    mine.cat = fill($("#m-cat"), "Todas", uniq([...t.cats.keys()]), mine.cat);
    mine.brand = fill($("#m-brand"), "Todas", t.brands, mine.brand);
    $("#m-state").value = mine.st;
    show($("#mine-tools"), list.length > 0);

    const out = list.filter((p) => statusOf(p).key === "out").length;
    const own = list.filter((p) => p.supplierId && !supplierHas(p) && myStock(p) > 0).length;
    const nophoto = list.filter((p) => !p.image).length;
    const found = filteredMine();
    const shown = found.slice(0, mine.limit);
    $("#mine-summary").textContent = list.length
      ? `${found.length === list.length ? list.length : found.length + " de " + list.length} producto${list.length === 1 ? "" : "s"} · ${out} agotado${out === 1 ? "" : "s"}` + (own ? ` · ${own} a la venta solo por tu stock` : "") + (nophoto ? ` · ${nophoto} sin foto` : "")
      : "";
    const filtering = list.length > 0 && found.length === 0;
    show($("#mine-empty"), found.length === 0);
    $("#mine-empty-title").textContent = filtering ? "Ningún producto coincide" : "Todavía no tienes productos";
    $("#mine-empty-text").textContent = filtering ? "Prueba con otra palabra o cambia los filtros." : "Elige productos del catálogo del proveedor o crea uno propio.";
    show($("#mine-empty-btn"), !filtering);
    $("#mine-list").innerHTML = shown.map(rowHTML).join("");
    show($("#mine-more"), found.length > shown.length);
    $("#mine-more-btn").textContent = `Ver más productos (${found.length - shown.length} restantes)`;
    renderBulkBar(found.length);
  }

  /* Stock en la lista: se guarda solo, un momento después del último toque. Los guardados van en fila para no pisarse. */
  const stockPending = new Map(), stockTimers = new Map();
  let stockChain = Promise.resolve();

  function refreshRow(id, focusSel) {
    const p = state.products.find((x) => x.id === id);
    const el = document.querySelector(`[data-row="${CSS.escape(id)}"]`);
    if (!p || !el) return;
    el.outerHTML = rowHTML(p);
    if (focusSel) document.querySelector(focusSel)?.focus();
    renderBulkBar(filteredMine().length);
  }

  function setStock(id, value, focusSel) {
    const p = state.products.find((x) => x.id === id);
    if (!p) return;
    const n = Math.max(0, Math.min(99999, Math.floor(Number(value)) || 0));
    p.stock = n; p.available = isAvailable(p);
    stockPending.set(id, n);
    clearTimeout(stockTimers.get(id));
    stockTimers.set(id, setTimeout(() => flushStock(id), 700));
    say("Guardando stock…");
    refreshRow(id, focusSel);
  }

  function flushStock(id) {
    if (!stockPending.has(id)) return;
    const n = stockPending.get(id); stockPending.delete(id);
    stockChain = stockChain.then(async () => {
      try {
        const next = await updateJson("products.json", (d) => {
          d.products = (d.products || []).map((p) => {
            if (p.id !== id) return p;
            const q = { ...p, stock: n };
            q.available = isAvailable(q);
            return q;
          });
          return d;
        }, "Cambiar stock");
        // lo que el robot cambió llega; lo que todavía no se guardó se conserva
        state.products = next.products.map((p) => {
          if (!stockPending.has(p.id)) return p;
          const q = { ...p, stock: stockPending.get(p.id) }; q.available = isAvailable(q); return q;
        });
        if (!stockPending.size) say("Stock guardado. La tienda lo muestra en uno o dos minutos.", "ok");
        if (state.tab === "mine" && !document.activeElement?.closest?.(".stock")) renderMine();
      } catch (err) { say(err.message || friendly(0), "bad"); }
    });
    return stockChain;
  }

  /* ---------- Agregar del proveedor ---------- */
  function renderAdd() {
    const cats = state.catalog.categories;
    const sel = $("#s-cat");
    const keep = sel.value;
    sel.innerHTML = '<option value="">Todas</option>' + cats.map((c) => `<option value="${esc(c.id)}">${esc(categoryLabel(c.id))}</option>`).join("");
    sel.value = [...sel.options].some((o) => o.value === keep) ? keep : "";

    const has = state.catalog.products.length > 0;
    show($("#add-empty"), !has);
    $("#add-list").innerHTML = "";
    $("#add-summary").textContent = "";
    if (!has) {
      const noCats = state.config.categories.length === 0;
      $("#add-empty-title").textContent = noCats ? "Primero agrega una categoría del proveedor" : "Todavía no hay catálogo del proveedor";
      $("#add-empty-text").textContent = noCats
        ? "Pega el link de una categoría del proveedor y pulsa \"Revisar proveedor ahora\"."
        : "Pulsa \"Revisar proveedor ahora\". En uno o dos minutos aparecen sus productos aquí; luego usa \"Recargar\".";
      return;
    }

    const q = norm($("#s-q").value).trim();
    const cat = sel.value;
    const mineIds = new Set(state.products.map((p) => String(p.supplierId)));
    const found = state.catalog.products.filter((p) => (!cat || p.category === cat) && (!q || norm(p.name).includes(q)));
    const shown = found.slice(0, 60);
    $("#add-summary").textContent = found.length
      ? `${found.length} producto${found.length === 1 ? "" : "s"}` + (found.length > shown.length ? `; se muestran los primeros ${shown.length}. Escribe para filtrar.` : ".")
      : "No hay productos con esa búsqueda. Prueba con otra palabra o elige \"Todas\" las categorías.";
    $("#add-list").innerHTML = shown.map((p) => {
      const a = availability(p);
      const mine = mineIds.has(p.id);
      return `<div class="row no-thumb">
        <div class="row-main">
          <div class="row-name">${esc(p.name)}</div>
          <div class="row-sub"><span>Proveedor: ${money(p.price)}</span><span>Cantidad: ${p.quantity ?? "—"}</span>
            <span class="pill ${a.ok ? "ok" : "out"}">${a.ok ? "Disponible" : "Agotado: " + esc(a.why)}</span></div>
        </div>
        ${mine ? '<button class="btn" type="button" disabled>Ya está en tu tienda</button>'
               : `<button class="btn" type="button" data-add="${esc(p.id)}">Agregar</button>`}
      </div>`;
    }).join("");
  }

  /* ---------- Categorías ---------- */
  function renderCats() {
    const cats = state.config.categories;
    $("#cats-list").innerHTML = cats.length ? cats.map((c) => {
      const snap = state.catalog.categories.find((s) => String(s.id) === String(c.id));
      const info = !snap ? "Aún no se ha leído"
        : snap.ok ? `${snap.count} productos` : `${snap.count} productos (la última lectura falló)`;
      return `<div class="row no-thumb">
        <div class="row-main"><div class="row-name">${esc(categoryLabel(c.id))}</div>
        <div class="row-sub"><span>Número ${esc(c.id)}</span><span>${info}</span></div></div>
        <button class="btn btn-ghost" type="button" data-rmcat="${esc(c.id)}">Quitar categoría</button>
      </div>`;
    }).join("") : '<p class="muted">Todavía no hay categorías. Agrega la primera abajo.</p>';
    $("#rule-qty").checked = state.config.soldOutWhenQuantityAtOrBelow !== null && state.config.soldOutWhenQuantityAtOrBelow !== undefined;
  }

  /* ---------- Anuncio y banners ---------- */
  const MAX_BANNERS = 8;
  const linkFromDest = (d) => {
    if (!d) return "";
    if (d.type === "cat" && d.c) return "#c=" + encodeURIComponent(d.c) + (d.s ? "&s=" + encodeURIComponent(d.s) : "");
    if (d.type === "brand" && d.b) return "#b=" + encodeURIComponent(d.b);
    if (d.type === "url") return String(d.url || "").trim();
    return "";
  };
  const destOf = (b) => {
    if (b.dest) return b.dest;
    const l = String(b.link || "");
    if (!l) return { type: "none" };
    return /^https?:\/\//i.test(l) ? { type: "url", url: l } : { type: "url", url: l };
  };

  function bannerHTML(b, i, n, t) {
    const d = destOf(b);
    const src = b._url || b.image;
    const opts = (items, cur, first) => `<option value="">${first}</option>` + items.map((x) => `<option value="${esc(x)}"${x === cur ? " selected" : ""}>${esc(x)}</option>`).join("");
    const cats = uniq([...t.cats.keys()]);
    const subs = d.type === "cat" && d.c ? uniq([...(t.cats.get(d.c) || [])]) : [];
    return `<div class="banner" data-bn="${i}">
      <div class="banner-head"><strong>Banner ${i + 1}</strong>
        <span class="spacer"></span>
        <button class="btn btn-ghost sm" type="button" data-bact="up" ${i === 0 ? "disabled" : ""} aria-label="Subir el banner ${i + 1}">↑</button>
        <button class="btn btn-ghost sm" type="button" data-bact="down" ${i === n - 1 ? "disabled" : ""} aria-label="Bajar el banner ${i + 1}">↓</button>
        <button class="btn btn-ghost sm" type="button" data-bact="rm" aria-label="Quitar el banner ${i + 1}">Quitar</button>
      </div>
      <div class="banner-img">${src ? `<img src="${esc(src)}" alt="">` : '<span class="muted">Sin imagen</span>'}</div>
      <label class="field"><span>Imagen (opcional)</span><input type="file" accept="image/*" data-bf="file"></label>
      ${src ? '<button class="btn btn-ghost sm" type="button" data-bact="rmimg">Quitar imagen</button>' : ""}
      <label class="field"><span>Título</span><input data-bf="title" value="${esc(b.title || "")}" autocomplete="off"></label>
      <label class="field"><span>Texto debajo (opcional)</span><input data-bf="subtitle" value="${esc(b.subtitle || "")}" autocomplete="off"></label>
      <label class="field"><span>Texto del botón</span><input data-bf="buttonText" value="${esc(b.buttonText || "")}" placeholder="Ver más" autocomplete="off"></label>
      <label class="field"><span>Al tocar el banner lleva a</span>
        <select data-bf="dtype">
          <option value="none"${d.type === "none" ? " selected" : ""}>Nada (solo se ve)</option>
          <option value="cat"${d.type === "cat" ? " selected" : ""}>Una categoría de tu tienda</option>
          <option value="brand"${d.type === "brand" ? " selected" : ""}>Una marca de tu tienda</option>
          <option value="url"${d.type === "url" ? " selected" : ""}>Otra página (link)</option>
        </select></label>
      ${d.type === "cat" ? `<div class="two"><label class="field"><span>Categoría</span><select data-bf="dc">${opts(cats, d.c, "Elige una categoría")}</select></label>
        <label class="field"><span>Subcategoría (opcional)</span><select data-bf="ds">${opts(subs, d.s, "Todas")}</select></label></div>` : ""}
      ${d.type === "brand" ? `<label class="field"><span>Marca</span><select data-bf="db">${opts(t.brands, d.b, "Elige una marca")}</select></label>` : ""}
      ${d.type === "url" ? `<label class="field"><span>Link</span><input data-bf="durl" value="${esc(d.url || "")}" placeholder="https://" spellcheck="false" autocomplete="off"></label>` : ""}
    </div>`;
  }

  function renderBanners() {
    const list = state.draft.banners;
    const t = taxonomy();
    $("#banners").innerHTML = list.map((b, i) => bannerHTML(b, i, list.length, t)).join("");
    $("#banner-add").disabled = list.length >= MAX_BANNERS;
    $("#banner-add").textContent = list.length >= MAX_BANNERS ? `Máximo ${MAX_BANNERS} banners` : "Agregar banner";
  }

  function bindBanners() {
    const host = $("#banners");
    const target = (e) => { const c = e.target.closest("[data-bn]"); return c ? { i: Number(c.dataset.bn), b: state.draft.banners[Number(c.dataset.bn)] } : null; };
    const dropUrl = (b) => { if (b._url) { URL.revokeObjectURL(b._url); delete b._url; } };
    host.addEventListener("input", (e) => {
      const t = target(e); const k = e.target.dataset.bf;
      if (!t || !k || e.target.type === "file" || e.target.tagName === "SELECT") return;
      if (k === "durl") { t.b.dest = { type: "url", url: e.target.value }; t.b.link = linkFromDest(t.b.dest); }
      else t.b[k] = e.target.value;
      show($("#banners-error"), false); renderPreview();
    });
    host.addEventListener("change", (e) => {
      const t = target(e); const k = e.target.dataset.bf;
      if (!t || !k) return;
      const d = { ...destOf(t.b) };
      if (k === "file") {
        const file = e.target.files[0]; if (!file) return;
        dropUrl(t.b); t.b._file = file; t.b._url = URL.createObjectURL(file);
        renderBanners(); renderPreview(); return;
      }
      if (k === "dtype") t.b.dest = { type: e.target.value };
      else if (k === "dc") t.b.dest = { type: "cat", c: e.target.value };
      else if (k === "ds") t.b.dest = { type: "cat", c: d.c, s: e.target.value };
      else if (k === "db") t.b.dest = { type: "brand", b: e.target.value };
      else return;
      t.b.link = linkFromDest(t.b.dest);
      renderBanners(); renderPreview();
    });
    host.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-bact]"); const t = target(e);
      if (!btn || !t) return;
      const list = state.draft.banners, a = btn.dataset.bact;
      if (a === "rm") { dropUrl(t.b); list.splice(t.i, 1); }
      else if (a === "rmimg") { dropUrl(t.b); delete t.b._file; t.b.image = ""; }
      else if (a === "up" && t.i > 0) [list[t.i - 1], list[t.i]] = [list[t.i], list[t.i - 1]];
      else if (a === "down" && t.i < list.length - 1) [list[t.i + 1], list[t.i]] = [list[t.i], list[t.i + 1]];
      renderBanners(); renderPreview();
    });
    $("#banner-add").addEventListener("click", () => {
      if (state.draft.banners.length >= MAX_BANNERS) return;
      state.draft.banners.push({ image: "", title: "", subtitle: "", buttonText: "", link: "", dest: { type: "none" } });
      renderBanners(); host.querySelector(`[data-bn="${state.draft.banners.length - 1}"] [data-bf="title"]`)?.focus();
    });
    $("#l-about-title").addEventListener("input", (e) => { state.draft.about.title = e.target.value; });
    $("#l-about-text").addEventListener("input", (e) => { state.draft.about.text = e.target.value; });
    for (const k of SOCIALS) $("#l-" + k).addEventListener("input", (e) => { state.draft.social[k] = e.target.value; show($("#e-" + k), false); });
    $("#l-about-file").addEventListener("change", (e) => {
      const file = e.target.files[0]; if (!file) return;
      if (state.aboutUrl) URL.revokeObjectURL(state.aboutUrl);
      state.aboutFile = file; state.aboutUrl = URL.createObjectURL(file); syncLookInputs();
    });
    $("#l-about-rm").addEventListener("click", () => {
      if (state.aboutUrl) URL.revokeObjectURL(state.aboutUrl);
      state.aboutFile = null; state.aboutUrl = ""; state.draft.about.image = ""; $("#l-about-file").value = ""; syncLookInputs();
    });
    $("#l-ann").addEventListener("input", (e) => { state.draft.announcement.text = e.target.value; renderPreview(); });
    $("#l-ann-link").addEventListener("input", (e) => { state.draft.announcement.link = e.target.value; show($("#e-annlink"), false); });
  }

  const SOCIALS = ["instagram", "facebook", "tiktok", "youtube"];
  const SOCIAL_BASE = { instagram: "https://instagram.com/", facebook: "https://facebook.com/", tiktok: "https://tiktok.com/@", youtube: "https://youtube.com/@" };
  // "@mitienda" o "mitienda" -> link completo; un link https se deja igual; otra cosa es un error.
  function normSocial(key, v) {
    v = String(v || "").trim();
    if (!v) return "";
    if (/^https?:\/\/\S+$/i.test(v)) return v;
    const u = v.replace(/^@/, "");
    return /^[\w.\-]{2,40}$/.test(u) ? SOCIAL_BASE[key] + u : null;
  }
  const okLink = (l) => !l || /^https?:\/\/\S+$/i.test(l) || l.startsWith("#");

  /* ---------- Apariencia ---------- */
  let lookBuilt = false;
  const DEFAULT_COLORS = T.PALETTES[0];

  function buildLookUI() {
    if (lookBuilt) return;
    lookBuilt = true;
    $("#pals").innerHTML =
      `<button type="button" class="pal" data-pal="auto" aria-pressed="false">
         <span class="swatches"><span style="background:#faf6f2"></span><span style="background:#141414"></span></span>
         <span>Automática<br><small>Clara u oscura según el dispositivo</small></span></button>` +
      T.PALETTES.map((p) => `<button type="button" class="pal" data-pal="${p.key}" aria-pressed="false">
         <span class="swatches"><span style="background:${p.background}"></span><span style="background:${p.accent}"></span><span style="background:${p.text}"></span></span>
         <span>${esc(p.name)}</span></button>`).join("");
    $("#fonts").innerHTML = T.FONTS.map((f) => `<button type="button" class="font" data-font="${f.key}" aria-pressed="false">
         <span class="f-name">${esc(f.name)}</span><span class="f-sample" style="font-family:${f.head}">Belleza que se nota</span></button>`).join("");
    T.loadFonts(T.FONTS.map((f) => f.key));
  }

  function themeColors(d) {
    const t = d.theme || {};
    return t.mode === "custom" ? t : DEFAULT_COLORS;
  }

  function syncLookInputs() {
    const d = state.draft;
    $("#l-name").value = d.storeName || "";
    $("#l-hero").value = d.heroTitle || "";
    $("#l-sub").value = d.heroSubtitle || "";
    $("#l-wa").value = d.whatsapp || "";
    $("#l-greet").value = d.orderGreeting || "";
    $("#l-ann").value = d.announcement?.text || "";
    $("#l-about-title").value = d.about?.title || "";
    $("#l-about-text").value = d.about?.text || "";
    for (const k of SOCIALS) $("#l-" + k).value = d.social?.[k] || "";
    const aSrc = state.aboutUrl || d.about?.image || "";
    $("#l-about-img").hidden = !aSrc; if (aSrc) $("#l-about-img").src = aSrc;
    show($("#l-about-rm"), !!aSrc);
    $("#l-ann-link").value = d.announcement?.link || "";
    $("#l-hide").checked = !!d.hideSoldOut;
    document.querySelectorAll('input[name="brandMode"]').forEach((r) => { r.checked = r.value === (d.brandMode || "name"); });
    const c = themeColors(d);
    $("#c-accent").value = c.accent; $("#c-bg").value = c.background; $("#c-text").value = c.text;
    document.querySelectorAll(".pal").forEach((b) => {
      const k = b.dataset.pal;
      b.setAttribute("aria-pressed", String(k === "auto" ? (d.theme?.mode || "auto") === "auto" : d.theme?.mode === "custom" && d.theme.preset === k));
    });
    document.querySelectorAll(".font").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.font === (d.font || "clasica"))));
    const logoSrc = state.logoUrl || d.logo;
    const img = $("#l-logo-img");
    img.hidden = !logoSrc; if (logoSrc) img.src = logoSrc;
    show($("#l-logo-remove"), !!logoSrc);
  }

  function renderPreview() {
    const d = state.draft;
    const el = $("#preview");
    T.apply(d, el);
    const logoSrc = state.logoUrl || d.logo;
    const card = (name, price, out) => `<article class="card${out ? " out" : ""}">
      <div class="media"><span class="ph" aria-hidden="true">${esc(name[0])}</span>${out ? '<span class="badge">Agotado</span>' : ""}</div>
      <div class="body"><span class="cat">Cejas</span><h4 class="name">${esc(name)}</h4><span class="price">${money(price)}</span></div>
      <div class="actions">${out ? '<span class="btn" aria-disabled="true">No disponible por ahora</span>' : '<span class="btn">Pedir por WhatsApp</span>'}</div></article>`;
    const ann = String(d.announcement?.text || "").trim();
    const b0 = (d.banners || []).find((b) => b && (b.image || b.title));
    const bsrc = b0 && (b0._url || b0.image);
    const stage = b0
      ? `<div class="p-slide${bsrc ? " has-img" : ""}">${bsrc ? `<img src="${esc(bsrc)}" alt="">` : ""}<div class="p-slide-body">${b0.title ? `<h3>${esc(b0.title)}</h3>` : ""}${b0.subtitle ? `<p>${esc(b0.subtitle)}</p>` : ""}${b0.link ? `<span class="btn">${esc(b0.buttonText || "Ver más")}</span>` : ""}</div></div>`
      : `<div class="p-hero"><h3>${esc(d.heroTitle)}</h3><p>${esc(d.heroSubtitle)}</p></div>`;
    el.innerHTML = `${ann ? `<div class="p-ann">${esc(ann)}</div>` : ""}<div class="p-top"><span class="brand">${T.brandHTML(d, logoSrc)}</span><span class="btn btn-ghost">Escríbenos</span></div>
      ${stage}
      <div class="p-grid">${card("Producto de ejemplo", 25000, false)}${card("Producto agotado", 18000, true)}</div>`;
    const w = T.warnings(d.theme);
    const warn = $("#theme-warn");
    warn.textContent = w.join(" ");
    show(warn, w.length > 0);
  }

  function renderLook() {
    buildLookUI();
    if (!state.draft) state.draft = structuredClone(state.site);
    state.draft.banners = Array.isArray(state.draft.banners) ? state.draft.banners : [];
    state.draft.announcement = state.draft.announcement || { text: "", link: "" };
    state.draft.about = state.draft.about || { title: "", text: "", image: "" };
    state.draft.social = state.draft.social || {};
    syncLookInputs();
    renderBanners();
    renderPreview();
  }

  function setCustomFromInputs() {
    state.draft.theme = { mode: "custom", preset: "custom", accent: $("#c-accent").value, background: $("#c-bg").value, text: $("#c-text").value };
  }

  const bindLook = () => {
    bindBanners();
    const live = (id, key) => $(id).addEventListener("input", (e) => { state.draft[key] = e.target.value; renderPreview(); });
    live("#l-name", "storeName"); live("#l-hero", "heroTitle"); live("#l-sub", "heroSubtitle"); live("#l-wa", "whatsapp"); live("#l-greet", "orderGreeting");
    $("#l-name").addEventListener("input", () => show($("#e-lname"), false));
    $("#l-wa").addEventListener("input", () => show($("#e-wa"), false));
    $("#l-hide").addEventListener("change", (e) => { state.draft.hideSoldOut = e.target.checked; });
    document.querySelectorAll('input[name="brandMode"]').forEach((r) => r.addEventListener("change", () => { state.draft.brandMode = r.value; renderPreview(); }));
    for (const id of ["#c-accent", "#c-bg", "#c-text"]) $(id).addEventListener("input", () => { setCustomFromInputs(); syncLookInputs(); renderPreview(); });

    $("#pals").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-pal]");
      if (!b) return;
      if (b.dataset.pal === "auto") state.draft.theme = { mode: "auto" };
      else { const p = T.PALETTES.find((x) => x.key === b.dataset.pal); state.draft.theme = { mode: "custom", preset: p.key, accent: p.accent, background: p.background, text: p.text }; }
      syncLookInputs(); renderPreview();
    });
    $("#fonts").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-font]");
      if (!b) return;
      state.draft.font = b.dataset.font; syncLookInputs(); renderPreview();
    });

    $("#l-logo-file").addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;
      state.logoFile = file;
      if (state.logoUrl) URL.revokeObjectURL(state.logoUrl);
      state.logoUrl = URL.createObjectURL(file);
      if ((state.draft.brandMode || "name") === "name") state.draft.brandMode = "both";
      syncLookInputs(); renderPreview();
    });
    $("#l-logo-remove").addEventListener("click", () => {
      state.logoFile = null; if (state.logoUrl) URL.revokeObjectURL(state.logoUrl); state.logoUrl = "";
      $("#l-logo-file").value = "";
      state.draft.logo = ""; state.draft.brandMode = "name";
      syncLookInputs(); renderPreview();
    });

    $("#look-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const d = state.draft;
      show($("#look-error"), false);
      let bad = false;
      if (!String(d.storeName || "").trim()) { show($("#e-lname"), true); bad = true; $("#l-name").focus(); }
      const wa = String(d.whatsapp || "").replace(/[\s+\-()]/g, "");
      if (!/^\d{8,15}$/.test(wa)) { show($("#e-wa"), true); if (!bad) $("#l-wa").focus(); bad = true; }
      const ann = d.announcement || { text: "", link: "" };
      if (!okLink(String(ann.link || "").trim()) || String(ann.link || "").startsWith("#")) { show($("#e-annlink"), true); if (!bad) $("#l-ann-link").focus(); bad = true; }
      const social = {};
      for (const k of SOCIALS) {
        show($("#e-" + k), false);
        const v = normSocial(k, d.social?.[k]);
        if (v === null) { showErr("#e-" + k, "Escribe tu usuario (sin espacios) o el link completo que empieza por https://"); if (!bad) $("#l-" + k).focus(); bad = true; }
        else if (v) social[k] = v;
      }
      show($("#banners-error"), false);
      for (const [i, b] of (d.banners || []).entries()) {
        const dest = destOf(b);
        let msg = "";
        if (!b.image && !b._file && !String(b.title || "").trim()) msg = `El banner ${i + 1} necesita una imagen o un título.`;
        else if (dest.type === "cat" && !dest.c) msg = `En el banner ${i + 1} elige la categoría a la que lleva.`;
        else if (dest.type === "brand" && !dest.b) msg = `En el banner ${i + 1} elige la marca a la que lleva.`;
        else if (dest.type === "url" && !/^https?:\/\/\S+$/i.test(String(dest.url || "").trim())) msg = `El link del banner ${i + 1} debe empezar por https:// o http://`;
        if (msg) { showErr("#banners-error", msg); bad = true; break; }
      }
      if (bad) return;
      const btn = $("#look-save");
      btn.disabled = true; btn.textContent = "Guardando…";
      try {
        let logo = d.logo;
        if (state.logoFile) logo = await uploadImage(state.logoFile, { type: "image/png", max: 480, prefix: "logo-", message: "Subir logo" });
        const banners = [];
        for (const [i, b] of d.banners.entries()) {
          let image = b.image || "";
          if (b._file) image = await uploadImage(b._file, { max: 1800, prefix: `banner-${i}-`, message: "Subir banner" });
          const dest = destOf(b);
          banners.push({
            image, title: String(b.title || "").trim(), subtitle: String(b.subtitle || "").trim(), buttonText: String(b.buttonText || "").trim(),
            link: linkFromDest(dest), dest: dest.type === "none" ? { type: "none" } : { ...dest, ...(dest.type === "url" ? { url: String(dest.url).trim() } : {}) },
          });
        }
        let aboutImage = d.about?.image || "";
        if (state.aboutFile) aboutImage = await uploadImage(state.aboutFile, { max: 1400, prefix: "about-", message: "Subir foto de Quiénes somos" });
        const about = { title: String(d.about?.title || "").trim(), text: String(d.about?.text || "").trim(), image: aboutImage };
        const announcement = { text: String(ann.text || "").trim(), link: String(ann.link || "").trim() };
        const next = { ...d, banners, announcement, about, social, storeName: d.storeName.trim(), whatsapp: wa, logo, orderGreeting: String(d.orderGreeting || "").trim() || DEFAULT_SITE.orderGreeting };
        const saved = await updateJson("site.json", () => next, "Cambiar apariencia de la tienda");
        state.site = { ...DEFAULT_SITE, ...saved };
        for (const b of d.banners) if (b._url) URL.revokeObjectURL(b._url);
        if (state.aboutUrl) URL.revokeObjectURL(state.aboutUrl);
        state.aboutFile = null; state.aboutUrl = ""; $("#l-about-file").value = "";
        state.draft = structuredClone(state.site);
        state.draft.banners = state.draft.banners || [];
        state.draft.announcement = state.draft.announcement || { text: "", link: "" };
        state.logoFile = null; if (state.logoUrl) URL.revokeObjectURL(state.logoUrl); state.logoUrl = "";
        $("#l-logo-file").value = "";
        syncLookInputs(); renderBanners(); renderPreview();
        say("Guardado. Los cambios se ven en tu tienda en uno o dos minutos.", "ok");
      } catch (err) { showErr("#look-error", err.message || friendly(0)); }
      finally { btn.disabled = false; btn.textContent = "Guardar apariencia"; }
    });
  };

  /* ---------- Acceso ---------- */
  function renderAccess() {
    $("#access-title").textContent = state.vaultExists ? "Cambiar usuario o contraseña" : "Crear usuario y contraseña";
    $("#access-text").textContent = state.vaultExists
      ? "Ya puedes entrar con usuario y contraseña. Aquí puedes cambiarlos."
      : "Con esto entras al panel desde cualquier equipo sin pegar el token.";
  }

  $("#access-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const user = $("#a-user").value, pass = $("#a-pass").value, pass2 = $("#a-pass2").value;
    show($("#access-error"), false);
    const problem = passProblem(user, pass, pass2);
    if (problem) { showErr("#access-error", problem); return; }
    const btn = $("#access-save");
    btn.disabled = true; btn.textContent = "Guardando…";
    try {
      const vault = await makeVault(user, pass, { t: state.token, r: state.repo });
      await updateJson("admin-vault.json", () => vault, "Guardar acceso al panel");
      state.vaultExists = true;
      $("#a-user").value = ""; $("#a-pass").value = ""; $("#a-pass2").value = "";
      renderAccess();
      say("Listo. Desde ahora entras con tu usuario y contraseña. Funciona en uno o dos minutos, cuando GitHub publique el cambio.", "ok");
    } catch (err) { showErr("#access-error", err.message || friendly(0)); }
    finally { btn.disabled = false; btn.textContent = "Guardar acceso"; }
  });

  function render() {
    if (state.tab === "mine") renderMine();
    if (state.tab === "add") renderAdd();
    if (state.tab === "cats") renderCats();
    if (state.tab === "look") renderLook();
    if (state.tab === "access") renderAccess();
  }

  /* ---------- Diálogo de producto ---------- */
  const OPT = ["subcategory", "brand", "hidden", "oldPrice", "badge", "description", "kit", "includes"];
  const dlg = $("#dlg");
  const f = { name: $("#f-name"), cat: $("#f-cat"), sub: $("#f-sub"), brand: $("#f-brand"), stock: $("#f-stock"), old: $("#f-old"), badge: $("#f-badge"), desc: $("#f-desc"), kit: $("#f-kit"), inc: $("#f-inc"), price: $("#f-price"), image: $("#f-image"), file: $("#f-file"), hidden: $("#f-hidden"), preview: $("#f-preview") };

  function setPreview() {
    const src = f.image.value.trim();
    f.preview.hidden = !src;
    if (src) f.preview.src = src;
  }

  function stockHelp() {
    const d = state.dlg; if (!d) return;
    const n = Math.floor(Number(f.stock.value)) || 0;
    let t;
    if (!d.linked) t = n > 0 ? `Producto propio: se vende mientras tengas ${n} unidad${n === 1 ? "" : "es"}.` : "Producto propio: con 0 unidades aparece como agotado.";
    else if (n > 0) t = `Se seguirá vendiendo aunque el proveedor lo oculte o lo quite, mientras tengas ${n} unidad${n === 1 ? "" : "es"} aquí.`;
    else t = "Con 0 sigue lo que diga el proveedor: si lo oculta o lo quita, desaparece de tu tienda.";
    if (d.linked) t += d.supplierOk ? " Ahora el proveedor lo tiene." : " Ahora el proveedor no lo tiene.";
    $("#f-stock-help").textContent = t;
  }
  const fillSubs = (catInput, listId) => {
    $(listId).innerHTML = subsFor(catInput.value).map((x) => `<option value="${esc(x)}">`).join("");
  };

  function openDialog(mode, data) {
    state.dlg = { mode, id: data.id, supplier: data.supplier, linked: mode !== "own" && !!(data.supplier || data.supplierName || data.linked), supplierOk: data.supplierOk };
    $("#dlg-title").textContent = mode === "add" ? "Agregar a tu tienda" : mode === "own" ? (data.kit ? "Crear kit" : "Crear producto propio") : "Editar producto";
    $("#dlg-supplier").textContent = mode === "own" ? "Un producto que no viene del proveedor. Se vende solo mientras tengas stock." : data.supplierName ? `Producto del proveedor: ${data.supplierName}` : "";
    f.name.value = data.name || "";
    f.cat.value = data.category || "";
    f.sub.value = data.subcategory || "";
    f.brand.value = data.brand || guessBrand(data.name || "");
    f.stock.value = data.stock ?? 0;
    f.price.value = data.price ?? "";
    f.old.value = data.oldPrice ?? "";
    f.badge.value = data.badge || "";
    f.desc.value = data.description || "";
    f.kit.checked = !!data.kit;
    f.inc.value = (data.includes || []).join("\n");
    show($("#f-inc-wrap"), f.kit.checked);
    f.image.value = data.image || "";
    f.file.value = "";
    f.hidden.checked = !!data.hidden;
    const t = taxonomy();
    $("#cat-options").innerHTML = uniq([...t.cats.keys(), ...state.config.categories.map((c) => categoryLabel(c.id))]).map((c) => `<option value="${esc(c)}">`).join("");
    $("#brand-options").innerHTML = t.brands.map((c) => `<option value="${esc(c)}">`).join("");
    fillSubs(f.cat, "#sub-options");
    for (const id of ["e-name", "e-price", "e-stock", "e-old", "dlg-error"]) show($("#" + id), false);
    for (const k of ["name", "price", "stock"]) f[k].removeAttribute("aria-invalid");
    show($("#dlg-remove"), mode === "edit");
    $("#dlg-save").disabled = false;
    stockHelp();
    setPreview();
    dlg.showModal();
    f.name.focus();
  }

  f.cat.addEventListener("input", () => fillSubs(f.cat, "#sub-options"));
  f.kit.addEventListener("change", () => show($("#f-inc-wrap"), f.kit.checked));
  f.old.addEventListener("input", () => show($("#e-old"), false));
  f.stock.addEventListener("input", () => { show($("#e-stock"), false); f.stock.removeAttribute("aria-invalid"); stockHelp(); });
  $("#b-cat").addEventListener("input", () => fillSubs($("#b-cat"), "#sub-options"));

  f.name.addEventListener("input", () => { show($("#e-name"), false); f.name.removeAttribute("aria-invalid"); });
  f.price.addEventListener("input", () => { show($("#e-price"), false); f.price.removeAttribute("aria-invalid"); });
  f.image.addEventListener("input", setPreview);
  f.file.addEventListener("change", () => {
    const file = f.file.files[0];
    if (file) { f.preview.src = URL.createObjectURL(file); f.preview.hidden = false; }
  });
  $("#dlg-cancel").addEventListener("click", () => dlg.close());

  $("#dlg-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = f.name.value.trim();
    const price = Number(f.price.value);
    let bad = false;
    if (!name) { show($("#e-name"), true); f.name.setAttribute("aria-invalid", "true"); bad = true; }
    if (!(price > 0)) { show($("#e-price"), true); f.price.setAttribute("aria-invalid", "true"); bad = true; }
    const oldRaw = f.old.value.trim();
    const oldPrice = oldRaw === "" ? 0 : Number(oldRaw);
    if (oldRaw !== "" && !(oldPrice > price)) { show($("#e-old"), true); f.old.setAttribute("aria-invalid", "true"); bad = true; }
    const stockRaw = String(f.stock.value).trim();
    const stock = stockRaw === "" ? 0 : Number(stockRaw);
    const stockBad = !Number.isInteger(stock) || stock < 0 || stock > 99999;
    if (stockBad) { show($("#e-stock"), true); f.stock.setAttribute("aria-invalid", "true"); bad = true; }
    if (bad) { (!name ? f.name : !(price > 0) ? f.price : (oldRaw !== "" && !(oldPrice > price)) ? f.old : f.stock).focus(); return; }

    const btn = $("#dlg-save");
    btn.disabled = true; btn.textContent = "Guardando…";
    try {
      let image = f.image.value.trim();
      if (f.file.files[0]) image = await uploadImage(f.file.files[0], { message: "Subir foto de producto" });
      const t = taxonomy();
      const category = canon(f.cat.value, [...t.cats.keys()]);
      const subcategory = canon(f.sub.value, subsFor(category));
      const brand = canon(f.brand.value, t.brands);
      const isKit = f.kit.checked;
      const incl = isKit ? f.inc.value.split(/\n/).map((x) => x.trim()).filter(Boolean) : [];
      const base = { name, category, subcategory, brand, price, image, stock, hidden: f.hidden.checked || undefined,
        oldPrice: oldPrice || undefined, badge: f.badge.value, description: f.desc.value.trim(), kit: isKit || undefined, includes: incl.length ? incl : undefined };

      if (state.dlg.mode === "add") {
        const s = state.dlg.supplier;
        const rec = {
          id: "p" + s.id, supplierId: s.id, supplierName: s.name, ...base,
          supplierAvailable: availability(s).ok, lastChecked: null,
        };
        rec.available = isAvailable(rec);
        for (const k of OPT) if (!rec[k]) delete rec[k];
        const next = await updateJson("products.json", (d) => {
          d.products = d.products || [];
          if (!d.products.some((p) => p.id === rec.id)) d.products.push(rec);
          return d;
        }, `Agregar ${name}`);
        state.products = next.products;
      } else if (state.dlg.mode === "own") {
        const rec = { id: state.dlg.id, ...base };
        rec.available = isAvailable(rec);
        for (const k of OPT) if (!rec[k]) delete rec[k];
        const next = await updateJson("products.json", (d) => { d.products = d.products || []; d.products.push(rec); return d; }, `Crear ${name}`);
        state.products = next.products;
      } else {
        const next = await updateJson("products.json", (d) => {
          d.products = d.products.map((p) => {
            if (p.id !== state.dlg.id) return p;
            const merged = { ...p, ...base };
            for (const k of OPT) if (!merged[k]) delete merged[k];
            merged.available = isAvailable(merged);
            return merged;
          });
          return d;
        }, `Editar ${name}`);
        state.products = next.products;
      }
      dlg.close();
      say("Guardado. Tu tienda se actualiza en uno o dos minutos.", "ok");
      render();
    } catch (err) {
      $("#dlg-error").textContent = err.message || friendly(0);
      show($("#dlg-error"), true);
    } finally {
      btn.disabled = false; btn.textContent = "Guardar producto";
    }
  });

  $("#dlg-remove").addEventListener("click", async () => {
    const p = state.products.find((x) => x.id === state.dlg.id);
    if (!p || !confirm(p.supplierId ? `¿Quitar "${p.name}" de tu tienda? Podrás volver a agregarlo desde el catálogo del proveedor.` : `¿Borrar "${p.name}"? Es un producto propio y no se puede recuperar.`)) return;
    try {
      const next = await updateJson("products.json", (d) => { d.products = d.products.filter((x) => x.id !== p.id); return d; }, `Quitar ${p.name}`);
      state.products = next.products;
      dlg.close();
      say(`Quitaste "${p.name}" de tu tienda.`, "ok");
      render();
    } catch (err) {
      $("#dlg-error").textContent = err.message; show($("#dlg-error"), true);
    }
  });

  /* ---------- Eventos de la pantalla ---------- */
  document.addEventListener("click", (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.goto) setTab(t.dataset.goto);
    if (t.dataset.edit) {
      const p = state.products.find((x) => x.id === t.dataset.edit);
      if (p) openDialog("edit", { id: p.id, supplierName: p.supplierName, linked: !!p.supplierId, supplierOk: supplierHas(p), name: p.name, category: p.category, subcategory: p.subcategory, brand: p.brand, stock: myStock(p), price: p.price, oldPrice: p.oldPrice, badge: p.badge, description: p.description, kit: p.kit, includes: p.includes, image: p.image, hidden: p.hidden });
    }
    if (t.dataset.add) {
      const s = state.catalog.products.find((x) => x.id === t.dataset.add);
      if (s) openDialog("add", { supplier: s, supplierName: s.name, supplierOk: availability(s).ok, name: s.name, category: categoryLabel(s.category), stock: 0, price: "", image: "" });
    }
    if (t.dataset.stock) {
      const p = state.products.find((x) => x.id === t.dataset.stock);
      if (p) setStock(p.id, myStock(p) + Number(t.dataset.d), `[data-stock="${CSS.escape(p.id)}"][data-d="${t.dataset.d}"]`);
    }
    if (t.dataset.rmcat) removeCategory(t.dataset.rmcat);
  });
  for (const t of TABS) $("#tab-" + t).addEventListener("click", () => setTab(t));
  $("#m-q").addEventListener("input", (e) => { mine.q = e.target.value; mine.limit = 50; renderMine(); });
  $("#m-cat").addEventListener("change", (e) => { mine.cat = e.target.value; mine.limit = 50; renderMine(); });
  $("#m-brand").addEventListener("change", (e) => { mine.brand = e.target.value; mine.limit = 50; renderMine(); });
  $("#m-state").addEventListener("change", (e) => { mine.st = e.target.value; mine.limit = 50; renderMine(); });
  $("#mine-more-btn").addEventListener("click", () => { mine.limit += 50; renderMine(); });
  $("#m-kit").addEventListener("click", () => openDialog("own", { id: "own-" + Date.now(), name: "", category: "", stock: 1, price: "", image: "", kit: true }));
  $("#m-own").addEventListener("click", () => openDialog("own", { id: "own-" + Date.now(), name: "", category: "", stock: 1, price: "", image: "" }));
  $("#mine-list").addEventListener("change", (e) => {
    const pick = e.target.dataset.pick, sin = e.target.dataset.stockin;
    if (pick) { e.target.checked ? mine.sel.add(pick) : mine.sel.delete(pick); renderBulkBar(filteredMine().length); }
    if (sin) setStock(sin, e.target.value, `[data-stockin="${CSS.escape(sin)}"]`);
  });
  $("#m-all").addEventListener("change", (e) => {
    for (const p of filteredMine()) e.target.checked ? mine.sel.add(p.id) : mine.sel.delete(p.id);
    renderMine();
  });
  $("#bulk-clear").addEventListener("click", () => { mine.sel.clear(); renderMine(); });
  $("#bulk-edit").addEventListener("click", () => {
    const n = mine.sel.size; if (!n) return;
    $("#bulk-text").textContent = `Se cambian ${n} producto${n === 1 ? "" : "s"}.`;
    for (const id of ["b-cat", "b-sub", "b-brand"]) $("#" + id).value = "";
    $("#b-vis").value = ""; show($("#bulk-error"), false);
    const t = taxonomy();
    $("#cat-options").innerHTML = uniq([...t.cats.keys(), ...state.config.categories.map((c) => categoryLabel(c.id))]).map((c) => `<option value="${esc(c)}">`).join("");
    $("#brand-options").innerHTML = t.brands.map((c) => `<option value="${esc(c)}">`).join("");
    $("#sub-options").innerHTML = "";
    $("#bulk-dlg").showModal(); $("#b-cat").focus();
  });
  $("#bulk-cancel").addEventListener("click", () => $("#bulk-dlg").close());
  $("#bulk-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const t = taxonomy();
    const cat = $("#b-cat").value.trim() ? canon($("#b-cat").value, [...t.cats.keys()]) : "";
    const sub = $("#b-sub").value.trim() ? canon($("#b-sub").value, cat ? subsFor(cat) : []) : "";
    const brand = $("#b-brand").value.trim() ? canon($("#b-brand").value, t.brands) : "";
    const vis = $("#b-vis").value;
    if (!cat && !sub && !brand && !vis) { showErr("#bulk-error", "No elegiste nada para cambiar."); return; }
    if (sub && !cat && ![...mine.sel].every((id) => { const p = state.products.find((x) => x.id === id); return p?.category; })) { showErr("#bulk-error", "Para poner una subcategoría, escribe también la categoría."); return; }
    const ids = new Set(mine.sel);
    const btn = $("#bulk-save"); btn.disabled = true; btn.textContent = "Guardando…";
    try {
      const next = await updateJson("products.json", (d) => {
        d.products = (d.products || []).map((p) => {
          if (!ids.has(p.id)) return p;
          const q = { ...p };
          if (cat) { if (norm(cat) !== norm(q.category)) delete q.subcategory; q.category = cat; }
          if (sub) q.subcategory = sub;
          if (brand) q.brand = brand;
          if (vis === "hide") q.hidden = true;
          if (vis === "show") delete q.hidden;
          return q;
        });
        return d;
      }, `Cambiar ${ids.size} productos`);
      state.products = next.products;
      mine.sel.clear();
      $("#bulk-dlg").close();
      say(`Listo: cambiaste ${ids.size} producto${ids.size === 1 ? "" : "s"}. La tienda se actualiza en uno o dos minutos.`, "ok");
      renderMine();
    } catch (err) { showErr("#bulk-error", err.message || friendly(0)); }
    finally { btn.disabled = false; btn.textContent = "Aplicar cambios"; }
  });
  $("#s-q").addEventListener("input", renderAdd);
  $("#s-cat").addEventListener("change", renderAdd);
  bindLook();

  async function removeCategory(id) {
    const name = categoryLabel(id);
    if (!confirm(`¿Dejar de revisar la categoría "${name}"? Los productos de tu tienda que vengan de ella ya no se actualizarán solos.`)) return;
    try {
      const next = await updateJson("sync/sync.config.json", (c) => { c.categories = (c.categories || []).filter((x) => String(x.id) !== String(id)); return c; }, `Quitar categoría ${name}`);
      state.config = next; say(`Dejaste de revisar "${name}".`, "ok"); render();
    } catch (err) { say(err.message, "bad"); }
  }

  $("#cat-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const raw = $("#c-url").value.trim();
    const m = raw.match(/\/(?:products|productos\/load-more|load-more)\/(\d+)/) || raw.match(/^(\d+)$/);
    const err = $("#cat-error");
    if (!m) { err.textContent = "No encontré el número de la categoría. Pega el link completo, por ejemplo https://sysvariedades.com.co/catalogoenlinea/public/products/2"; show(err, true); $("#c-url").focus(); return; }
    show(err, false);
    const id = Number(m[1]);
    if (state.config.categories.some((c) => Number(c.id) === id)) { err.textContent = "Esa categoría ya está en la lista."; show(err, true); return; }
    const name = $("#c-name").value.trim();
    try {
      const next = await updateJson("sync/sync.config.json", (c) => { c.categories = c.categories || []; c.categories.push(name ? { id, name } : { id }); return c; }, `Agregar categoría ${id}`);
      state.config = next;
      $("#c-url").value = ""; $("#c-name").value = "";
      say("Categoría agregada. Pulsa \"Revisar proveedor ahora\" para traer sus productos.", "ok");
      render();
    } catch (er) { err.textContent = er.message; show(err, true); }
  });

  $("#rule-qty").addEventListener("change", async (e) => {
    const on = e.target.checked;
    try {
      const next = await updateJson("sync/sync.config.json", (c) => { c.soldOutWhenQuantityAtOrBelow = on ? 0 : null; return c; }, "Cambiar regla de agotado");
      state.config = next; say("Regla guardada. Se aplica en la próxima revisión.", "ok");
    } catch (err) { e.target.checked = !on; say(err.message, "bad"); }
  });

  $("#btn-reload").addEventListener("click", async () => {
    try { say("Cargando…"); await loadAll(); say("Datos al día.", "ok"); render(); } catch (err) { say(err.message, "bad"); }
  });

  $("#btn-check").addEventListener("click", async () => {
    const b = $("#btn-check");
    b.disabled = true;
    try {
      const r = await gh("actions/workflows/sync.yml/dispatches", { method: "POST", body: JSON.stringify({ ref: state.branch }) });
      if (r.status === 204) say("Revisión iniciada. En uno o dos minutos habrá novedades; entonces pulsa Recargar.", "ok");
      else say(r.status === 403 || r.status === 404 ? "El token no puede iniciar la revisión. Agrega el permiso Actions en \"Read and write\" o inícialas desde la pestaña Actions de GitHub." : friendly(r.status), "bad");
    } catch (err) { say(err.message, "bad"); }
    b.disabled = false;
  });

  $("#btn-logout").addEventListener("click", () => { store.clear(); state.token = ""; state.draft = null; showLogin(); say(""); });

  /* ---------- Entrada ---------- */
  function guessRepo() {
    const m = location.hostname.match(/^([^.]+)\.github\.io$/i);
    if (!m) return "";
    const seg = location.pathname.split("/").filter(Boolean)[0];
    return seg && !/\.html?$/i.test(seg) ? `${m[1]}/${seg}` : "";
  }

  function chooseLoginForm(usePass) {
    show($("#form-pass"), usePass);
    show($("#form-token"), !usePass);
    show($("#to-pass-wrap"), state.vaultExists);
    $("#token-intro").hidden = state.vaultExists;
    (usePass ? $("#p-user") : $("#in-repo")).focus();
  }

  async function showLogin() {
    show($("#login"), true); show($("#app"), false); show($("#top-actions"), false);
    for (const id of ["#pass-error", "#login-error"]) show($(id), false);
    $("#in-token").value = ""; $("#p-pass").value = "";
    $("#in-repo").value = $("#in-repo").value || guessRepo();
    state.vaultExists = !!(await fetchVault());
    chooseLoginForm(state.vaultExists);
  }

  async function enter(firstTime) {
    say("Cargando…");
    await loadAll();
    show($("#login"), false); show($("#app"), true); show($("#top-actions"), true);
    say("");
    if (firstTime && !state.vaultExists) {
      setTab("access");
      say("Ya estás dentro. Crea tu usuario y contraseña para entrar más fácil la próxima vez.", "ok");
    } else setTab("mine");
  }

  $("#to-token").addEventListener("click", () => chooseLoginForm(false));
  $("#to-pass").addEventListener("click", () => chooseLoginForm(true));

  $("#form-pass").addEventListener("submit", async (e) => {
    e.preventDefault();
    const user = $("#p-user").value.trim(), pass = $("#p-pass").value;
    show($("#pass-error"), false);
    if (!user || !pass) { showErr("#pass-error", "Escribe tu usuario y tu contraseña."); return; }
    const btn = $("#pass-submit");
    btn.disabled = true; btn.textContent = "Entrando…";
    try {
      const vault = await fetchVault();
      if (!vault) throw new Error("Todavía no hay usuario y contraseña creados. Entra con tu token de GitHub y créalos en la pestaña Acceso.");
      const secret = await openVault(vault, user, pass);
      if (!secret || !secret.t || !secret.r) throw new Error("Usuario o contraseña incorrectos. Revísalos e intenta de nuevo.");
      state.repo = secret.r; state.token = secret.t;
      await enter(false);
      store.set({ repo: state.repo, token: state.token }, $("#p-remember").checked);
    } catch (ex) { say(""); showErr("#pass-error", ex.message || friendly(0)); }
    finally { btn.disabled = false; btn.textContent = "Entrar al panel"; }
  });

  $("#form-token").addEventListener("submit", async (e) => {
    e.preventDefault();
    const repo = $("#in-repo").value.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\/+$/, "");
    const token = $("#in-token").value.trim();
    show($("#login-error"), false);
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { showErr("#login-error", "Escribe el repositorio como usuario/nombre-del-repositorio."); $("#in-repo").focus(); return; }
    if (!token) { showErr("#login-error", "Pega tu token de acceso."); $("#in-token").focus(); return; }
    state.repo = repo; state.token = token;
    try {
      await enter(true);
      store.set({ repo, token }, $("#t-remember").checked);
    } catch (ex) { say(""); showErr("#login-error", ex.message || friendly(0)); }
  });

  (async function start() {
    const s = store.get();
    if (!s) return showLogin();
    state.repo = s.repo; state.token = s.token;
    state.vaultExists = !!(await fetchVault());
    try { await enter(false); } catch (ex) { await showLogin(); say(ex.message, "bad"); }
  })();
})();
