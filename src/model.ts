import { compilePattern, parseName, revLabel, DEFAULT_PATTERN, type ParsedName } from "./naming";

// ---------- Connect data (/files/fs/snapshot item, compact keys) ----------
export interface SnapshotItem {
  id: string;
  vid?: string; // version id
  nm: string; // name
  pid?: string; // parent id
  tp: string; // FILE | FOLDER
  ct?: string; // created
  mt?: string; // modified
  cid?: string; // created by (user id)
  mid?: string; // modified by (user id)
  sz?: number;
  rv?: number; // Connect revision counter (1,2,3… per re-upload)
  del?: boolean;
}

export interface UserRef { id: string; name: string; email?: string; role?: string }

// ---------- document kinds and statuses (GC / execution side, research 3 §4) ----------
/** design = received design information; record = the contractor's own records (acts, DoP, tests, as-built);
 *  submittal = shop drawings / submittals from fabricators and subcontractors, reviewed by the designer. */
export type Kind = "design" | "record" | "submittal";
export const KINDS: Kind[] = ["design", "record", "submittal"];

export type DocStatus =
  | "received" | "review" | "construction" | "info" | "superseded" // design
  | "draft" | "submitted" | "returned" | "signed" | "asbuilt" | "void" // records
  | "A" | "B" | "C" | "D"; // submittal decisions

export const STATUS_BY_KIND: Record<Kind, DocStatus[]> = {
  design: ["received", "review", "construction", "info", "superseded"],
  record: ["draft", "submitted", "returned", "signed", "asbuilt", "void", "superseded"],
  submittal: ["submitted", "review", "A", "B", "C", "D", "construction", "superseded"],
};
export const ALL_STATUSES: DocStatus[] = [...new Set(KINDS.flatMap((k) => STATUS_BY_KIND[k]))];
export const DEFAULT_STATUS: Record<Kind, DocStatus> = { design: "received", record: "draft", submittal: "submitted" };
/** A revision in one of these statuses supersedes every lower revision of the same document. */
export const SUPERSEDING: DocStatus[] = ["construction", "signed", "asbuilt"];
/** Statuses the site may build from. */
export const SITE_STATUSES: DocStatus[] = ["construction"];
/** Submittal decisions that may be released to site. */
export const RELEASABLE: DocStatus[] = ["A", "B"];

/** tracker.json v1 used Draft / For approval / Issued / Superseded. */
const LEGACY_STATUS: Record<string, DocStatus> = { Draft: "received", "For approval": "review", Issued: "construction", Superseded: "superseded" };
export function migrateStatus(s: string): DocStatus {
  return (LEGACY_STATUS[s] ?? s) as DocStatus;
}

// ---------- tracker.json ----------
export interface StatusLogEntry {
  at: string;
  by: string;
  byId?: string;
  key: string;
  rev: string;
  from: DocStatus;
  to: DocStatus;
  note?: string;
  transmittal?: string;
}

export type TransmittalPurpose = "For construction" | "For information" | "For approval" | "For tender" | "For review";

export interface TransmittalItem {
  key: string;
  label?: string;
  rev: string;
  name: string;
  title?: string;
  fileId: string;
  versionId?: string;
}

export interface Transmittal {
  id: string; // TR-1028-001
  date: string; // YYYY-MM-DD
  to: string;
  attn?: string;
  purpose: TransmittalPurpose;
  note?: string;
  by: string;
  byId?: string;
  createdAt: string;
  items: TransmittalItem[];
  pdfFileId?: string;
  todoId?: string; // acknowledgement ToDo
  ackTarget?: string; // who must acknowledge (group/user name)
}

