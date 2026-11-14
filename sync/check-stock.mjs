#!/usr/bin/env node
// Lee el catálogo del proveedor (una dirección JSON por categoría), guarda una copia en
// data/supplier-catalog.json y actualiza "available" de cada producto de products.json.
//
// Uso: node sync/check-stock.mjs [products.json] [data/supplier-catalog.json]
// Requiere Node 18 o superior. No tiene dependencias.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const productsPath = process.argv[2] || path.join(root, "products.json");
const catalogPath = process.argv[3] || path.join(root, "data", "supplier-catalog.json");
const configPath = process.env.SYNC_CONFIG || path.join(here, "sync.config.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = async (p, fallback) => {
  try { return JSON.parse(await readFile(p, "utf8")); } catch (e) { if (e.code === "ENOENT") return fallback; throw e; }
};
const flag = (v) => v === true || v === 1 || String(v).trim().toLowerCase() === "1" || String(v).trim().toLowerCase() === "true";

// Convierte un producto tal como lo entrega el proveedor a lo mínimo que necesitamos.
export function normalize(raw, categoryId) {
  const q = raw.quantity === null || raw.quantity === undefined || String(raw.quantity).trim() === "" ? null : Number(raw.quantity);
  const price = raw.price === null || raw.price === undefined || String(raw.price).trim() === "" ? null : Number(raw.price);
  return {
    id: String(raw.product_id),
    name: String(raw.name ?? "").trim(),
    category: String(raw.category_id ?? categoryId),
    categoryName: raw.category_name ? String(raw.category_name) : null,
    quantity: Number.isFinite(q) ? q : null,
    inactive: flag(raw.product_inactive),
    deleted: flag(raw.deleted),
    price: Number.isFinite(price) ? price : null,
    image: raw.product_image_name ? String(raw.product_image_name) : null,
  };
}

// Regla de disponibilidad. Devuelve { available, reason }.
export function judge(item, cfg) {
  if (item.deleted) return { available: false, reason: "eliminado en el proveedor" };
  if (item.inactive) return { available: false, reason: "desactivado en el proveedor" };
  const t = cfg.soldOutWhenQuantityAtOrBelow;
  if (t !== null && t !== undefined && item.quantity !== null && item.quantity <= t)
    return { available: false, reason: `sin existencias (cantidad ${item.quantity})` };
  return { available: true, reason: "disponible en el proveedor" };
}

// Stock propio: unidades que tú tienes. Si hay, el producto se vende aunque el proveedor lo oculte o lo quite.
export const myStock = (p) => { const n = Math.floor(Number(p.stock)); return Number.isFinite(n) && n > 0 ? n : 0; };
export const effective = (p) => myStock(p) > 0 || p.supplierAvailable !== false;

async function getJson(url, cfg) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? 20000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        accept: "application/json, text/plain, */*",
        "x-requested-with": "XMLHttpRequest",
        "user-agent": "Mozilla/5.0 (compatible; RevisorDeStock/2.0)",
        "accept-language": "es-CO,es;q=0.9",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error("la respuesta no es una lista de productos");
    return data;
  } finally {
    clearTimeout(t);
  }
}

async function fetchCategory(cat, cfg) {
  const size = cfg.supplier.pageSize ?? 800;
  const items = [];
  for (let page = 0; page < (cfg.supplier.maxPages ?? 20); page++) {
    const url = cfg.supplier.loadMoreUrl
      .replace("{id}", encodeURIComponent(cat.id))
      .replace("{limit}", size)
      .replace("{offset}", page * size);
    const rows = await getJson(url, cfg);
    items.push(...rows.map((r) => normalize(r, cat.id)));
    if (rows.length < size) break;
    await sleep(cfg.delayMs ?? 1000);
  }
  return items;
}

