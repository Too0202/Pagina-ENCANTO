(function () {
  const S = window.SITE || {};
  const $ = (id) => document.getElementById(id);
  const state = { products: [], cat: "Todos", q: "" };

  const money = (n) =>
    new Intl.NumberFormat(S.locale || "es-CO", {
      style: "currency", currency: S.currency || "COP", maximumFractionDigits: 0,
    }).format(n);

  const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function waLink(p) {
    const msg = `Hola, quiero pedir: ${p.name} (${money(p.price)})`;
    return `https://wa.me/${S.whatsapp}?text=${encodeURIComponent(msg)}`;
  }

  function card(p) {
    const out = p.available === false;
    const media = p.image
      ? `<img src="${esc(p.image)}" alt="${esc(p.name)}" loading="lazy">`
      : `<span class="ph" aria-hidden="true">${esc(p.name.trim().charAt(0).toUpperCase())}</span>`;
    const action = out
      ? `<span class="btn" role="button" aria-disabled="true">No disponible por ahora</span>`
      : `<a class="btn" href="${esc(waLink(p))}" target="_blank" rel="noopener">Pedir por WhatsApp</a>`;
    return `
      <article class="card${out ? " out" : ""}">
        <div class="media">${media}${out ? '<span class="badge">Agotado</span>' : ""}</div>
        <div class="body">
          <span class="cat">${esc(p.category)}</span>
          <h2 class="name">${esc(p.name)}</h2>
          <span class="price">${money(p.price)}</span>
        </div>
        <div class="actions">${action}</div>
      </article>`;
  }

  function visible() {
    const q = norm(state.q);
    return state.products.filter((p) => {
      if (p.hidden) return false;
      if (S.hideSoldOut && p.available === false) return false;
      if (state.cat !== "Todos" && p.category !== state.cat) return false;
      if (q && !norm(p.name + " " + p.category).includes(q)) return false;
      return true;
    });
  }

  function render() {
    const list = visible();
    $("grid").innerHTML = list.map(card).join("");
    $("empty").hidden = list.length > 0;
    $("meta").textContent = list.length ? `${list.length} producto${list.length === 1 ? "" : "s"}` : "";
  }

  function renderChips() {
    const base = state.products.filter((p) => !p.hidden && !(S.hideSoldOut && p.available === false));
    const cats = ["Todos", ...new Set(base.map((p) => p.category).filter(Boolean))];
    $("chips").innerHTML = cats
      .map((c) => `<button type="button" class="chip" aria-pressed="${c === state.cat}" data-cat="${esc(c)}">${esc(c)}</button>`)
      .join("");
  }

  function init(data) {
    state.products = data.products || [];
    document.title = S.storeName || document.title;
    $("brand").textContent = S.storeName || "Tienda";
    $("hero-title").textContent = S.heroTitle || "";
    $("hero-sub").textContent = S.heroSubtitle || "";
    $("wa-header").href = `https://wa.me/${S.whatsapp}`;
    if (data.updatedAt) {
      const d = new Date(data.updatedAt);
      $("updated").textContent = "Disponibilidad actualizada el " +
        d.toLocaleString(S.locale || "es-CO", { dateStyle: "long", timeStyle: "short" });
    }
    renderChips();
    render();
  }

  $("chips").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-cat]");
    if (!b) return;
    state.cat = b.dataset.cat;
    renderChips();
    render();
  });
  $("q").addEventListener("input", (e) => { state.q = e.target.value; render(); });
  $("clear").addEventListener("click", () => {
    state.q = ""; state.cat = "Todos"; $("q").value = "";
    renderChips(); render();
  });

  fetch("products.json", { cache: "no-store" })
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(init)
    .catch(() => {
      $("meta").textContent = "No pudimos cargar el catálogo. Intenta recargar la página.";
    });
})();