/** Per-document metadata the user may set or correct (file names are never renamed). */
export interface DocMeta {
  kind?: Kind;
  number?: string; // shown instead of the parsed/file label
  title?: string;
  part?: string; // част: АР, К, ВиК, ЕЛ, ОВК, ПБ, Геодезия…
  type?: string; // DR, ACT, DOP, CERT, DN, LOG, MS, ASB, SUB…
  form?: string; // обр. № for acts (Наредба № 3)
  location?: string; // floor / axis / pour
  originator?: string; // designer firm, supplier, subcontractor
  note?: string;
}

export interface Ack { by: string; byId?: string; at: string; via: "app" | "todo" }

export interface Pkg { id: string; date: string; from: string; note?: string; by: string; createdAt: string; items: string[] /* key@rev */ }

export interface SiteCopy { fileId: string; rev: string; folderId: string; name: string; at: string }

export type RfiState = "open" | "answered" | "closed";
export interface Rfi {
  id: string; // RFI-1028-001
  title: string;
  question: string;
  docs: string[]; // doc keys
  location?: string;
  askedBy: string;
  askedById?: string;
  askedAt: string;
  assignee?: { type: "USER" | "GROUP"; id: string; name: string };
  due?: string;
  todoId?: string;
  state: RfiState;
  answer?: string;
  answeredBy?: string;
  answeredAt?: string;
  closedBy?: string;
  closedAt?: string;
  outcome?: "none" | "order" | "revision"; // без промяна / заповед в заповедната книга / нова ревизия
}

export type TodoState = "Open" | "In progress" | "Done";
export interface LocalTodo {
  id: string; title: string; description?: string; assignee?: UserRef; due?: string; state: TodoState;
  docKey?: string; createdAt: string; createdBy: string; doneAt?: string;
}

export interface TrackerSettings {
  pattern: string;
  trackExts?: string;
  projectCode?: string;
  todoBackend?: "native" | "local";
  /** Site set folder, path from the project root ("ЗА СТРОИТЕЛСТВО"). Controlled stamped copies live here. */
  siteFolder?: string;
  /** Who gets the "please acknowledge" ToDo when documents are issued for construction. */
  ackAssignee?: { type: "USER" | "GROUP"; id: string; name: string };
  /** Default assignee of RFIs and shop-drawing reviews (the designer group). */
  rfiAssignee?: { type: "USER" | "GROUP"; id: string; name: string };
}

export interface Tracker {
  schema: 2;
  settings: TrackerSettings;
  status: Record<string, DocStatus>; // "key@rev" -> status
  meta: Record<string, DocMeta>; // key -> metadata
  log: StatusLogEntry[];
  transmittals: Transmittal[];
  packages: Pkg[];
  acks: Record<string, Ack[]>; // "key@rev" -> acknowledgements
  site: Record<string, SiteCopy>; // key -> current controlled copy in the site folder
  rfis: Rfi[];
  todos: LocalTodo[];
}

export const DEFAULT_SITE_FOLDER = "ЗА СТРОИТЕЛСТВО";

export function emptyTracker(): Tracker {
  return {
    schema: 2, settings: { pattern: DEFAULT_PATTERN, trackExts: "pdf", siteFolder: DEFAULT_SITE_FOLDER },
    status: {}, meta: {}, log: [], transmittals: [], packages: [], acks: {}, site: {}, rfis: [], todos: [],
  };
}

/** Accepts anything read from tracker.json (v1 or v2) and fills missing parts. */
export function normalizeTracker(raw: unknown): Tracker {
  const t = emptyTracker();
  if (!raw || typeof raw !== "object") return t;
  const r = raw as any;
  const status: Record<string, DocStatus> = {};
  for (const [k, v] of Object.entries(r.status ?? {})) status[k] = migrateStatus(String(v));
  const log = (Array.isArray(r.log) ? r.log : []).map((l: any) => ({ ...l, from: migrateStatus(l.from), to: migrateStatus(l.to) }));
  const obj = (x: any) => (x && typeof x === "object" && !Array.isArray(x) ? x : {});
  const arr = (x: any) => (Array.isArray(x) ? x : []);
  return {
    schema: 2,
    settings: { ...t.settings, ...obj(r.settings) },
    status, meta: obj(r.meta), log,
    transmittals: arr(r.transmittals), packages: arr(r.packages), acks: obj(r.acks), site: obj(r.site),
    rfis: arr(r.rfis), todos: arr(r.todos),
  };
}

