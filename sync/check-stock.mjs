#!/usr/bin/env node
// Revisa la página de cada producto en el proveedor y actualiza "available" en products.json.
// Uso: node sync/check-stock.mjs [ruta/a/products.json]
// Requiere Node 18 o superior. No tiene dependencias.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const productsPath = process.argv[2] || path.join(here, "..", "products.json");
const config = JSON.parse(await readFile(path.join(here, "sync.config.json"), "utf8"));

const OUT_SCHEMA = /(outofstock|soldout|discontinued)/i;
const IN_SCHEMA = /(instock|limitedavailability|preorder|onlineonly|instoreonly)/i;

const stripTags = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Busca "availability" dentro de los datos estructurados (JSON-LD) que usan casi todas las tiendas.
function availabilityFromJsonLd(html) {
  const found = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      walk(JSON.parse(m[1].trim()));
    } catch { /* JSON-LD mal formado: se ignora */ }
  }
  function walk(node) {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    if (typeof node.availability === "string") found.push(node.availability);
    Object.values(node).forEach(walk);
  }
  if (!found.length) return null;
  if (found.some((a) => IN_SCHEMA.test(a))) return true;
  if (found.every((a) => OUT_SCHEMA.test(a))) return false;
  return null;
}

function availabilityFromMeta(html) {
  const m = html.match(/<meta[^>]+(?:property|name)=["'](?:og:availability|product:availability)["'][^>]+content=["']([^"']+)["']/i)
        || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:availability|product:availability)["']/i);
  if (!m) return null;
  const v = m[1].toLowerCase().replace(/[\s_-]/g, "");
  if (OUT_SCHEMA.test(v)) return false;
  if (IN_SCHEMA.test(v)) return true;
  return null;
}

// Devuelve { available: true|false|null, reason }. null = no se pudo saber (se conserva el estado anterior).
export function judge(res, html) {
  if (res.status === 404 || res.status === 410) return { available: false, reason: `HTTP ${res.status}` };
  if (res.status >= 400) return { available: null, reason: `HTTP ${res.status} (se conserva el estado anterior)` };

  // Si el producto fue retirado, muchas tiendas redirigen al inicio.
  const finalPath = new URL(res.url).pathname.replace(/\/+$/, "") || "/";
  if (res.redirected && finalPath === "/") return { available: false, reason: "redirige al inicio" };

  const ld = availabilityFromJsonLd(html);
  if (ld !== null) return { available: ld, reason: "datos estructurados" };

  const meta = availabilityFromMeta(html);
  if (meta !== null) return { available: meta, reason: "meta availability" };

  const text = stripTags(html);
  if (config.soldOutPhrases.some((p) => text.includes(p.toLowerCase())))
    return { available: false, reason: "texto de agotado" };
  if (config.inStockPhrases.some((p) => text.includes(p.toLowerCase())))
    return { available: true, reason: "botón de compra presente" };

  return { available: null, reason: "no se pudo determinar (se conserva el estado anterior)" };
}

async function fetchPage(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), config.timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "user-agent": config.userAgent, "accept-language": "es-CO,es;q=0.9" },
    });
    const html = await res.text();
    return { res, html };
  } finally {
    clearTimeout(t);
  }
}

// ---------- Modo catálogo ----------
// Para proveedores sin página individual por producto: se busca el producto por su nombre
// (campo "supplierName" en products.json) dentro de las páginas de listado (config.catalogUrls).

const norm = (s) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

