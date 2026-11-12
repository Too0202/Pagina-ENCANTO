// Tema de la tienda: paletas, tipos de letra y cálculo de colores. Lo usan la tienda y el panel.
(function () {
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function hex2rgb(h) {
    h = String(h || "#000000").replace("#", "");
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    const n = parseInt(h, 16) || 0;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgb2hex = (rgb) => "#" + rgb.map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, "0")).join("");
  const mix = (a, b, t) => { const A = hex2rgb(a), B = hex2rgb(b); return rgb2hex(A.map((v, i) => v + (B[i] - v) * t)); };
  function lum(hex) {
    const [r, g, b] = hex2rgb(hex).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  function contrast(a, b) { const la = lum(a), lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); }
  const inkOn = (bg) => (contrast(bg, "#ffffff") >= contrast(bg, "#111111") ? "#ffffff" : "#111111");

  // Acerca un color hacia otro hasta lograr el contraste pedido sobre un fondo.
  function ensureContrast(color, toward, bg, min) {
    let t = 0, c = color;
    while (contrast(c, bg) < min && t < 1) { t += 0.05; c = mix(color, toward, t); }
    return c;
  }

  const PALETTES = [
    { key: "ciruela", name: "Ciruela", accent: "#7a2e55", background: "#faf6f2", text: "#2a2327" },
    { key: "rosa", name: "Rosa", accent: "#c2417a", background: "#fff5f8", text: "#3b2430" },
    { key: "dorado", name: "Negro y dorado", accent: "#c9a24a", background: "#141414", text: "#f3ede0" },
    { key: "salvia", name: "Salvia", accent: "#4f7a63", background: "#f4f7f3", text: "#22302a" },
    { key: "azul", name: "Azul", accent: "#2f5fa8", background: "#f3f6fb", text: "#1c2733" },
    { key: "coral", name: "Coral", accent: "#d9482b", background: "#fff7f2", text: "#2d2420" },
  ];

  const FONTS = [
    { key: "clasica", name: "Clásica", head: 'Georgia, "Times New Roman", serif', body: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', google: "" },
    { key: "elegante", name: "Elegante", head: '"Playfair Display", Georgia, serif', body: '"Lato", system-ui, sans-serif', google: "family=Playfair+Display:wght@400;600&family=Lato:wght@400;700" },
    { key: "delicada", name: "Delicada", head: '"Cormorant Garamond", Georgia, serif', body: '"Nunito", system-ui, sans-serif', google: "family=Cormorant+Garamond:wght@500;600&family=Nunito:wght@400;700" },
    { key: "moderna", name: "Moderna", head: '"Poppins", system-ui, sans-serif', body: '"Poppins", system-ui, sans-serif', google: "family=Poppins:wght@400;600" },
    { key: "limpia", name: "Limpia", head: '"Montserrat", system-ui, sans-serif', body: '"Montserrat", system-ui, sans-serif', google: "family=Montserrat:wght@400;600" },
    { key: "redondeada", name: "Redondeada", head: '"Quicksand", system-ui, sans-serif', body: '"Quicksand", system-ui, sans-serif', google: "family=Quicksand:wght@400;600;700" },
  ];

  const VARS = ["--bg", "--surface", "--ink", "--muted", "--line", "--accent", "--accent-ink", "--accent-soft", "--accent-text", "--out", "--font-head", "--font-body"];

  function loadFonts(keys) {
    const parts = [...new Set(keys.map((k) => FONTS.find((f) => f.key === k)?.google).filter(Boolean))];
    if (!parts.length) return;
    const href = "https://fonts.googleapis.com/css2?" + parts.join("&") + "&display=swap";
    if (document.querySelector(`link[data-theme-fonts="${href}"]`)) return;
    const l = document.createElement("link");
    l.rel = "stylesheet"; l.href = href; l.setAttribute("data-theme-fonts", href);
    document.head.appendChild(l);
  }

  // Calcula todos los colores a partir de los tres que elige la persona.
  function derive(t) {
    const bg = t.background, ink = t.text, accent = t.accent;
    const dark = lum(bg) < 0.4;
    return {
      "--bg": bg,
      "--surface": dark ? mix(bg, "#ffffff", 0.07) : mix(bg, "#ffffff", 0.7),
      "--ink": ink,
      "--muted": ensureContrast(mix(ink, bg, 0.35), ink, bg, 4.5),
      "--line": mix(bg, ink, 0.15),
      "--accent": accent,
      "--accent-ink": inkOn(accent),
      "--accent-soft": mix(accent, bg, dark ? 0.78 : 0.86),
      "--accent-text": ensureContrast(accent, ink, bg, 4.5),
      "--out": ensureContrast(mix(ink, bg, 0.45), ink, bg, 3.2),
    };
  }

  function apply(site, el) {
    const root = el || document.documentElement;
    VARS.forEach((v) => root.style.removeProperty(v));
    const t = (site && site.theme) || { mode: "auto" };
    if (t.mode === "custom" && t.accent && t.background && t.text) {
      const vars = derive(t);
      Object.entries(vars).forEach(([k, v]) => root.style.setProperty(k, v));
    }
    const f = FONTS.find((x) => x.key === (site && site.font)) || FONTS[0];
    root.style.setProperty("--font-head", f.head);
    root.style.setProperty("--font-body", f.body);
    loadFonts([f.key]);
  }

  // Avisos de legibilidad para el panel.
  function warnings(t) {
    const out = [];
    if (!t || t.mode !== "custom") return out;
    if (contrast(t.text, t.background) < 4.5) out.push("El texto casi no se distingue del fondo. Elige un texto mucho más oscuro o más claro que el fondo.");
    if (contrast(t.accent, t.background) < 2) out.push("El color principal se parece demasiado al fondo y los botones se verían poco. Prueba con uno más fuerte.");
    return out;
  }

  // Parte de arriba de la tienda: logo y/o nombre según lo que se haya elegido.
  function brandHTML(site, logoSrc) {
    const name = (site && site.storeName) || "Mi tienda";
    const src = logoSrc || (site && site.logo) || "";
    const mode = site && site.brandMode || "name";
    const img = src ? `<img src="${esc(src)}" alt="${mode === "logo" ? esc(name) : ""}">` : "";
    if (mode === "logo" && src) return img;
    if (mode === "both" && src) return img + `<span>${esc(name)}</span>`;
    return `<span>${esc(name)}</span>`;
  }

  window.Theme = { PALETTES, FONTS, apply, derive, warnings, brandHTML, loadFonts, contrast };
})();