export const revId = (key: string, rev: string) => `${key}@${rev}`;

// ---------- Register ----------
export interface RevRow {
  rev: number;
  revLabel: string;
  fileId: string;
  versionId?: string;
  name: string;
  folderId?: string;
  folderPath: string;
  modified?: string;
  modifiedBy?: string;
  size?: number;
  connectVersion?: number;
  stored?: DocStatus;
  status: DocStatus;
  duplicates: number;
}

export interface DocRow {
  /** numbered = parsed from the naming pattern; file = one Connect file, revisions are its versions */
  source: "numbered" | "file";
  kind: Kind;
  key: string;
  label: string; // number shown to the user (meta.number ?? parsed key ?? file name)
  proj: string;
  disc: string; // part (meta.part ?? parsed discipline ?? folder name)
  type: string;
  num: string;
  title: string;
  meta: DocMeta;
  revs: RevRow[];
  current: RevRow;
  status: DocStatus;
  transmittals: string[];
}

export interface Register {
  docs: DocRow[];
  unnumbered: { fileId: string; name: string; folderPath: string; modified?: string; modifiedBy?: string }[];
  trackerFolderId?: string;
  trackerFileId?: string;
  folders: Map<string, SnapshotItem>;
  siteFolderIds: Set<string>;
}

/** Project tool folder (one name for Arsten and MULTIPLAN). Only this name is ever created. */
export const TRACKER_FOLDER = "_AM_Docs";
/** Older name, still read when a project has not been renamed yet. */
export const LEGACY_TRACKER_FOLDER = "_ArstenDocs";
export const TOOL_FOLDERS = [TRACKER_FOLDER, LEGACY_TRACKER_FOLDER];
export const TRACKER_FILE = "tracker.json";

/**
 * The tool folder and tracker.json in it. Prefers the folder that already holds tracker.json (_AM_Docs first, then
 * _ArstenDocs), so data is never lost when another tool created an empty _AM_Docs before the rename; otherwise
 * _AM_Docs, then _ArstenDocs. Root-level folders win over nested ones of the same name.
 */
export function findToolFolder(items: SnapshotItem[]): { folder?: SnapshotItem; file?: SnapshotItem } {
  const live = items.filter((i) => !i.del);
  const ids = new Set(live.filter((i) => i.tp === "FOLDER").map((f) => f.id));
  const named = (nm: string) => live.find((f) => f.tp === "FOLDER" && f.nm === nm && !ids.has(f.pid ?? ""))
    ?? live.find((f) => f.tp === "FOLDER" && f.nm === nm);
  const cands = TOOL_FOLDERS.map(named).filter((f): f is SnapshotItem => !!f);
  const fileIn = (f: SnapshotItem) => live.find((x) => x.tp === "FILE" && x.nm === TRACKER_FILE && x.pid === f.id);
  for (const f of cands) { const file = fileIn(f); if (file) return { folder: f, file }; }
  return { folder: cands[0] };
}

export function folderPathOf(id: string | undefined, folders: Map<string, SnapshotItem>): string {
  const parts: string[] = [];
  let cur = id ? folders.get(id) : undefined;
  let guard = 0;
  while (cur && guard++ < 50) {
    parts.unshift(cur.nm);
    cur = cur.pid ? folders.get(cur.pid) : undefined;
  }
  return parts.join(" / ");
}

