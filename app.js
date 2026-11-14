(function () {
  const DEFAULTS = {
    storeName: "Mi tienda", logo: "", brandMode: "name",
    heroTitle: "", heroSubtitle: "", whatsapp: "", currency: "COP", locale: "es-CO",
    hideSoldOut: false, theme: { mode: "auto" }, font: "clasica",
    orderGreeting: "Hola, quiero hacer este pedido:",
    announcement: { text: "", link: "" }, banners: [],
  };
  const S = { ...DEFAULTS };
  const $ = (id) => document.getElementById(id);
  const MAX_QTY = 99;
  const PAGE = 48;

  const state = { products: [], f: emptyFilters(), sort: "destacados", shown: PAGE };
  function emptyFilters() { return { c: "", s: "", b: [], min: "", max: "", q: "", a: false }; }

  const money = (n) =>
    new Intl.NumberFormat(S.locale || "es-CO", { style: "currency", currency: S.currency || "COP", maximumFractionDigits: 0 }).format(n);
  const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const plural = (n, a, b) => `${n} ${n === 1 ? a : b}`;

  /* ---------- disponibilidad y stock propio ---------- */
  // Unidades que tengo yo. Si hay, el producto se vende aunque el proveedor lo oculte o lo quite.
  const myStock = (p) => { const n = Math.floor(Number(p.stock)); return Number.isFinite(n) && n > 0 ? n : 0; };
  // ¿Lo tiene el proveedor? Lo dice el robot en "supplierAvailable" (antes de existir el stock propio era "available").
  const supplierHas = (p) => !!p.supplierId && (p.supplierAvailable !== undefined ? p.supplierAvailable !== false : p.available !== false);
  const isAvailable = (p) => myStock(p) > 0 || supplierHas(p);
  // Máximo que un cliente puede pedir: si el proveedor lo tiene, sin tope práctico; si solo lo tengo yo, lo que haya en mi stock.
  const maxQty = (p) => (supplierHas(p) ? MAX_QTY : Math.min(MAX_QTY, myStock(p)));
  const lowStockNote = (p) => {
    const m = maxQty(p);
    return m > 0 && m <= 5 && m < MAX_QTY ? `Quedan ${m}` : "";
  };

  /* ---------- carrito (se guarda en este navegador) ---------- */
  const CART_KEY = "tienda-carrito-v1";
  const cart = { items: {}, name: "", notes: "" };

  function loadCart() {
    try {
      const v = JSON.parse(localStorage.getItem(CART_KEY) || "null");
      if (v && typeof v === "object") {
        for (const [id, q] of Object.entries(v.items || {})) if (Number.isInteger(q) && q > 0) cart.items[id] = Math.min(q, MAX_QTY);
        cart.name = String(v.name || ""); cart.notes = String(v.notes || "");
      }
    } catch { /* sin almacenamiento */ }
  }
  function saveCart() { try { localStorage.setItem(CART_KEY, JSON.stringify(cart)); } catch { /* nada */ } }

  const byId = (id) => state.products.find((p) => p.id === id);
  const lines = () => Object.entries(cart.items).map(([id, q]) => ({ p: byId(id), q })).filter((l) => l.p);
  const units = () => lines().reduce((n, l) => n + l.q, 0);
  const total = () => lines().reduce((n, l) => n + l.q * l.p.price, 0);

  // Quita lo que ya no se puede comprar y ajusta cantidades al stock disponible.
  function reconcile() {
    const gone = [], trimmed = [];
    for (const [id, q] of Object.entries(cart.items)) {
      const p = byId(id);
      if (!p || p.hidden || !isAvailable(p)) { delete cart.items[id]; gone.push(p ? p.name : null); continue; }
      const m = maxQty(p);
      if (q > m) { cart.items[id] = m; trimmed.push(p.name); }
    }
    const msgs = [];
    if (gone.length) { const n = gone.filter(Boolean); msgs.push("Quitamos de tu carrito " + (n.length ? "lo que ya no está disponible: " + n.join(", ") + "." : "productos que ya no están disponibles.")); }
    if (trimmed.length) msgs.push("Ajustamos la cantidad de " + trimmed.join(", ") + " a lo que tenemos.");
    if (msgs.length) { saveCart(); showNotice(msgs.join(" ")); }
  }
  function showNotice(msg) { const n = $("notice"); n.textContent = msg || ""; n.hidden = !msg; }

  function setQty(id, q, focusAct) {
    const p = byId(id);
    q = Math.min(p ? maxQty(p) : MAX_QTY, Math.max(0, q));
    if (q === 0) delete cart.items[id]; else cart.items[id] = q;
    saveCart(); showNotice("");
    renderAll({ id, act: focusAct });
  }

  function orderText() {
    const ls = lines().map(({ p, q }) => `${q} x ${p.name} — ${money(p.price * q)}`);
    const out = [S.orderGreeting || DEFAULTS.orderGreeting, "", ...ls, "", `Total: ${money(total())}`];
    if (cart.name.trim()) out.push(`Nombre: ${cart.name.trim()}`);
    if (cart.notes.trim()) out.push(`Notas: ${cart.notes.trim()}`);
    return out.join("\n");
  }

  const stepper = (p, q, minDisables) => `
    <div class="stepper" role="group" aria-label="Cantidad de ${esc(p.name)}">
      <button type="button" data-act="dec" data-id="${esc(p.id)}" aria-label="Quitar una unidad de ${esc(p.name)}"${minDisables && q <= 1 ? " disabled" : ""}>−</button>
      <span>${q}</span>
      <button type="button" data-act="inc" data-id="${esc(p.id)}" aria-label="Agregar una unidad más de ${esc(p.name)}"${q >= maxQty(p) ? " disabled" : ""}>+</button>
    </div>`;

  function card(p) {
    const out = !isAvailable(p);
    const q = cart.items[p.id] || 0;
    const media = p.image
      ? `<img src="${esc(p.image)}" alt="${esc(p.name)}" loading="lazy">`
      : `<span class="ph" aria-hidden="true">${esc(p.name.trim().charAt(0).toUpperCase())}</span>`;
    const action = out
      ? `<span class="btn" role="button" aria-disabled="true">No disponible por ahora</span>`
      : q
        ? stepper(p, q, false)
        : `<button class="btn" type="button" data-act="add" data-id="${esc(p.id)}" aria-label="Agregar ${esc(p.name)} al carrito">Agregar al carrito</button>`;
    const note = !out ? lowStockNote(p) : "";
    return `
      <article class="card${out ? " out" : ""}">
        <div class="media">${media}${out ? '<span class="badge">Agotado</span>' : ""}</div>
        <div class="body">
          <span class="cat">${esc([p.brand, p.subcategory || p.category].filter(Boolean).join(" · "))}</span>
          <h3 class="name">${esc(p.name)}</h3>
          <span class="price">${money(p.price)}</span>
          ${note ? `<span class="stocknote">${note}</span>` : ""}
        </div>
        <div class="actions">${action}</div>
      </article>`;
  }

  /* ---------- filtros ---------- */
  function baseProducts() {
    return state.products.filter((p) => !p.hidden && !(S.hideSoldOut && !isAvailable(p)));
  }
  function matches(p, f, skip) {
    if (skip !== "c" && f.c && p.category !== f.c) return false;
    if (skip !== "c" && f.s && p.subcategory !== f.s) return false;
    if (skip !== "b" && f.b.length && !f.b.includes(p.brand)) return false;
    if (f.min !== "" && p.price < Number(f.min)) return false;
    if (f.max !== "" && p.price > Number(f.max)) return false;
    if (f.a && !isAvailable(p)) return false;
    if (f.q) {
      const hay = norm([p.name, p.brand, p.category, p.subcategory].filter(Boolean).join(" "));
      if (!norm(f.q).split(/\s+/).every((w) => hay.includes(w))) return false;
    }
    return true;
  }
  const visible = () => baseProducts().filter((p) => matches(p, state.f));

  function sorted(list) {
    const l = list.slice();
    if (state.sort === "precio-asc") l.sort((a, b) => a.price - b.price);
    else if (state.sort === "precio-desc") l.sort((a, b) => b.price - a.price);
    else if (state.sort === "nombre") l.sort((a, b) => a.name.localeCompare(b.name, S.locale || "es"));
    else l.sort((a, b) => Number(!isAvailable(a)) - Number(!isAvailable(b))); // disponibles primero
    return l;
  }

  function filtersHTML() {
    const f = state.f;
    const base = baseProducts();
    const forCats = base.filter((p) => matches(p, f, "c"));
    const cats = new Map();
    for (const p of forCats) {
      if (!p.category) continue;
      const c = cats.get(p.category) || { n: 0, subs: new Map() };
      c.n++;
      if (p.subcategory) c.subs.set(p.subcategory, (c.subs.get(p.subcategory) || 0) + 1);
      cats.set(p.category, c);
    }
    const catNames = [...cats.keys()].sort((a, b) => a.localeCompare(b, "es"));
    let h = "";
    if (catNames.length) {
      h += `<div class="fgroup"><h3>Categoría</h3><ul class="flist">
        <li><button type="button" class="fopt${!f.c ? " on" : ""}" data-fk="c-all" data-set-c="" aria-pressed="${!f.c}">Todas</button></li>`;
      for (const name of catNames) {
        const c = cats.get(name), on = f.c === name;
        h += `<li><button type="button" class="fopt${on && !f.s ? " on" : ""}" data-fk="c-${esc(name)}" data-set-c="${esc(name)}" aria-pressed="${on && !f.s}">${esc(name)} <span>${c.n}</span></button>`;
        if (on && c.subs.size) {
          h += `<ul class="flist sub">`;
          for (const [s, n] of [...c.subs].sort((a, b) => a[0].localeCompare(b[0], "es")))
            h += `<li><button type="button" class="fopt${f.s === s ? " on" : ""}" data-fk="s-${esc(s)}" data-set-c="${esc(name)}" data-set-s="${esc(s)}" aria-pressed="${f.s === s}">${esc(s)} <span>${n}</span></button></li>`;
          h += `</ul>`;
        }
        h += `</li>`;
      }
      h += `</ul></div>`;
    }
    const brands = new Map();
    for (const p of base.filter((p) => matches(p, f, "b"))) if (p.brand) brands.set(p.brand, (brands.get(p.brand) || 0) + 1);
    for (const b of f.b) if (!brands.has(b)) brands.set(b, 0);
    if (brands.size) {
      h += `<div class="fgroup"><h3>Marca</h3><ul class="flist scroll">`;
      for (const [b, n] of [...brands].sort((a, b) => a[0].localeCompare(b[0], "es")))
        h += `<li><label class="fcheck"><input type="checkbox" data-brand="${esc(b)}" data-fk="b-${esc(b)}"${f.b.includes(b) ? " checked" : ""}><span>${esc(b)}</span><em>${n}</em></label></li>`;
      h += `</ul></div>`;
    }
    h += `<div class="fgroup"><h3>Precio</h3><div class="prange">
        <label>Desde<input type="number" inputmode="numeric" min="0" step="1000" data-price="min" data-fk="min" value="${esc(f.min)}"></label>
        <label>Hasta<input type="number" inputmode="numeric" min="0" step="1000" data-price="max" data-fk="max" value="${esc(f.max)}"></label>
      </div></div>
      <div class="fgroup"><label class="fcheck"><input type="checkbox" data-avail data-fk="avail"${f.a ? " checked" : ""}><span>Solo disponibles</span></label></div>`;
    return h;
  }

  function renderFilters() {
    const ae = document.activeElement;
    const key = ae && ae.dataset ? ae.dataset.fk : null;
    const inMobile = ae && $("filters-mobile").contains(ae);
    const html = filtersHTML();
    $("filters-desktop").innerHTML = html;
    $("filters-mobile").innerHTML = html;
    if (key) {
      const root = inMobile ? $("filters-mobile") : $("filters-desktop");
      const el = [...root.querySelectorAll("[data-fk]")].find((e) => e.dataset.fk === key);
      if (el) { el.focus(); if (el.type === "number") { const v = el.value; el.value = ""; el.value = v; } }
    }
  }

  function activeTags() {
    const f = state.f, t = [];
    if (f.c) t.push(["c", f.c]);
    if (f.s) t.push(["s", f.s]);
    f.b.forEach((b) => t.push(["b:" + b, b]));
    if (f.min !== "" || f.max !== "") t.push(["price", f.min !== "" && f.max !== "" ? `${money(f.min)} – ${money(f.max)}` : f.min !== "" ? `Desde ${money(f.min)}` : `Hasta ${money(f.max)}`]);
    if (f.a) t.push(["a", "Solo disponibles"]);
    if (f.q) t.push(["q", `“${f.q}”`]);
    return t;
  }

  function renderGrid() {
    const all = sorted(visible());
    const list = all.slice(0, state.shown);
    $("grid").innerHTML = list.map(card).join("");
    $("empty").hidden = all.length > 0;
    $("more").hidden = all.length <= list.length;
    $("meta").textContent = all.length ? plural(all.length, "producto", "productos") : "";
    const tags = activeTags();
    $("active").innerHTML = tags.map(([k, label]) => `<button type="button" class="tag" data-rm="${esc(k)}" aria-label="Quitar filtro ${esc(label)}">${esc(label)} <b aria-hidden="true">×</b></button>`).join("")
      + (tags.length > 1 ? `<button type="button" class="link" data-rm="all">Borrar filtros</button>` : "");
    const nf = tags.filter(([k]) => k !== "q").length;
    $("filter-count").textContent = nf; $("filter-count").hidden = nf === 0;
    $("filters-done").textContent = all.length ? `Ver ${plural(all.length, "producto", "productos")}` : "Ver productos";
  }

  /* ---------- la dirección (#) guarda los filtros, así los banners pueden enlazar a ellos ---------- */
  function filtersToHash(f) {
    const p = [];
    if (f.c) p.push("c=" + encodeURIComponent(f.c));
    if (f.s) p.push("s=" + encodeURIComponent(f.s));
    if (f.b.length) p.push("b=" + f.b.map(encodeURIComponent).join(","));
    if (f.min !== "") p.push("min=" + encodeURIComponent(f.min));
    if (f.max !== "") p.push("max=" + encodeURIComponent(f.max));
    if (f.q) p.push("q=" + encodeURIComponent(f.q));
    if (f.a) p.push("a=1");
    return p.join("&");
  }
  function hashToFilters(h) {
    const f = emptyFilters();
    h = String(h || "").replace(/^#/, "");
    if (!/[=]/.test(h)) return f;
    const get = (v) => { try { return decodeURIComponent(v); } catch { return v; } };
    for (const part of h.split("&")) {
      const i = part.indexOf("=");
      if (i < 0) continue;
      const k = part.slice(0, i), v = part.slice(i + 1);
      if (k === "c") f.c = get(v);
      else if (k === "s") f.s = get(v);
      else if (k === "b") f.b = v.split(",").map(get).filter(Boolean);
      else if (k === "min" && v !== "" && !isNaN(v)) f.min = get(v);
      else if (k === "max" && v !== "" && !isNaN(v)) f.max = get(v);
      else if (k === "q") f.q = get(v);
      else if (k === "a") f.a = v === "1";
    }
    return f;
  }
  let fromUs = false;
  function commitFilters() {
    state.shown = PAGE;
    const h = filtersToHash(state.f);
    fromUs = true;
    try { history.replaceState(null, "", h ? "#" + h : location.pathname + location.search); } catch { /* nada */ }
    setTimeout(() => { fromUs = false; }, 0);
    renderFilters(); renderGrid();
  }
  function applyHash(scroll) {
    state.f = hashToFilters(location.hash);
    state.shown = PAGE;
    $("q").value = state.f.q;
    renderFilters(); renderGrid();
    if (scroll && location.hash.length > 1) goCatalog();
  }
  window.addEventListener("hashchange", () => { if (!fromUs) applyHash(true); });
  function goCatalog() {
    const el = $("catalogo");
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  }

  function onFilterClick(e) {
    const t = e.target;
    const cb = t.closest("button[data-set-c]");
    if (cb) { state.f.c = cb.dataset.setC; state.f.s = cb.dataset.setS || ""; commitFilters(); }
  }
  function onFilterChange(e) {
    const t = e.target;
    if (t.matches("[data-brand]")) {
      const b = t.dataset.brand, set = new Set(state.f.b);
      t.checked ? set.add(b) : set.delete(b);
      state.f.b = [...set]; commitFilters();
    } else if (t.matches("[data-avail]")) { state.f.a = t.checked; commitFilters(); }
    else if (t.matches("[data-price]")) {
      const v = t.value.trim();
      state.f[t.dataset.price] = v !== "" && Number(v) >= 0 ? String(Math.floor(Number(v))) : "";
      commitFilters();
    }
  }
  for (const id of ["filters-desktop", "filters-mobile"]) {
    $(id).addEventListener("click", onFilterClick);
    $(id).addEventListener("change", onFilterChange);
  }
  $("active").addEventListener("click", (e) => {
    const b = e.target.closest("[data-rm]");
    if (!b) return;
    const k = b.dataset.rm, f = state.f;
    if (k === "all") { state.f = emptyFilters(); $("q").value = ""; }
    else if (k === "c") { f.c = ""; f.s = ""; }
    else if (k === "s") f.s = "";
    else if (k === "price") { f.min = ""; f.max = ""; }
    else if (k === "a") f.a = false;
    else if (k === "q") { f.q = ""; $("q").value = ""; }
    else if (k.startsWith("b:")) f.b = f.b.filter((x) => x !== k.slice(2));
    commitFilters();
  });
  let qTimer;
  $("q").addEventListener("input", (e) => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { state.f.q = e.target.value.trim(); commitFilters(); }, 200);
  });
  $("sort").addEventListener("change", (e) => { state.sort = e.target.value; state.shown = PAGE; renderGrid(); });
  $("clear").addEventListener("click", () => { state.f = emptyFilters(); $("q").value = ""; commitFilters(); });
  $("more-btn").addEventListener("click", () => {
    const before = $("grid").children.length;
    state.shown += PAGE; renderGrid();
    const first = $("grid").children[before];
    const btn = first && first.querySelector("button, [role=button]");
    if (btn) btn.focus({ preventScroll: false });
  });

  const fdlg = $("filters-dlg");
  $("filter-btn").addEventListener("click", () => fdlg.showModal());
  $("filters-close").addEventListener("click", () => fdlg.close());
  $("filters-done").addEventListener("click", () => fdlg.close());
  fdlg.addEventListener("click", (e) => { if (e.target === fdlg) fdlg.close(); });

  /* ---------- ventana del carrito ---------- */
  const dlg = $("cart-dlg");

  function renderCartDialog() {
    const ls = lines();
    $("cart-empty").hidden = ls.length > 0;
    $("cart-full").hidden = ls.length === 0;
    if (!ls.length) return;
    $("cart-list").innerHTML = ls.map(({ p, q }) => `
      <li class="cart-item">
        <div class="thumb">${p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy">` : esc(p.name.trim().charAt(0).toUpperCase())}</div>
        <div>
          <div class="ci-name">${esc(p.name)}</div>
          <div class="ci-price">${money(p.price)} c/u</div>
          <div class="ci-line">
            ${stepper(p, q, true)}
            <span class="ci-sum">${money(p.price * q)}</span>
            <button class="ci-remove" type="button" data-act="remove" data-id="${esc(p.id)}" aria-label="Quitar ${esc(p.name)} del carrito">Quitar</button>
          </div>
        </div>
      </li>`).join("");
    $("cart-total").textContent = money(total());
    updateSendLink();
  }
  function updateSendLink() { $("cart-send").href = `https://wa.me/${S.whatsapp}?text=${encodeURIComponent(orderText())}`; }
  function renderBar() {
    const n = units();
    $("cart-count").textContent = n;
    $("cart-count").setAttribute("aria-label", `${plural(n, "producto", "productos")} en el carrito`);
    $("cart-bar").hidden = n === 0;
    $("bar-text").textContent = `${plural(n, "producto", "productos")} · ${money(total())}`;
  }
  function renderAll(focus) {
    renderGrid(); renderBar(); renderCartDialog();
    if (focus && focus.id) {
      const root = dlg.open ? dlg : $("grid");
      const el = root.querySelector(`[data-id="${CSS.escape(focus.id)}"][data-act="${focus.act}"]`)
        || root.querySelector(`[data-id="${CSS.escape(focus.id)}"]:not([disabled])`);
      if (el) el.focus();
      else if (dlg.open) (units() ? $("cart-send") : $("cart-continue")).focus();
    }
  }
  function onAction(e) {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    const id = b.dataset.id, q = cart.items[id] || 0;
    if (b.dataset.act === "add") setQty(id, 1, "inc");
    else if (b.dataset.act === "inc") setQty(id, q + 1, "inc");
    else if (b.dataset.act === "dec") setQty(id, q - 1, q - 1 > 0 ? "dec" : "add");
    else if (b.dataset.act === "remove") setQty(id, 0, "add");
  }
  $("grid").addEventListener("click", onAction);
  $("cart-list").addEventListener("click", onAction);
  const openCart = () => { renderCartDialog(); $("cart-name").value = cart.name; $("cart-notes").value = cart.notes; dlg.showModal(); };
  $("cart-btn").addEventListener("click", openCart);
  $("cart-bar").addEventListener("click", openCart);
  $("cart-close").addEventListener("click", () => dlg.close());
  $("cart-continue").addEventListener("click", () => dlg.close());
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  $("cart-name").addEventListener("input", (e) => { cart.name = e.target.value; saveCart(); updateSendLink(); });
  $("cart-notes").addEventListener("input", (e) => { cart.notes = e.target.value; saveCart(); updateSendLink(); });
  $("cart-clear").addEventListener("click", () => {
    if (!confirm("¿Vaciar tu carrito? Se quitarán todos los productos.")) return;
    cart.items = {}; saveCart(); renderAll(); $("cart-continue").focus();
  });

  /* ---------- portada: anuncio y banners ---------- */
  const safeLink = (l) => {
    l = String(l || "").trim();
    if (!l) return "";
    if (l.startsWith("#") || /^https?:\/\//i.test(l)) return l;
    return "";
  };

  function renderAnnouncement() {
    const a = S.announcement || {}, el = $("announce");
    const text = String(a.text || "").trim();
    el.hidden = !text;
    if (!text) return;
    const link = safeLink(a.link);
    el.innerHTML = link ? `<a href="${esc(link)}"${link.startsWith("#") ? "" : ' target="_blank" rel="noopener"'}>${esc(text)}</a>` : esc(text);
  }

  let slideIdx = 0, timer = null, userPaused = false, hoverPaused = false;
  const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  function renderStage() {
    const host = $("stage-inner");
    const banners = (S.banners || []).filter((b) => b && (b.image || b.title)).slice(0, 8);
    if (!banners.length) {
      if (S.heroTitle || S.heroSubtitle) {
        host.innerHTML = `<div class="hero">${S.heroTitle ? `<h1>${esc(S.heroTitle)}</h1>` : ""}${S.heroSubtitle ? `<p>${esc(S.heroSubtitle)}</p>` : ""}</div>`;
      } else host.innerHTML = "";
      return;
    }
    const plain = !banners.some((b) => b.image);
    host.innerHTML = `
      <div class="carousel${plain ? " plain" : ""}" role="region" aria-roledescription="carrusel" aria-label="Destacados">
        <div class="slides" id="slides" aria-live="off">
          ${banners.map((b, i) => {
            const link = safeLink(b.link);
            const label = b.buttonText || "Ver más";
            return `<div class="slide${b.image ? " has-img" : ""}${i === 0 ? " on" : ""}" role="group" aria-roledescription="diapositiva" aria-label="${i + 1} de ${banners.length}"${i === 0 ? "" : " inert"}>
              ${b.image ? `<img src="${esc(b.image)}" alt="" ${i === 0 ? "" : 'loading="lazy"'}>` : ""}
              <div class="slide-body">
                ${b.title ? `<h2>${esc(b.title)}</h2>` : ""}
                ${b.subtitle ? `<p>${esc(b.subtitle)}</p>` : ""}
                ${link ? `<a class="slide-btn" href="${esc(link)}"${link.startsWith("#") ? "" : ' target="_blank" rel="noopener"'}>${esc(label)}</a>` : ""}
              </div></div>`;
          }).join("")}
        </div>
        ${banners.length > 1 ? `<div class="car-nav">
          <button type="button" id="car-prev" aria-label="Diapositiva anterior">‹</button>
          <button type="button" id="car-next" aria-label="Diapositiva siguiente">›</button>
          <div class="dots">${banners.map((_, i) => `<button type="button" data-dot="${i}" aria-label="Ir a la diapositiva ${i + 1}"${i === 0 ? ' aria-current="true"' : ""}></button>`).join("")}</div>
          <button type="button" id="car-pause" aria-label="Pausar el movimiento automático">❚❚</button>
        </div>` : ""}
      </div>`;
    slideIdx = 0;
    if (banners.length < 2) return;
    const car = host.querySelector(".carousel");
    const go = (i) => {
      const slides = [...car.querySelectorAll(".slide")];
      slideIdx = (i + slides.length) % slides.length;
      slides.forEach((s, k) => { s.classList.toggle("on", k === slideIdx); k === slideIdx ? s.removeAttribute("inert") : s.setAttribute("inert", ""); });
      car.querySelectorAll("[data-dot]").forEach((d, k) => k === slideIdx ? d.setAttribute("aria-current", "true") : d.removeAttribute("aria-current"));
    };
    const stop = () => { clearInterval(timer); timer = null; };
    const start = () => { stop(); if (!userPaused && !hoverPaused && !reduceMotion()) timer = setInterval(() => go(slideIdx + 1), 6500); };
    $("car-prev").addEventListener("click", () => go(slideIdx - 1));
    $("car-next").addEventListener("click", () => go(slideIdx + 1));
    car.querySelectorAll("[data-dot]").forEach((d) => d.addEventListener("click", () => go(Number(d.dataset.dot))));
    const pb = $("car-pause");
    if (reduceMotion()) { pb.hidden = true; }
    pb.addEventListener("click", () => {
      userPaused = !userPaused;
      pb.textContent = userPaused ? "▶" : "❚❚";
      pb.setAttribute("aria-label", userPaused ? "Reanudar el movimiento automático" : "Pausar el movimiento automático");
      start();
    });
    car.addEventListener("mouseenter", () => { hoverPaused = true; start(); });
    car.addEventListener("mouseleave", () => { hoverPaused = false; start(); });
    car.addEventListener("focusin", () => { hoverPaused = true; start(); });
    car.addEventListener("focusout", () => { hoverPaused = false; start(); });
    car.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft") go(slideIdx - 1); else if (e.key === "ArrowRight") go(slideIdx + 1);
    });
    start();
  }

  /* ---------- sitio ---------- */
  function applySite() {
    window.Theme.apply(S);
    document.title = S.storeName || document.title;
    $("brand").innerHTML = window.Theme.brandHTML(S);
    $("wa-header").href = `https://wa.me/${S.whatsapp}`;
    $("foot-wa").href = `https://wa.me/${S.whatsapp}`;
    $("foot-name").textContent = `© ${new Date().getFullYear()} ${S.storeName || ""}`.trim();
    if (S.logo) {
      let ic = document.querySelector('link[rel="icon"]');
      if (!ic) { ic = document.createElement("link"); ic.rel = "icon"; document.head.appendChild(ic); }
      ic.href = S.logo;
    }
    renderAnnouncement();
    renderStage();
  }

  function init(data) {
    state.products = data.products || [];
    if (data.updatedAt) {
      const d = new Date(data.updatedAt);
      $("updated").textContent = "Disponibilidad actualizada el " + d.toLocaleString(S.locale || "es-CO", { dateStyle: "long", timeStyle: "short" });
    }
    reconcile();
    applyHash(true);
    renderAll();
  }

  const getJson = (url) => fetch(url, { cache: "no-store" }).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });

  loadCart();
  Promise.all([getJson("site.json").catch(() => ({})), getJson("products.json")])
    .then(([site, data]) => { Object.assign(S, site); applySite(); init(data); })
    .catch(() => { applySite(); $("meta").textContent = "No pudimos cargar el catálogo. Intenta recargar la página."; })
    .finally(() => { document.body.style.visibility = "visible"; });
})();
