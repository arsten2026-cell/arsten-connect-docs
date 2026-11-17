import type { DocRow, Expected } from "./model";

/**
 * Expected drawing list ("списък на чертежите" from the designer): what we should receive, with a planned date.
 * Imported by pasting from Excel (tab separated) or from a .csv file. Matched to the register by number.
 */

export type ExpState = "missing" | "late" | "received" | "onsite";
export interface ExpRow { e: Expected; doc?: DocRow; state: ExpState }

/** Number for matching: upper case, no spaces/punctuation, without a trailing revision (_R02, R02, rev 2). */
export function normNumber(s: string): string {
  return String(s ?? "")
    .normalize("NFC")
    .toUpperCase()
    .replace(/\.PDF$/i, "")
    .replace(/[\s_\-.]+(R|REV|РЕВ)[\s.]*\d{1,3}$/i, "")
    .replace(/[^0-9A-ZА-Я]/g, "");
}

const HEAD: Record<keyof Omit<Expected, "kind">, RegExp> = {
  number: /^(№|no\.?|nr\.?|номер|number|чертеж|drawing|doc|документ|шифър|код|code)(?![0-9A-Za-zА-Яа-я])/i,
  title: /^(заглавие|наименование|title|name|описание|description|съдържание)/i,
  part: /^(част|part|discipline|дисциплина|раздел)/i,
  planned: /^(дата|срок|planned|planned date|date|due|очаквана|планирана)/i,
  note: /^(забележка|бележка|note|remark|коментар)/i,
};

/** DD.MM.YYYY, D.M.YY, DD/MM/YYYY, YYYY-MM-DD -> YYYY-MM-DD; anything else -> undefined. */
export function parseDate(s: string): string | undefined {
  const v = String(s ?? "").trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(v);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = /^(\d{1,2})[./](\d{1,2})[./](\d{2}|\d{4})\s*(г\.?)?$/.exec(v);
  if (m) {
    const y = m[3].length === 2 ? "20" + m[3] : m[3];
    const mo = +m[2], d = +m[1];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  return undefined;
}

function splitLine(line: string, sep: string): string[] {
  if (sep === "\t") return line.split("\t").map((c) => c.trim());
  // CSV with quotes
  const out: string[] = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { out.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

export interface ParseResult { rows: Expected[]; skipped: number; header: boolean }

/**
 * Columns: by header names when the first row is a header (Номер, Заглавие, Част, Дата/Срок, Забележка), otherwise
 * Номер | Заглавие | Част | Дата. Rows without a number are skipped.
 */
export function parseExpected(text: string): ParseResult {
  const lines = String(text ?? "").replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { rows: [], skipped: 0, header: false };
  const sep = lines[0].includes("\t") ? "\t" : (lines[0].split(";").length > lines[0].split(",").length ? ";" : ",");
  const first = splitLine(lines[0], sep);
  const col: Partial<Record<keyof typeof HEAD, number>> = {};
  first.forEach((c, i) => {
    for (const k of Object.keys(HEAD) as (keyof typeof HEAD)[]) if (col[k] === undefined && HEAD[k].test(c.trim())) { col[k] = i; break; }
  });
  const header = col.number !== undefined;
  if (!header) Object.assign(col, { number: 0, title: 1, part: 2, planned: 3 });
  const rows: Expected[] = [];
  let skipped = 0;
  const seen = new Set<string>();
  for (const line of header ? lines.slice(1) : lines) {
    const c = splitLine(line, sep);
    const get = (k: keyof typeof HEAD) => (col[k] !== undefined ? (c[col[k]!] ?? "").trim() : "");
    const number = get("number");
    const n = normNumber(number);
    if (!n || seen.has(n)) { skipped++; continue; }
    seen.add(n);
    const e: Expected = { number };
    if (get("title")) e.title = get("title");
    if (get("part")) e.part = get("part");
    const p = parseDate(get("planned"));
    if (p) e.planned = p;
    if (get("note")) e.note = get("note");
    rows.push(e);
  }
  return { rows, skipped, header };
}

/** Merge by number: new rows replace the old row with the same number, others are kept. */
export function mergeExpected(old: Expected[], add: Expected[]): Expected[] {
  const byNum = new Map(old.map((e) => [normNumber(e.number), e]));
  for (const e of add) byNum.set(normNumber(e.number), { ...byNum.get(normNumber(e.number)), ...e });
  return [...byNum.values()];
}

/** Each expected row with its document (by label, key or meta number) and its state. */
export function matchExpected(list: Expected[], docs: DocRow[], onSite: (d: DocRow) => boolean, today: string): { rows: ExpRow[]; extra: DocRow[] } {
  const index = new Map<string, DocRow>();
  for (const d of docs) for (const k of [d.label, d.key, d.meta.number ?? ""]) { const n = normNumber(k); if (n && !index.has(n)) index.set(n, d); }
  const used = new Set<string>();
  const rows = list.map((e): ExpRow => {
    const doc = index.get(normNumber(e.number));
    if (doc) used.add(doc.key);
    const state: ExpState = doc ? (onSite(doc) ? "onsite" : "received") : e.planned && e.planned < today ? "late" : "missing";
    return { e, doc, state };
  });
  const extra = docs.filter((d) => d.kind === "design" && !used.has(d.key));
  return { rows, extra };
}