/** Effective status per revision: stored (or the kind's default); any revision below a superseding one is Superseded. */
export function effectiveStatuses(key: string, revs: number[], status: Record<string, DocStatus>, kind: Kind = "design", label = revLabel): Map<number, DocStatus> {
  const sorted = [...revs].sort((a, b) => a - b);
  const out = new Map<number, DocStatus>();
  let top = -1;
  for (const r of sorted) if (SUPERSEDING.includes(status[revId(key, label(r))])) top = r;
  for (const r of sorted) {
    const s = status[revId(key, label(r))] ?? DEFAULT_STATUS[kind];
    out.set(r, r < top ? "superseded" : s);
  }
  return out;
}

/** Folders whose path starts with the site folder path (the controlled copies; never registered as documents). */
function siteFolders(folders: Map<string, SnapshotItem>, sitePath: string): Set<string> {
  const want = sitePath.split("/").map((s) => s.trim()).filter(Boolean).join(" / ");
  const out = new Set<string>();
  if (!want) return out;
  for (const [id] of folders) {
    const p = folderPathOf(id, folders);
    if (p === want || p.startsWith(want + " / ")) out.add(id);
  }
  return out;
}

export function buildRegister(items: SnapshotItem[], tracker: Tracker, users: Map<string, UserRef>): Register {
  let re: RegExp;
  try { re = compilePattern(tracker.settings.pattern || DEFAULT_PATTERN); } catch { re = compilePattern(DEFAULT_PATTERN); }
  const live = items.filter((i) => !i.del);
  const folders = new Map(live.filter((i) => i.tp === "FOLDER").map((f) => [f.id, f]));
  const { folder: trackerFolder, file: trackerFile } = findToolFolder(live);
  const site = siteFolders(folders, tracker.settings.siteFolder ?? DEFAULT_SITE_FOLDER);
  const excluded = (pid?: string) => {
    let cur = pid ? folders.get(pid) : undefined;
    let guard = 0;
    while (cur && guard++ < 50) {
      if (TOOL_FOLDERS.includes(cur.nm) || site.has(cur.id)) return true;
      cur = cur.pid ? folders.get(cur.pid) : undefined;
    }
    return false;
  };

  const byKey = new Map<string, { parsed: ParsedName; files: Map<number, SnapshotItem[]> }>();
  const fileDocs: SnapshotItem[] = [];
  const exts = new Set((tracker.settings.trackExts ?? "").split(/[\s,;]+/).map((e) => e.replace(/^\./, "").toLowerCase()).filter(Boolean));
  const unnumbered: Register["unnumbered"] = [];
  const userName = (id?: string) => (id ? users.get(id)?.name ?? id : undefined);

  for (const f of live) {
    if (f.tp !== "FILE" || excluded(f.pid)) continue;
    const p = parseName(f.nm, re);
    const ext = f.nm.includes(".") ? f.nm.slice(f.nm.lastIndexOf(".") + 1).toLowerCase() : "";
    if (!p && exts.has(ext)) { fileDocs.push(f); continue; }
    if (!p) {
      unnumbered.push({ fileId: f.id, name: f.nm, folderPath: folderPathOf(f.pid, folders), modified: f.mt, modifiedBy: userName(f.mid) });
      continue;
    }
    let entry = byKey.get(p.key);
    if (!entry) byKey.set(p.key, (entry = { parsed: p, files: new Map() }));
    if (p.title && (!entry.parsed.title || p.rev >= entry.parsed.rev)) entry.parsed = p;
    const list = entry.files.get(p.rev) ?? [];
    list.push(f);
    entry.files.set(p.rev, list);
  }

  const trByKey = new Map<string, string[]>();
  for (const t of tracker.transmittals)
    for (const it of t.items) {
      const l = trByKey.get(it.key) ?? [];
      if (!l.includes(t.id)) l.push(t.id);
      trByKey.set(it.key, l);
    }

  const docs: DocRow[] = [];
  for (const [key, { parsed, files }] of byKey) {
    const meta = tracker.meta[key] ?? {};
    const kind = meta.kind ?? "design";
    const revNums = [...files.keys()].sort((a, b) => a - b);
    const eff = effectiveStatuses(key, revNums, tracker.status, kind);
    const revs: RevRow[] = revNums.map((r) => {
      const list = [...files.get(r)!].sort((a, b) => (b.mt ?? "").localeCompare(a.mt ?? ""));
      const f = list[0];
      return {
        rev: r, revLabel: revLabel(r), fileId: f.id, versionId: f.vid, name: f.nm, folderId: f.pid,
        folderPath: folderPathOf(f.pid, folders), modified: f.mt, modifiedBy: userName(f.mid), size: f.sz,
        connectVersion: f.rv, stored: tracker.status[revId(key, revLabel(r))], status: eff.get(r)!, duplicates: list.length - 1,
      };
    });
    const current = revs[revs.length - 1];
    docs.push({
      source: "numbered", kind, key, label: meta.number || key, proj: parsed.proj, disc: meta.part || parsed.disc,
      type: meta.type || parsed.type, num: parsed.num, title: meta.title ?? parsed.title, meta,
      revs, current, status: current.status, transmittals: trByKey.get(key) ?? [],
    });
  }
  for (const f of fileDocs) {
    const key = `f:${f.id}`;
    const meta = tracker.meta[key] ?? {};
    const kind = meta.kind ?? "design";
    const v = f.rv ?? 1;
    const stored = tracker.status[revId(key, `v${v}`)];
    const folder = f.pid ? folders.get(f.pid) : undefined;
    const rev: RevRow = {
      rev: v, revLabel: `v${v}`, fileId: f.id, versionId: f.vid, name: f.nm, folderId: f.pid,
      folderPath: folderPathOf(f.pid, folders), modified: f.mt, modifiedBy: userName(f.mid), size: f.sz,
      connectVersion: v, stored, status: stored ?? DEFAULT_STATUS[kind], duplicates: 0,
    };
    const label = f.nm.replace(/\.[^.]+$/, "");
    docs.push({
      source: "file", kind, key, label: meta.number || label, proj: "", disc: meta.part || folder?.nm || "/",
      type: meta.type || (f.nm.split(".").pop() ?? "").toUpperCase(), num: label, title: meta.title ?? "", meta,
      revs: [rev], current: rev, status: rev.status, transmittals: trByKey.get(key) ?? [],
    });
  }
  docs.sort((a, b) =>
    a.source !== b.source ? (a.source === "numbered" ? -1 : 1)
    : a.source === "file" ? a.current.folderPath.localeCompare(b.current.folderPath) || a.label.localeCompare(b.label, undefined, { numeric: true })
    : a.key.localeCompare(b.key, undefined, { numeric: true }));
  unnumbered.sort((a, b) => a.folderPath.localeCompare(b.folderPath) || a.name.localeCompare(b.name));
  return { docs, unnumbered, folders, trackerFolderId: trackerFolder?.id, trackerFileId: trackerFile?.id, siteFolderIds: site };
}

