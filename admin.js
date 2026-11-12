"use strict";
(function () {
  const KEY = "tienda-admin-v1";
  const $ = (s) => document.querySelector(s);
  const state = {
    repo: "", token: "", branch: "main",
    products: [], config: null, catalog: { categories: [], products: [] },
    tab: "mine", dlg: null, // dlg = { mode: "add"|"edit", id?, supplier? }
  };

  /* ---------- utilidades ---------- */
  const store = {
    get() { try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch { return null; } },
    set(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* sin almacenamiento */ } },
    clear() { try { localStorage.removeItem(KEY); } catch { /* nada */ } },
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const SITE = window.SITE || {};
  const money = (n) => (n === null || n === undefined || n === "" ? "—" :
    new Intl.NumberFormat(SITE.locale || "es-CO", { style: "currency", currency: SITE.currency || "COP", maximumFractionDigits: 0 }).format(n));

  function say(msg, kind) {
    const el = $("#status");
    el.textContent = msg || "";
    el.className = "status" + (kind ? " " + kind : "");
  }
  const show = (el, on) => { el.hidden = !on; };

  const toB64 = (bytes) => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
  const encodeText = (t) => toB64(new TextEncoder().encode(t));
  const decodeText = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, "")), (c) => c.charCodeAt(0)));

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
      const next = mutate(structuredClone(data));
      const r = await putFile(p, encodeText(JSON.stringify(next, null, 2) + "\n"), sha, message);
      if (r.ok) return next;
      if (r.status !== 409 && r.status !== 422) throw new ApiError(r.status, friendly(r.status));
    }
    throw new ApiError(409, friendly(409));
  }

  async function resizeToJpegB64(file, max = 900) {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.85).split(",")[1];
  }

  async function uploadImage(file) {
    const b64 = await resizeToJpegB64(file);
    const p = `img/${Date.now()}.jpg`;
    const r = await putFile(p, b64, null, "Subir foto de producto");
    if (!r.ok) throw new ApiError(r.status, friendly(r.status));
    return p;
  }

  async function loadAll() {
    const repo = await gh("");
    if (!repo.ok) throw new ApiError(repo.status, friendly(repo.status));
    state.branch = (await repo.json()).default_branch || "main";

    const [prods, cfg] = await Promise.all([readJson("products.json"), readJson("sync/sync.config.json")]);
    state.products = prods.data?.products || [];
    state.config = cfg.data || { categories: [], soldOutWhenQuantityAtOrBelow: 0 };
    state.config.categories = state.config.categories || [];

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
  function setTab(name) {
    state.tab = name;
    for (const t of ["mine", "add", "cats"]) {
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

  function render() {
    if (state.tab === "mine") renderMine();
    if (state.tab === "add") renderAdd();
    if (state.tab === "cats") renderCats();
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
      if (f.file.files[0]) image = await uploadImage(f.file.files[0]);
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
  for (const t of ["mine", "add", "cats"]) $("#tab-" + t).addEventListener("click", () => setTab(t));
  $("#s-q").addEventListener("input", renderAdd);
  $("#s-cat").addEventListener("change", renderAdd);

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

  $("#btn-logout").addEventListener("click", () => { store.clear(); state.token = ""; showLogin(); say(""); });

  /* ---------- Entrada ---------- */
  function showLogin(prefillRepo) {
    show($("#login"), true); show($("#app"), false); show($("#top-actions"), false);
    if (prefillRepo) $("#in-repo").value = prefillRepo;
    $("#in-token").value = "";
  }

  async function enter() {
    say("Cargando…");
    await loadAll();
    show($("#login"), false); show($("#app"), true); show($("#top-actions"), true);
    say("");
    setTab(state.tab);
  }

  $("#btn-reload").addEventListener("click", async () => {
    try { say("Cargando…"); await loadAll(); say("Datos al día.", "ok"); render(); } catch (err) { say(err.message, "bad"); }
  });

  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const repo = $("#in-repo").value.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\/+$/, "");
    const token = $("#in-token").value.trim();
    const err = $("#login-error");
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { err.textContent = "Escribe el repositorio como usuario/nombre-del-repositorio."; show(err, true); $("#in-repo").focus(); return; }
    if (!token) { err.textContent = "Pega tu token de acceso."; show(err, true); $("#in-token").focus(); return; }
    show(err, false);
    state.repo = repo; state.token = token;
    try {
      await enter();
      store.set({ repo, token });
    } catch (ex) {
      say("");
      err.textContent = ex.message || friendly(0); show(err, true);
    }
  });

  (async function start() {
    const s = store.get();
    if (!s) return showLogin();
    state.repo = s.repo; state.token = s.token;
    try { await enter(); } catch (ex) { showLogin(s.repo); say(ex.message, "bad"); }
  })();
})();
