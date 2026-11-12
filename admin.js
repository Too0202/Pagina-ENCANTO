"use strict";
(function () {
  const KEY = "tienda-admin-v1";
  const $ = (s) => document.querySelector(s);
  const T = window.Theme;
  const DEFAULT_SITE = {
    storeName: "Mi tienda", logo: "", brandMode: "name", heroTitle: "Belleza que se nota",
    heroSubtitle: "Productos seleccionados, con disponibilidad actualizada.", whatsapp: "", currency: "COP", locale: "es-CO",
    hideSoldOut: false, theme: { mode: "auto" }, font: "clasica",
  };
  const state = {
    repo: "", token: "", branch: "main",
    products: [], config: null, catalog: { categories: [], products: [] }, site: { ...DEFAULT_SITE },
    tab: "mine", dlg: null,
    draft: null, logoFile: null, logoUrl: "", vaultExists: false,
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

  function renderMine() {
    const list = state.products;
    const out = list.filter((p) => p.available === false).length;
    $("#mine-summary").textContent = list.length
      ? `${list.length} producto${list.length === 1 ? "" : "s"} en tu tienda, ${out} agotado${out === 1 ? "" : "s"}.`
      : "";
    show($("#mine-empty"), list.length === 0);
    $("#mine-list").innerHTML = list.map((p) => {
      const pill = p.hidden ? '<span class="pill warn">Oculto</span>'
        : p.available === false ? '<span class="pill out">Agotado</span>'
        : '<span class="pill ok">Disponible</span>';
      const link = p.supplierId ? "" : '<span class="pill warn">Sin vínculo con el proveedor</span>';
      return `<div class="row">
        ${thumb(p.image, p.name)}
        <div class="row-main">
          <div class="row-name">${esc(p.name)}</div>
          <div class="row-sub"><span>${money(p.price)}</span><span>${esc(p.category || "")}</span>${pill}${link}</div>
        </div>
        <button class="btn btn-ghost" type="button" data-edit="${esc(p.id)}">Editar</button>
      </div>`;
    }).join("");
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
    el.innerHTML = `<div class="p-top"><span class="brand">${T.brandHTML(d, logoSrc)}</span><span class="btn btn-ghost">Escríbenos</span></div>
      <div class="p-hero"><h3>${esc(d.heroTitle)}</h3><p>${esc(d.heroSubtitle)}</p></div>
      <div class="p-grid">${card("Producto de ejemplo", 25000, false)}${card("Producto agotado", 18000, true)}</div>`;
    const w = T.warnings(d.theme);
    const warn = $("#theme-warn");
    warn.textContent = w.join(" ");
    show(warn, w.length > 0);
  }

  function renderLook() {
    buildLookUI();
    if (!state.draft) state.draft = structuredClone(state.site);
    syncLookInputs();
    renderPreview();
  }

  function setCustomFromInputs() {
    state.draft.theme = { mode: "custom", preset: "custom", accent: $("#c-accent").value, background: $("#c-bg").value, text: $("#c-text").value };
  }

  const bindLook = () => {
    const live = (id, key) => $(id).addEventListener("input", (e) => { state.draft[key] = e.target.value; renderPreview(); });
    live("#l-name", "storeName"); live("#l-hero", "heroTitle"); live("#l-sub", "heroSubtitle"); live("#l-wa", "whatsapp");
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
      if (bad) return;
      const btn = $("#look-save");
      btn.disabled = true; btn.textContent = "Guardando…";
      try {
        let logo = d.logo;
        if (state.logoFile) logo = await uploadImage(state.logoFile, { type: "image/png", max: 480, prefix: "logo-", message: "Subir logo" });
        const next = { ...d, storeName: d.storeName.trim(), whatsapp: wa, logo };
        const saved = await updateJson("site.json", () => next, "Cambiar apariencia de la tienda");
        state.site = { ...DEFAULT_SITE, ...saved };
        state.draft = structuredClone(state.site);
        state.logoFile = null; if (state.logoUrl) URL.revokeObjectURL(state.logoUrl); state.logoUrl = "";
        $("#l-logo-file").value = "";
        syncLookInputs(); renderPreview();
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
  const dlg = $("#dlg");
  const f = { name: $("#f-name"), cat: $("#f-cat"), price: $("#f-price"), image: $("#f-image"), file: $("#f-file"), hidden: $("#f-hidden"), preview: $("#f-preview") };

  function setPreview() {
    const src = f.image.value.trim();
    f.preview.hidden = !src;
    if (src) f.preview.src = src;
  }

  function openDialog(mode, data) {
    state.dlg = { mode, id: data.id, supplier: data.supplier };
    $("#dlg-title").textContent = mode === "add" ? "Agregar a tu tienda" : "Editar producto";
    $("#dlg-supplier").textContent = data.supplierName ? `Producto del proveedor: ${data.supplierName}` : "";
    f.name.value = data.name || "";
    f.cat.value = data.category || "";
    f.price.value = data.price ?? "";
    f.image.value = data.image || "";
    f.file.value = "";
    f.hidden.checked = !!data.hidden;
    $("#cat-options").innerHTML = [...new Set([...state.products.map((p) => p.category), ...state.config.categories.map((c) => categoryLabel(c.id))].filter(Boolean))]
      .map((c) => `<option value="${esc(c)}">`).join("");
    for (const id of ["e-name", "e-price", "dlg-error"]) show($("#" + id), false);
    f.name.removeAttribute("aria-invalid"); f.price.removeAttribute("aria-invalid");
    show($("#dlg-remove"), mode === "edit");
    $("#dlg-save").disabled = false;
    setPreview();
    dlg.showModal();
    f.name.focus();
  }

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
    if (bad) { (!name ? f.name : f.price).focus(); return; }

    const btn = $("#dlg-save");
    btn.disabled = true; btn.textContent = "Guardando…";
    try {
      let image = f.image.value.trim();
      if (f.file.files[0]) image = await uploadImage(f.file.files[0], { message: "Subir foto de producto" });
      const base = { name, category: f.cat.value.trim(), price, image, hidden: f.hidden.checked || undefined };

      if (state.dlg.mode === "add") {
        const s = state.dlg.supplier;
        const rec = {
          id: "p" + s.id, supplierId: s.id, supplierName: s.name, ...base,
          available: availability(s).ok, lastChecked: null,
        };
        const next = await updateJson("products.json", (d) => {
          d.products = d.products || [];
          if (!d.products.some((p) => p.id === rec.id)) d.products.push(rec);
          return d;
        }, `Agregar ${name}`);
        state.products = next.products;
      } else {
        const next = await updateJson("products.json", (d) => {
          d.products = d.products.map((p) => {
            if (p.id !== state.dlg.id) return p;
            const merged = { ...p, ...base };
            if (!merged.hidden) delete merged.hidden;
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
    if (!p || !confirm(`¿Quitar "${p.name}" de tu tienda? Podrás volver a agregarlo desde el catálogo del proveedor.`)) return;
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
      if (p) openDialog("edit", { id: p.id, supplierName: p.supplierName, name: p.name, category: p.category, price: p.price, image: p.image, hidden: p.hidden });
    }
    if (t.dataset.add) {
      const s = state.catalog.products.find((x) => x.id === t.dataset.add);
      if (s) openDialog("add", { supplier: s, supplierName: s.name, name: s.name, category: categoryLabel(s.category), price: "", image: "" });
    }
    if (t.dataset.rmcat) removeCategory(t.dataset.rmcat);
  });
  for (const t of TABS) $("#tab-" + t).addEventListener("click", () => setTab(t));
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