// ---------- Mutations (pure) ----------
export interface Actor { name: string; id?: string }

/** The stored status in THIS tracker (fresh after a conflict retry), else the status the screen showed. */
export const statusIn = (t: Tracker, key: string, rev: string, fallback: DocStatus): DocStatus => t.status[revId(key, rev)] ?? fallback;

export function setStatus(t: Tracker, key: string, rev: string, to: DocStatus, shown: DocStatus, actor: Actor, note?: string, transmittal?: string, at = new Date().toISOString()): Tracker {
  const from = statusIn(t, key, rev, shown);
  if (from === to && t.status[revId(key, rev)] === to) return t;
  return {
    ...t,
    status: { ...t.status, [revId(key, rev)]: to },
    log: [...t.log, { at, by: actor.name, byId: actor.id, key, rev, from, to, ...(note ? { note } : {}), ...(transmittal ? { transmittal } : {}) }],
  };
}

export function setMeta(t: Tracker, key: string, patch: Partial<DocMeta>): Tracker {
  const cur = t.meta[key] ?? {};
  const next: DocMeta = { ...cur };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === "") delete (next as any)[k];
    else (next as any)[k] = v;
  }
  return { ...t, meta: { ...t.meta, [key]: next } };
}

export function statusForPurpose(p: TransmittalPurpose): DocStatus {
  return p === "For construction" ? "construction" : p === "For information" ? "info" : "review";
}