async function main() {
  const cfg = await readJson(configPath, null);
  if (!cfg) throw new Error(`No encontré ${configPath}`);
  const data = await readJson(productsPath, { products: [] });
  const prev = await readJson(catalogPath, { categories: [], products: [] });
  const now = new Date().toISOString();
  const categories = cfg.categories || [];

  // 1) Leer cada categoría del proveedor. Si una falla se conserva lo que ya se sabía de ella.
  const snapshot = { fetchedAt: now, categories: [], products: [] };
  let okCount = 0;
  for (const cat of categories) {
    try {
      const items = await fetchCategory(cat, cfg);
      okCount++;
      snapshot.categories.push({ id: String(cat.id), name: cat.name || items[0]?.categoryName || null, ok: true, count: items.length });
      snapshot.products.push(...items);
      console.log(`Categoría ${cat.id} (${cat.name || "sin nombre"}): ${items.length} productos`);
    } catch (err) {
      const msg = err.name === "AbortError" ? "tiempo agotado" : err.message;
      console.log(`Categoría ${cat.id} (${cat.name || "sin nombre"}): NO se pudo leer (${msg}). Se conserva lo anterior.`);
      const old = prev.categories.find((c) => String(c.id) === String(cat.id));
      snapshot.categories.push({ id: String(cat.id), name: cat.name || old?.name || null, ok: false, count: old?.count ?? 0 });
      snapshot.products.push(...prev.products.filter((p) => p.category === String(cat.id)));
    }
    await sleep(cfg.delayMs ?? 1000);
  }

  const allOk = categories.length > 0 && okCount === categories.length;
  const byId = new Map(snapshot.products.map((p) => [p.id, p]));
  const freshIds = new Set(); // solo lo leído en esta corrida
  if (okCount) {
    // los productos de categorías leídas bien en esta corrida
    for (const c of snapshot.categories.filter((c) => c.ok)) {
      snapshot.products.filter((p) => p.category === c.id).forEach((p) => freshIds.add(p.id));
    }
  }

  // 2) Actualizar mis productos.
  const needed = cfg.missesToMarkSoldOut ?? 2;
  let changed = 0;
  let dirty = false;
  for (const p of data.products) {
    if (!p.supplierId) continue;
    // Productos creados antes del stock propio: lo que había en "available" era lo que decía el proveedor.
    if (p.supplierAvailable === undefined) { p.supplierAvailable = p.available !== false; dirty = true; }
    const item = byId.get(String(p.supplierId));
    let verdict;
    if (item && freshIds.has(item.id)) {
      if (p.missCount) { delete p.missCount; dirty = true; }
      verdict = judge(item, cfg);
    } else if (item) {
      verdict = { available: null, reason: "su categoría no se pudo leer hoy (se conserva el estado anterior)" };
    } else if (!allOk || snapshot.products.length === 0) {
      verdict = { available: null, reason: "no se pudo leer todo el catálogo; no se puede asegurar que ya no esté" };
    } else {
      p.missCount = (p.missCount || 0) + 1;
      dirty = true;
      verdict = p.missCount >= needed
        ? { available: false, reason: "ya no aparece en el catálogo del proveedor" }
        : { available: null, reason: `no apareció en el catálogo (aviso ${p.missCount} de ${needed})` };
    }

    // "supplierAvailable" es lo que dice el proveedor. "available" es lo que se muestra en tu tienda:
    // sigue a la venta si tienes stock propio, aunque el proveedor lo haya ocultado o quitado.
    const beforeSup = p.supplierAvailable, beforeEff = p.available;
    if (verdict.available !== null) { p.supplierAvailable = verdict.available; p.lastChecked = now; }
    p.available = effective(p);
    const flip = beforeSup !== p.supplierAvailable || beforeEff !== p.available;
    if (flip) changed++;
    const mark = verdict.available === null ? "??" : p.available ? "OK" : "AGOTADO";
    const own = myStock(p);
    const note = verdict.available === false && own > 0 ? ` — pero tienes ${own} en stock propio, sigue a la venta` : "";
    console.log(`[${mark.padEnd(7)}] ${p.name} — ${verdict.reason}${note}${flip ? "  <- CAMBIÓ" : ""}`);
  }

  // 3) Guardar solo si algo cambió (evita commits vacíos).
  const strip = (s) => JSON.stringify({ ...s, fetchedAt: null });
  if (okCount > 0 && strip(snapshot) !== strip(prev)) {
    await mkdir(path.dirname(catalogPath), { recursive: true });
    await writeFile(catalogPath, JSON.stringify(snapshot) + "\n");
    console.log("Catálogo del proveedor actualizado.");
  }
  if (changed > 0 || dirty) {
    if (changed > 0) data.updatedAt = now;
    await writeFile(productsPath, JSON.stringify(data, null, 2) + "\n");
  }
  console.log(`\nListo. Productos que cambiaron: ${changed}`);

  if (categories.length > 0 && okCount === 0) {
    console.error("No se pudo leer ninguna categoría del proveedor.");
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
