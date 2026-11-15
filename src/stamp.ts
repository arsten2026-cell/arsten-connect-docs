import { PDFDocument, degrees, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import qrcode from "qrcode-generator";

/**
 * Stamps on CONTROLLED COPIES of drawings (never on the original: pdf-lib rewrites the file, which would break a
 * КЕП/QES signature on the designer's PDF).
 *   construction – box "ЗА ИЗПЪЛНЕНИЕ / FOR CONSTRUCTION" with document, revision, date, transmittal and a QR code
 *   superseded   – red diagonal "ЗАМЕНЕН / SUPERSEDED" on every page plus a header line
 *   review       – shop-drawing decision box A / B / C / D
 */
export type StampKind = "construction" | "superseded" | "review";

export interface StampInfo {
  kind: StampKind;
  project: string; // "1028 - Retail Tsarevo"
  doc: string; // number shown to people
  rev: string;
  date: string; // dd.mm.yyyy
  by: string;
  ref?: string; // TR-1028-003
  supersededBy?: string; // "v4"
  decision?: "A" | "B" | "C" | "D";
  remark?: string;
  qr?: string; // text/URL encoded in the QR code (construction)
  company?: string;
}

export type FontLoader = (name: string) => Promise<ArrayBuffer>;

const ORANGE = rgb(0xe3 / 255, 0x74 / 255, 0x24 / 255);
const INK = rgb(0.09, 0.09, 0.09);
const RED = rgb(0.75, 0.1, 0.1);
const GREEN = rgb(0.13, 0.5, 0.25);
const WHITE = rgb(1, 1, 1);

const DECISION: Record<string, { bg: string; en: string; color: ReturnType<typeof rgb> }> = {
  A: { bg: "A · ОДОБРЕН", en: "APPROVED", color: GREEN },
  B: { bg: "B · ОДОБРЕН СЪС ЗАБЕЛЕЖКИ", en: "APPROVED AS NOTED", color: GREEN },
  C: { bg: "C · ЗА КОРЕКЦИЯ", en: "REVISE AND RESUBMIT", color: ORANGE },
  D: { bg: "D · ОТХВЪРЛЕН", en: "REJECTED", color: RED },
};

function drawQr(page: PDFPage, text: string, x: number, y: number, size: number) {
  const qr = qrcode(0, "M");
  qr.addData(unescape(encodeURIComponent(text)), "Byte"); // UTF-8 bytes
  qr.make();
  const n = qr.getModuleCount();
  const cell = size / (n + 2);
  page.drawRectangle({ x, y, width: size, height: size, color: WHITE });
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++)
      if (qr.isDark(r, c)) page.drawRectangle({ x: x + (c + 1) * cell, y: y + size - (r + 2) * cell, width: cell, height: cell, color: INK });
}

function fit(font: PDFFont, text: string, size: number, max: number): string {
  if (font.widthOfTextAtSize(text, size) <= max) return text;
  let t = text;
  while (t.length > 1 && font.widthOfTextAtSize(t + "…", size) > max) t = t.slice(0, -1);
  return t + "…";
}

/** Visible page box, respecting rotation (drawings are often stored as portrait pages rotated 90°). */
function frame(page: PDFPage) {
  const { width, height } = page.getSize();
  const rot = ((page.getRotation().angle % 360) + 360) % 360;
  return { width, height, rot };
}

/** Draw in "visual" coordinates (as the page appears on screen) whatever the page rotation is. */
function visual(page: PDFPage) {
  const { width, height, rot } = frame(page);
  const vw = rot === 90 || rot === 270 ? height : width;
  const vh = rot === 90 || rot === 270 ? width : height;
  // map a visual point to page space
  const map = (x: number, y: number): [number, number] => {
    switch (rot) {
      case 90: return [width - y, x];
      case 180: return [width - x, height - y];
      case 270: return [y, height - x];
      default: return [x, y];
    }
  };
  return { vw, vh, rot, map };
}