export function mostCommonProject(docs: DocRow[]): string | undefined {
  const c = new Map<string, number>();
  for (const d of docs) if (d.proj) c.set(d.proj, (c.get(d.proj) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

function nextSeq(ids: string[], prefix: string): string {
  let max = 0;
  for (const id of ids) if (id.startsWith(prefix)) max = Math.max(max, parseInt(id.slice(prefix.length), 10) || 0);
  return prefix + String(max + 1).padStart(3, "0");
}
export const nextTransmittalId = (t: Tracker, code: string) => nextSeq(t.transmittals.map((x) => x.id), `TR-${code}-`);
export const nextRfiId = (t: Tracker, code: string) => nextSeq(t.rfis.map((x) => x.id), `RFI-${code}-`);
export const nextPackageId = (t: Tracker, code: string) => nextSeq(t.packages.map((x) => x.id), `ПК-${code}-`);

/** Adds a transmittal and moves the included revisions to the status implied by its purpose. Never downgrades an issued
 *  revision, never overwrites a designer's A/B/C/D decision, and only sets statuses that exist for the document's kind. */
export function addTransmittal(t: Tracker, tr: Transmittal, currentStatus: (key: string, rev: string) => DocStatus, actor: Actor, setStatuses = true): Tracker {
  let next: Tracker = { ...t, transmittals: [...t.transmittals.filter((x) => x.id !== tr.id), tr] };
  if (!setStatuses) return next;
  return applyPurpose(next, tr, tr.items.map((i) => i.key), currentStatus, actor);
}

export function applyPurpose(t: Tracker, tr: Transmittal, keys: string[], currentStatus: (key: string, rev: string) => DocStatus, actor: Actor): Tracker {
  let next = t;
  const to = statusForPurpose(tr.purpose);
  for (const it of tr.items) {
    if (!keys.includes(it.key)) continue;
    const kind = next.meta[it.key]?.kind ?? "design";
    if (!STATUS_BY_KIND[kind].includes(to)) continue;
    const from = statusIn(next, it.key, it.rev, currentStatus(it.key, it.rev));
    if (from === to) continue;
    if (SUPERSEDING.includes(from) && !SUPERSEDING.includes(to)) continue; // an issued revision stays issued
    if (from === "superseded") continue;
    if (["A", "B", "C", "D"].includes(from) && to !== "construction") continue; // keep the designer's decision
    next = setStatus(next, it.key, it.rev, to, from, actor, undefined, tr.id, tr.createdAt);
  }
  return next;
}

export function addAck(t: Tracker, key: string, rev: string, a: Ack): Tracker {
  const id = revId(key, rev);
  const list = t.acks[id] ?? [];
  if (list.some((x) => (a.byId && x.byId === a.byId) || x.by === a.by)) return t;
  return { ...t, acks: { ...t.acks, [id]: [...list, a] } };
}

/** Which actions a status allows for a kind (keeps the UI from offering nonsense). `siteRev` = revision of the current
 *  controlled copy: an issued revision without its copy (a failed issue) may be issued again. */
export function canIssue(d: DocRow, siteRev?: string): boolean {
  if (d.status === "superseded") return false;
  if (d.status === "construction") return siteRev !== d.current.revLabel; // no controlled copy of this revision yet
  if (d.kind === "submittal") return RELEASABLE.includes(d.status);
  return d.kind === "design";
}

const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
export function isOverdue(due: string | undefined, done: boolean, today = localToday()): boolean {
  return !!due && !done && due.slice(0, 10) < today;
}

export function addDays(iso: string, days: number): string {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
