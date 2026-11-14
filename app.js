(function () {
  const DEFAULTS = {
    storeName: "Mi tienda", logo: "", brandMode: "name",
    heroTitle: "", heroSubtitle: "", whatsapp: "", currency: "COP", locale: "es-CO",
    hideSoldOut: false, theme: { mode: "auto" }, font: "clasica",
    orderGreeting: "Hola, quiero hacer este pedido:",
    announcement: { text: "", link: "" }, banners: [],
    about: { title: "", text: "", image: "" }, social: {},
  };
  const S = { ...DEFAULTS };
  const $ = (id) => document.getElementById(id);
  const MAX_QTY = 99;
  const PAGE = 48;

  const state = { products: [], f: emptyFilters(), sort: "destacados", shown: PAGE };
  function emptyFilters() { return { c: "", s: "", b: [], min: "", max: "", q: "", a: false, t: "" }; }

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

  // Promociones y kits
  const onSale = (p) => Number(p.oldPrice) > Number(p.price) && Number(p.price) > 0;
  const discount = (p) => Math.round((1 - Number(p.price) / Number(p.oldPrice)) * 100);
  const includes = (p) => (Array.isArray(p.includes) ? p.includes : []).map((x) => String(x).trim()).filter(Boolean);
  function badgesFor(p, out) {
    const b = [];
    if (out) return [["out", "Agotado"]];
    if (onSale(p)) b.push(["sale", `−${discount(p)}%`]);
    if (p.kit) b.push(["kit", "Kit"]);
    if (p.badge === "nuevo") b.push(["new", "Nuevo"]); else if (p.badge === "top") b.push(["top", "Más vendido"]);
    const m = maxQty(p);
    if (m > 0 && m <= 5 && m < MAX_QTY) b.push(["low", `Últimas ${m}`]);
    return b.slice(0, 2);
  }
  const badgesHTML = (list) => list.length ? `<div class="badges">${list.map(([k, t]) => `<span class="badge b-${k}">${esc(t)}</span>`).join("")}</div>` : "";
  const priceHTML = (p, big) => `<div class="prices${big ? " big" : ""}"><span class="price">${money(p.price)}</span>${onSale(p) ? `<s class="old"><span class="sr-only">Antes </span>${money(p.oldPrice)}</s>` : ""}</div>`;
  const PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
  const monogram = () => (S.storeName || "•").trim().charAt(0).toUpperCase();
  const placeholder = () => `<span class="ph" aria-hidden="true">${S.logo ? `<img src="${esc(S.logo)}" alt="" onerror="this.replaceWith(document.createTextNode('${esc(monogram())}'))">` : `<b>${esc(monogram())}</b>`}<i>Foto próximamente</i></span>`;
  const mediaImg = (p, eager) => p.image ? `<img class="pimg" src="${esc(p.image)}" alt="" ${eager ? "" : 'loading="lazy" '}onload="this.classList.add('ld')" onerror="this.remove()">` : "";

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
    const control = out ? ""
      : q ? `<div class="step-over">${stepper(p, q, false)}</div>`
      : `<button class="add" type="button" data-act="add" data-id="${esc(p.id)}" aria-label="Agregar ${esc(p.name)} al carrito">${PLUS}</button>`;
    const inc = p.kit ? includes(p) : [];
    return `
      <article class="card${out ? " out" : ""}${p.image ? "" : " nophoto"}">
        <div class="media">
          ${placeholder()}${mediaImg(p)}
          <button class="open" type="button" data-open="${esc(p.id)}" aria-label="Ver ${esc(p.name)}"></button>
          ${badgesHTML(badgesFor(p, out))}
          ${control}
        </div>
        <div class="body">
          <span class="cat">${esc([p.brand, p.subcategory || p.category].filter(Boolean).join(" · "))}</span>
          <h3 class="name"><button type="button" class="namebtn" data-open="${esc(p.id)}">${esc(p.name)}</button></h3>
          ${inc.length ? `<span class="inc">Incluye ${esc(inc.slice(0, 3).join(", "))}${inc.length > 3 ? "…" : ""}</span>` : ""}
          ${priceHTML(p)}
        </div>
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
    if (f.t === "promo" && !onSale(p)) return false;
    if (f.t === "kit" && !p.kit) return false;
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
    const nPromo = base.filter((p) => onSale(p) && isAvailable(p)).length, nKit = base.filter((p) => p.kit && isAvailable(p)).length;
    if (nPromo || nKit || f.t) {
      h += `<div class="fgroup"><h3>Especiales</h3><ul class="flist">
        <li><button type="button" class="fopt${!f.t ? " on" : ""}" data-fk="t-all" data-set-t="" aria-pressed="${!f.t}">Todo</button></li>
        ${nPromo ? `<li><button type="button" class="fopt${f.t === "promo" ? " on" : ""}" data-fk="t-promo" data-set-t="promo" aria-pressed="${f.t === "promo"}">Promociones <span>${nPromo}</span></button></li>` : ""}
        ${nKit ? `<li><button type="button" class="fopt${f.t === "kit" ? " on" : ""}" data-fk="t-kit" data-set-t="kit" aria-pressed="${f.t === "kit"}">Kits <span>${nKit}</span></button></li>` : ""}
      </ul></div>`;
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
    if (f.t) t.push(["t", f.t === "promo" ? "Promociones" : "Kits"]);
    if (f.q) t.push(["q", `“${f.q}”`]);
    return t;
  }

  function renderGrid() {
    const all = sorted(visible());
    const list = all.slice(0, state.shown);
    $("grid").innerHTML = list.map(card).join("");
    renderHighlights();
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
    if (f.t) p.push("t=" + f.t);
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
      else if (k === "t") f.t = v === "promo" || v === "kit" ? v : "";
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
    if (scroll && /=/.test(location.hash)) goCatalog();
  }
  window.addEventListener("hashchange", () => { if (!fromUs && (/=/.test(location.hash) || location.hash.length <= 1)) applyHash(true); });
  function goCatalog() {
    const el = $("catalogo");
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  }

  function onFilterClick(e) {
    const t = e.target;
    const cb = t.closest("button[data-set-c]");
    if (cb) { state.f.c = cb.dataset.setC; state.f.s = cb.dataset.setS || ""; commitFilters(); return; }
    const tb = t.closest("button[data-set-t]");
    if (tb) { state.f.t = tb.dataset.setT; commitFilters(); }
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
    else if (k === "t") f.t = "";
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
  let lastUnits = null;
  function renderBar() {
    const n = units();
    $("cart-count").textContent = n;
    $("cart-count").setAttribute("aria-label", `${plural(n, "producto", "productos")} en el carrito`);
    $("cart-bar").hidden = n === 0;
    document.body.classList.toggle("has-bar", n > 0);
    if (lastUnits !== null && n > lastUnits) { const c = $("cart-count"); c.classList.remove("bump"); void c.offsetWidth; c.classList.add("bump"); }
    lastUnits = n;
    $("bar-text").textContent = `${plural(n, "producto", "productos")} · ${money(total())}`;
  }
  function renderAll(focus) {
    renderGrid(); renderBar(); renderCartDialog();
    if (pd.open && byId(pdId)) renderDetailInfo(byId(pdId));
    if (focus && focus.id) {
      const root = dlg.open ? dlg : pd.open ? pd : $("grid");
      const el = root.querySelector(`[data-id="${CSS.escape(focus.id)}"][data-act="${focus.act}"]`)
        || root.querySelector(`[data-id="${CSS.escape(focus.id)}"]:not([disabled])`);
      if (el) el.focus();
      else if (dlg.open) (units() ? $("cart-send") : $("cart-continue")).focus();
    }
  }
  function onAction(e) {
    const o = e.target.closest("[data-open]");
    if (o) { openDetail(o.dataset.open); return; }
    const tl = e.target.closest("[data-set-t-link]");
    if (tl) { state.f = emptyFilters(); state.f.t = tl.dataset.setTLink; $("q").value = ""; commitFilters(); goCatalog(); return; }
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    const id = b.dataset.id, q = cart.items[id] || 0;
    if (b.dataset.act === "add") { setQty(id, 1, "inc"); toast(`${byId(id)?.name || "Producto"} agregado al carrito`); }
    else if (b.dataset.act === "inc") setQty(id, q + 1, "inc");
    else if (b.dataset.act === "dec") setQty(id, q - 1, q - 1 > 0 ? "dec" : "add");
    else if (b.dataset.act === "remove") setQty(id, 0, "add");
  }
  $("grid").addEventListener("click", onAction);
  $("highlights").addEventListener("click", onAction);
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


  /* ---------- avisos breves ---------- */
  let toastTimer;
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg; t.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("on"), 2200);
  }

  /* ---------- promociones, kits y categorías destacadas ---------- */
  function renderHighlights() {
    const host = $("highlights");
    if (activeTags().length || state.sort !== "destacados") { host.innerHTML = ""; return; }
    const base = baseProducts().filter(isAvailable);
    const strip = (title, list, t) => list.length
      ? `<section class="strip" aria-label="${title}"><div class="strip-head"><h2>${title}</h2><button class="link" type="button" data-set-t-link="${t}">Ver todo</button></div><div class="strip-row">${list.slice(0, 12).map(card).join("")}</div></section>` : "";
    host.innerHTML = strip("Promociones", base.filter((p) => onSale(p) && !p.kit), "promo") + strip("Kits", base.filter((p) => p.kit), "kit");
  }

  function renderQuick() {
    const cats = new Map();
    baseProducts().forEach((p) => { if (p.category) cats.set(p.category, (cats.get(p.category) || 0) + 1); });
    const top = [...cats].sort((a, b) => b[1] - a[1]).slice(0, 5);
    const el = $("quick");
    el.hidden = top.length < 2;
    el.innerHTML = top.map(([c, n]) => `<a class="qtile" href="#c=${encodeURIComponent(c)}"><span class="q-name">${esc(c)}</span><span class="q-n">${plural(n, "producto", "productos")}</span><span class="q-go" aria-hidden="true">→</span></a>`).join("");
  }

  /* ---------- detalle del producto con foto ampliable ---------- */
  const pd = $("pd");
  let pdId = null;
  const waLink = (text) => `https://wa.me/${S.whatsapp}${text ? "?text=" + encodeURIComponent(text) : ""}`;

  function renderDetailInfo(p) {
    const out = !isAvailable(p), q = cart.items[p.id] || 0;
    const inc = p.kit ? includes(p) : [];
    const where = [p.brand, p.category, p.subcategory].filter(Boolean).join(" · ");
    $("pd-info").innerHTML = `
      ${where ? `<p class="pd-cat">${esc(where)}</p>` : ""}
      <h2 id="pd-name">${esc(p.name)}</h2>
      ${priceHTML(p, true)}
      ${badgesHTML(badgesFor(p, out))}
      ${p.description ? `<div class="pd-desc">${String(p.description).split(/\n+/).filter((x) => x.trim()).map((x) => `<p>${esc(x)}</p>`).join("")}</div>` : ""}
      ${inc.length ? `<h3 class="pd-sub">Este kit incluye</h3><ul class="pd-inc">${inc.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
      <div class="pd-actions">
        ${out ? '<span class="btn" role="button" aria-disabled="true">No disponible por ahora</span>'
          : q ? stepper(p, q, false)
          : `<button class="btn" type="button" data-act="add" data-id="${esc(p.id)}">Agregar al carrito</button>`}
        <a class="btn btn-ghost" target="_blank" rel="noopener" href="${esc(waLink(`Hola, quiero que me asesoren con: ${p.name}`))}">Asesórame sobre este producto</a>
      </div>`;
  }

  function openDetail(id) {
    const p = byId(id);
    if (!p) return;
    pdId = id;
    $("pd-media").innerHTML = p.image
      ? `<button type="button" class="zoomwrap" id="zoom" aria-pressed="false" aria-label="Ampliar la foto">${placeholder()}<img class="pimg ld" src="${esc(p.image)}" alt="${esc(p.name)}" onerror="this.remove()"><span class="zoom-hint" aria-hidden="true">Toca para ampliar</span></button>`
      : `<div class="zoomwrap static nophoto">${placeholder()}</div>`;
    const z = $("zoom");
    if (z) {
      const set = (on) => { z.classList.toggle("zoomed", on); z.setAttribute("aria-pressed", String(on)); z.setAttribute("aria-label", on ? "Reducir la foto" : "Ampliar la foto"); };
      z.addEventListener("click", (e) => { move(e); set(!z.classList.contains("zoomed")); });
      const move = (e) => { const r = z.getBoundingClientRect(); z.style.setProperty("--ox", ((e.clientX - r.left) / r.width * 100).toFixed(1) + "%"); z.style.setProperty("--oy", ((e.clientY - r.top) / r.height * 100).toFixed(1) + "%"); };
      z.addEventListener("pointermove", (e) => { if (z.classList.contains("zoomed")) move(e); });
    }
    renderDetailInfo(p);
    $("pd-info").scrollTop = 0;
    if (!pd.open) pd.showModal();
  }
  pd.addEventListener("click", (e) => { if (e.target === pd) pd.close(); else onAction(e); });
  $("pd-close").addEventListener("click", () => pd.close());
  pd.addEventListener("close", () => { pdId = null; });

  /* ---------- Quiénes somos, redes y WhatsApp ---------- */
  const httpLink = (l) => { l = String(l || "").trim(); return /^https?:\/\/\S+$/i.test(l) ? l : ""; };
  const ICONS = {
    instagram: '<rect x="3.5" y="3.5" width="17" height="17" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.2" cy="6.8" r=".6" fill="currentColor"/>',
    facebook: '<path d="M14 21v-8h2.8l.5-3.2H14V7.9c0-.9.4-1.5 1.6-1.5h1.8V3.5c-.4 0-1.4-.2-2.5-.2-2.6 0-4.1 1.5-4.1 4.2v2.3H8V13h2.8v8z"/>',
    tiktok: '<path d="M14.5 4v10.2a3.6 3.6 0 1 1-3.6-3.6"/><path d="M14.5 4c.3 2.3 1.9 3.9 4.5 4.1"/>',
    youtube: '<rect x="3" y="6" width="18" height="12" rx="4"/><path d="M10.5 9.6v4.8l4.2-2.4z"/>',
    whatsapp: '<path d="M3.5 20.5l1.3-4.2A8.5 8.5 0 1 1 8 19.2z"/><path d="M9.2 8.8c.2 2.2 2.4 4.6 5 5.4l1.2-1.2-1.9-1-.8.8c-.8-.4-1.7-1.3-2.1-2.1l.8-.8-1-1.9z"/>',
  };
  const NAMES = { instagram: "Instagram", facebook: "Facebook", tiktok: "TikTok", youtube: "YouTube", whatsapp: "WhatsApp" };
  function renderSocial() {
    const soc = S.social || {};
    const list = ["instagram", "facebook", "tiktok", "youtube"].map((k) => [k, httpLink(soc[k])]).filter(([, u]) => u);
    if (S.whatsapp) list.push(["whatsapp", waLink("")]);
    $("social").innerHTML = list.map(([k, u]) => `<li><a href="${esc(u)}" target="_blank" rel="noopener" aria-label="${NAMES[k]}"><svg viewBox="0 0 24 24" fill="${k === "facebook" ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[k]}</svg><span class="sr-only">${NAMES[k]}</span></a></li>`).join("");
  }
  function renderAbout() {
    const a = S.about || {}, text = String(a.text || "").trim();
    $("nosotros").hidden = !text; $("nav-about").hidden = !text;
    if (!text) return;
    $("about-title").textContent = String(a.title || "").trim() || "Quiénes somos";
    $("about-body").innerHTML = text.split(/\n+/).map((x) => x.trim()).filter(Boolean).map((x) => `<p>${esc(x)}</p>`).join("");
    const im = $("about-img");
    im.hidden = !a.image;
    im.innerHTML = a.image ? `<img src="${esc(a.image)}" alt="" loading="lazy">` : "";
    $("nosotros").classList.toggle("no-img", !a.image);
  }

  const skeletons = () => Array.from({ length: 8 }, () => '<div class="card sk" aria-hidden="true"><div class="media"></div><div class="body"><span class="sk-l"></span><span class="sk-l s"></span></div></div>').join("");

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
    const ask = waLink("Hola, quiero que me asesoren.");
    $("wa-header").href = ask; $("wa-float").href = ask; $("about-wa").href = ask;
    renderSocial(); renderAbout();
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
    renderQuick();
    applyHash(true);
    renderAll();
  }

  const getJson = (url) => fetch(url, { cache: "no-store" }).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });

  loadCart();
  window.addEventListener("scroll", () => document.querySelector(".top").classList.toggle("scrolled", scrollY > 4), { passive: true });
  const siteP = getJson("site.json").catch(() => ({}));
  const prodP = getJson("products.json");
  siteP.then((site) => { Object.assign(S, site); applySite(); $("grid").innerHTML = skeletons(); document.body.style.visibility = "visible"; });
  Promise.all([siteP, prodP]).then(([, data]) => init(data))
    .catch(() => { applySite(); $("grid").innerHTML = ""; $("meta").textContent = "No pudimos cargar el catálogo. Intenta recargar la página."; document.body.style.visibility = "visible"; });
})();