// Divide el HTML en "tarjetas" (class="card ...", típico de Bootstrap) y devuelve el texto de cada una.
function splitCards(html) {
  const parts = html.split(/<div[^>]+class=["'][^"']*\bcard\b(?!-)[^"']*["'][^>]*>/i);
  return parts.slice(1).map((chunk) => norm(stripTags(chunk)));
}

async function loadCatalog() {
  const urls = config.catalogUrls || [];
  const cat = { cards: [], text: "", okPages: 0, totalPages: urls.length };
  const texts = [];
  for (const url of urls) {
    try {
      const { res, html } = await fetchPage(url);
      if (res.status >= 400) {
        console.log(`Catálogo ${url}: HTTP ${res.status} (se ignora esta vez)`);
      } else {
        cat.okPages++;
        texts.push(norm(stripTags(html)));
        cat.cards.push(...splitCards(html));
      }
    } catch (err) {
      console.log(`Catálogo ${url}: ${err.name === "AbortError" ? "tiempo agotado" : err.message}`);
    }
    await sleep(config.delayMs);
  }
  cat.text = texts.join(" ");
  return cat;
}

function findInCatalog(p, cat) {
  const name = norm(p.supplierName);
  const card = cat.cards.find((c) => c.includes(name));
  let scope = card;
  if (scope === undefined) {
    // Sin tarjetas detectadas: se mira un pedazo de texto alrededor del nombre.
    const i = cat.text.indexOf(name);
    if (i < 0) return { found: false };
    scope = cat.text.slice(Math.max(0, i - 60), i + name.length + 160);
  }
  const soldOut = config.soldOutPhrases.some((ph) => scope.includes(norm(ph)));
  return soldOut
    ? { found: true, available: false, reason: "tarjeta con etiqueta de agotado" }
    : { found: true, available: true, reason: "aparece en el catálogo" };
}

async function main() {
  const data = JSON.parse(await readFile(productsPath, "utf8"));
  const now = new Date().toISOString();
  let changed = 0;
  let dirty = false;

  const wantCatalog = data.products.some((p) => p.supplierName);
  let cat = null;
  let anyFound = false;
  if (wantCatalog) {
    if (!(config.catalogUrls || []).length) {
      console.log("Aviso: hay productos con supplierName pero sync.config.json no tiene catalogUrls.\n");
    } else {
      cat = await loadCatalog();
      anyFound = data.products.some((p) => p.supplierName && findInCatalog(p, cat).found);
    }
  }
  const needed = config.missesToMarkSoldOut ?? 2;

  for (const p of data.products) {
    if (!p.supplierUrl && !p.supplierName) continue;
    let verdict;
    if (p.supplierName) {
      if (!cat || cat.okPages === 0) {
        verdict = { available: null, reason: "no se pudo leer el catálogo (se conserva el estado anterior)" };
      } else {
        const r = findInCatalog(p, cat);
        if (r.found) {
          if (p.missCount) { delete p.missCount; dirty = true; }
          verdict = r;
        } else if (cat.okPages < cat.totalPages) {
          verdict = { available: null, reason: "falta una página del catálogo; no se puede asegurar que ya no esté" };
        } else if (!anyFound) {
          verdict = { available: null, reason: "ningún producto aparece en el catálogo: ¿la página cambió o carga con JavaScript?" };
        } else {
          p.missCount = (p.missCount || 0) + 1;
          dirty = true;
          verdict = p.missCount >= needed
            ? { available: false, reason: "ya no aparece en el catálogo" }
            : { available: null, reason: `no apareció en el catálogo (aviso ${p.missCount} de ${needed})` };
        }
      }
    } else {
      try {
        const { res, html } = await fetchPage(p.supplierUrl);
        verdict = judge(res, html);
      } catch (err) {
        verdict = { available: null, reason: `error de red: ${err.name === "AbortError" ? "tiempo agotado" : err.message}` };
      }
    }

    const before = p.available;
    if (verdict.available !== null) {
      p.available = verdict.available;
      p.lastChecked = now;
    }
    const mark = verdict.available === null ? "??" : verdict.available ? "OK" : "AGOTADO";
    const flip = verdict.available !== null && before !== p.available ? "  <- CAMBIÓ" : "";
    if (flip) changed++;
    console.log(`[${mark.padEnd(7)}] ${p.name} — ${verdict.reason}${flip}`);
    if (!p.supplierName) await sleep(config.delayMs);
  }

  // Solo se reescribe el archivo si algo cambió, para no llenar el historial de commits vacíos.
  if (changed > 0 || dirty) {
    if (changed > 0) data.updatedAt = now;
    await writeFile(productsPath, JSON.stringify(data, null, 2) + "\n");
  }
  console.log(`\nListo. Productos que cambiaron: ${changed}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
