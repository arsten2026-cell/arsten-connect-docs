import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import type { Transmittal } from "./model";

const hex = (h: string) => rgb(parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255);
// Arsten tokens (arsten-style/tokens.json)
const INK = hex("161616"), SOFT = hex("5A5A56"), MUTED = hex("8A8A86"), LINE = hex("E4E2DD"), ACCENT = hex("E37424"), BG = hex("FBFAF8");
const MM = 72 / 25.4;
const COMPANY = {
  legal: "„АРСТЕН“ ООД · ARSTEN Ltd.",
  address: "гр. Пловдив 4000, бул. „Цар Борис III Обединител“ № 179",
  contact: "+359 888 253 995 · info@arsten-bg.com · arsten-bg.com",
};

const PURPOSE_BG: Record<string, string> = {
  "For approval": "За съгласуване",
  "For construction": "За строителство",
  "For information": "За информация",
  "For tender": "За търг",
};

async function asset(path: string) {
  const r = await fetch(new URL(path, document.baseURI).href);
  if (!r.ok) throw new Error(`Cannot load ${path}`);
  return r.arrayBuffer();
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? cur + " " + w : w;
    if (font.widthOfTextAtSize(next, size) > width && cur) { lines.push(cur); cur = w; } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

/** A4 transmittal sheet in the Arsten house style. Returns PDF bytes. */
export async function transmittalPdf(tr: Transmittal, projectName: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const [light, reg, med, logoBytes] = await Promise.all([
    asset("fonts/Ubuntu-Light.ttf"), asset("fonts/Ubuntu-Regular.ttf"), asset("fonts/Ubuntu-Medium.ttf"), asset("arsten-logo.png"),
  ]);
  const fLight = await doc.embedFont(light, { subset: true });
  const fReg = await doc.embedFont(reg, { subset: true });
  const fMed = await doc.embedFont(med, { subset: true });
  const logo = await doc.embedPng(logoBytes);
  doc.setTitle(`${tr.id} ${projectName}`);
  doc.setAuthor("Arsten Docs");

  const W = 210 * MM, H = 297 * MM;
  const L = 20 * MM, R = W - 20 * MM, TOP = H - 20 * MM, BOTTOM = 18 * MM;
  let page!: PDFPage;
  let y = 0;
  let pageNo = 0;

  const footer = (p: PDFPage) => {
    const fy = BOTTOM;
    p.drawLine({ start: { x: L, y: fy + 14 }, end: { x: R, y: fy + 14 }, thickness: 0.5, color: LINE });
    p.drawRectangle({ x: L, y: fy + 1, width: 5, height: 5, color: ACCENT });
    p.drawText(COMPANY.legal + "  ·  " + COMPANY.address, { x: L + 10, y: fy + 1, size: 7, font: fReg, color: MUTED });
    p.drawText(COMPANY.contact, { x: L + 10, y: fy - 9, size: 7, font: fReg, color: MUTED });
    p.drawText(`${tr.id} · ${pageNo}`, { x: R - fReg.widthOfTextAtSize(`${tr.id} · ${pageNo}`, 7), y: fy + 1, size: 7, font: fReg, color: MUTED });
  };
  const newPage = () => {
    page = doc.addPage([W, H]);
    pageNo++;
    page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: BG });
    const lh = 12 * MM, lw = (logo.width / logo.height) * lh;
    page.drawImage(logo, { x: L, y: TOP - lh, width: lw, height: lh });
    const k = "plovdiv, bg";
    page.drawText(k, { x: R - fReg.widthOfTextAtSize(k, 8), y: TOP - 8, size: 8, font: fReg, color: MUTED });
    footer(page);
    y = TOP - lh - 10 * MM;
  };
  newPage();

  // Title
  page.drawText("ТРАНСМИТАЛ", { x: L, y, size: 24, font: fLight, color: INK });
  const tw = fLight.widthOfTextAtSize("ТРАНСМИТАЛ ", 24);
  page.drawText("/ transmittal", { x: L + tw, y, size: 24, font: fLight, color: MUTED });
  y -= 9 * MM;
  page.drawText(tr.id, { x: L, y, size: 12, font: fMed, color: ACCENT });
  y -= 8 * MM;

  // Meta grid
  const meta: [string, string][] = [
    ["Проект / Project", projectName],
    ["Дата / Date", tr.date],
    ["До / To", tr.to],
    ...(tr.attn ? ([["На вниманието на / Attn", tr.attn]] as [string, string][]) : []),
    ["Цел / Purpose", `${PURPOSE_BG[tr.purpose] ?? tr.purpose} / ${tr.purpose}`],
    ["Изготвил / From", `${tr.by}, „АРСТЕН“ ООД`],
  ];
  page.drawLine({ start: { x: L, y: y + 4 }, end: { x: R, y: y + 4 }, thickness: 0.5, color: LINE });
  for (const [k, v] of meta) {
    y -= 13;
    page.drawText(k, { x: L, y, size: 8.5, font: fReg, color: MUTED });
    const lines = wrap(v, fReg, 10, R - L - 50 * MM);
    lines.forEach((ln, i) => page.drawText(ln, { x: L + 50 * MM, y: y - i * 12, size: 10, font: fReg, color: INK }));
    y -= (lines.length - 1) * 12 + 5;
    page.drawLine({ start: { x: L, y: y }, end: { x: R, y: y }, thickness: 0.5, color: LINE });
  }
  y -= 10 * MM;

  // Items table
  const cols = [
    { h: "№", w: 8 * MM },
    { h: "Документ / Document", w: 42 * MM },
    { h: "Рев.", w: 12 * MM },
    { h: "Наименование / Title", w: 0 },
    { h: "Файл / File", w: 0 },
  ];
  const fixed = cols.reduce((s, c) => s + c.w, 0);
  cols[3].w = (R - L - fixed) * 0.55;
  cols[4].w = (R - L - fixed) * 0.45;
  const header = () => {
    let x = L;
    for (const c of cols) { page.drawText(c.h, { x, y, size: 8, font: fMed, color: SOFT }); x += c.w; }
    y -= 5;
    page.drawLine({ start: { x: L, y }, end: { x: R, y }, thickness: 0.8, color: INK });
    y -= 12;
  };
  page.drawText(`Предаваме следните документи / We send the following documents (${tr.items.length}):`, { x: L, y, size: 10, font: fReg, color: INK });
  y -= 8 * MM;
  header();
  tr.items.forEach((it, i) => {
    const cells = [String(i + 1), it.key, it.rev, it.title ?? "", it.name];
    const wrapped = cells.map((c, ci) => wrap(c, ci === 1 ? fMed : fReg, 9, cols[ci].w - 6));
    const rows = Math.max(...wrapped.map((w) => w.length));
    if (y - rows * 11 < BOTTOM + 22 * MM) { newPage(); header(); }
    let x = L;
    wrapped.forEach((lines, ci) => {
      lines.forEach((ln, li) => page.drawText(ln, { x, y: y - li * 11, size: 9, font: ci === 1 ? fMed : fReg, color: ci === 4 ? SOFT : INK }));
      x += cols[ci].w;
    });
    y -= rows * 11 + 2;
    page.drawLine({ start: { x: L, y: y + 6 }, end: { x: R, y: y + 6 }, thickness: 0.5, color: LINE });
    y -= 6;
  });

  if (tr.note) {
    y -= 6 * MM;
    page.drawText("Бележка / Note", { x: L, y, size: 8.5, font: fReg, color: MUTED });
    y -= 13;
    for (const ln of tr.note.split("\n").flatMap((p) => wrap(p, fReg, 10, R - L))) {
      if (y < BOTTOM + 40 * MM) newPage();
      page.drawText(ln, { x: L, y, size: 10, font: fReg, color: INK });
      y -= 13;
    }
  }

  // Signatures
  if (y < BOTTOM + 45 * MM) newPage();
  y = Math.min(y - 14 * MM, BOTTOM + 38 * MM);
  const half = (R - L) / 2;
  for (const [i, label] of ["Предал / Sent by", "Приел / Received by"].entries()) {
    const x = L + i * half;
    page.drawLine({ start: { x, y }, end: { x: x + half - 12 * MM, y }, thickness: 0.5, color: SOFT });
    page.drawText(label, { x, y: y - 11, size: 8.5, font: fReg, color: MUTED });
    page.drawText(i === 0 ? tr.by : "име, подпис, дата / name, signature, date", { x, y: y - 22, size: 8.5, font: fReg, color: i === 0 ? INK : MUTED });
  }
  return doc.save();
}