export async function stampPdf(original: ArrayBuffer | Uint8Array, info: StampInfo, loadFont: FontLoader): Promise<Uint8Array> {
  const doc = await PDFDocument.load(original, { ignoreEncryption: true, updateMetadata: false });
  doc.registerFontkit(fontkit);
  const reg = await doc.embedFont(await loadFont("Ubuntu-Regular"), { subset: true });
  const med = await doc.embedFont(await loadFont("Ubuntu-Medium"), { subset: true });
  const pages = doc.getPages();
  const company = info.company ?? "Arsten / MULTIPLAN";

  for (const [i, page] of pages.entries()) {
    const { vw, vh, rot, map } = visual(page);
    const text = (s: string, x: number, y: number, size: number, font: PDFFont, color = INK, extraRot = 0) => {
      const [px, py] = map(x, y);
      page.drawText(s, { x: px, y: py, size, font, color, rotate: degrees(rot + extraRot) });
    };
    const rect = (x: number, y: number, w: number, h: number, opts: { color?: any; borderColor?: any; borderWidth?: number; opacity?: number }) => {
      // rectangle anchored at its visual bottom-left corner
      const [px, py] = map(x, y);
      page.drawRectangle({ x: px, y: py, width: w, height: h, rotate: degrees(rot), ...opts });
    };
    const scale = Math.max(0.6, Math.min(1.6, Math.min(vw, vh) / 595)); // A4 = 1

    if (info.kind === "superseded") {
      const big = 64 * scale;
      const label = "ЗАМЕНЕН / SUPERSEDED";
      const w = med.widthOfTextAtSize(label, big);
      const ang = (Math.atan2(vh, vw) * 180) / Math.PI;
      const cx = vw / 2 - (w / 2) * Math.cos((ang * Math.PI) / 180);
      const cy = vh / 2 - (w / 2) * Math.sin((ang * Math.PI) / 180);
      const [px, py] = map(cx, cy);
      page.drawText(label, { x: px, y: py, size: big, font: med, color: RED, opacity: 0.35, rotate: degrees(rot + ang) });
      const line = `ЗАМЕНЕН${info.supersededBy ? " с " + info.supersededBy : ""} на ${info.date} – НЕ СТРОЙ ПО ТОЗИ ЧЕРТЕЖ · ${info.doc} ${info.rev} · ${company}`;
      const fs = 9 * scale;
      rect(0, vh - fs * 2.2, vw, fs * 2.2, { color: RED, opacity: 0.9 });
      text(fit(med, line, fs, vw - 20), 10, vh - fs * 1.5, fs, med, WHITE);
      continue;
    }

    if (i > 0 && info.kind === "construction") {
      // later pages: a slim header line only
      const fs = 7.5 * scale;
      text(fit(reg, `ЗА ИЗПЪЛНЕНИЕ · ${info.doc} ${info.rev} · ${info.date}${info.ref ? " · " + info.ref : ""} · ${company}`, fs, vw - 20), 10, vh - fs * 1.6, fs, reg, ORANGE);
      continue;
    }
    if (i > 0) continue;

    // box in the top-right corner (title blocks are usually bottom-right)
    const pad = 6 * scale;
    const qrSize = info.kind === "construction" && info.qr ? 58 * scale : 0;
    const w = 210 * scale + qrSize;
    const h = Math.max(qrSize + 2 * pad, (26 + 4 * 9.5) * scale + 2 * pad);
    const x0 = vw - w - 14 * scale, y0 = vh - h - 14 * scale;
    const color = info.kind === "review" ? DECISION[info.decision ?? "A"].color : ORANGE;
    rect(x0, y0, w, h, { color: WHITE, borderColor: color, borderWidth: 2 * scale, opacity: 0.92 });
    const tx = x0 + pad, maxW = w - qrSize - 2 * pad;
    let ty = y0 + h - pad - 13 * scale;
    if (info.kind === "construction") {
      text("ЗА ИЗПЪЛНЕНИЕ", tx, ty, 13 * scale, med, color);
      ty -= 10 * scale; text("FOR CONSTRUCTION", tx, ty, 7.5 * scale, med, color);
    } else {
      const d = DECISION[info.decision ?? "A"];
      text(fit(med, d.bg, 11 * scale, maxW), tx, ty, 11 * scale, med, color);
      ty -= 10 * scale; text(d.en, tx, ty, 7.5 * scale, med, color);
    }
    const lines = [
      `${info.doc} · ${info.rev}`,
      `${info.date} · ${info.by}${info.ref ? " · " + info.ref : ""}`,
      info.kind === "review" && info.remark ? info.remark : info.project,
      company,
    ];
    for (const l of lines) { ty -= 9.5 * scale; text(fit(reg, l, 7.5 * scale, maxW), tx, ty, 7.5 * scale, reg, INK); }
    if (qrSize) {
      const qx = x0 + w - qrSize - pad / 2, qy = y0 + (h - qrSize) / 2;
      if (rot === 0) drawQr(page, info.qr!, qx, qy, qrSize);
      else {
        // QR on a rotated page: draw into a separate page-space square at the mapped corner (QR reads in any rotation)
        const [a, b] = map(qx, qy), [c, d] = map(qx + qrSize, qy + qrSize);
        drawQr(page, info.qr!, Math.min(a, c), Math.min(b, d), qrSize);
      }
    }
  }
  return doc.save();
}

export function isPdf(name: string) {
  return /\.pdf$/i.test(name);
}
