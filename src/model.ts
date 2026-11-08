import { compilePattern, parseName, revLabel, DEFAULT_PATTERN, type ParsedName } from "./naming";

// ---------- Connect data (Core v2 /files/fs/snapshot item, compact keys) ----------
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

export interface UserRef { id: string; name: string; email?: string }

// ---------- tracker.json ----------
export const STATUSES = ["Draft", "For approval", "Issued", "Superseded"] as const;
export type DocStatus = (typeof STATUSES)[number];

export interface StatusLogEntry {
  at: string; // ISO time
  by: string; // display name
  byId?: string;
  key: string; // document key 1018-ST-DR-0101
  rev: string; // R02
  from: DocStatus;
  to: DocStatus;
  note?: string;
  transmittal?: string; // TR id when the change came from a transmittal
}

export type TransmittalPurpose = "For approval" | "For construction" | "For information" | "For tender";

export interface TransmittalItem {
  key: string;
  label?: string; // display number when key is "f:<fileId>"
  rev: string;
  name: string;
  title?: string;
  fileId: string;
  versionId?: string;
}

export interface Transmittal {
  id: string; // TR-1018-001
  date: string; // YYYY-MM-DD
  to: string; // recipient (company / person)
  attn?: string; // attention of
  purpose: TransmittalPurpose;
  note?: string;
  by: string;
  byId?: string;
  createdAt: string;
  items: TransmittalItem[];
  pdfFileId?: string;
}

export type TodoState = "Open" | "In progress" | "Done";
export interface LocalTodo {
  id: string;
  title: string;
  description?: string;
  assignee?: UserRef;
  due?: string; // YYYY-MM-DD
  state: TodoState;
  docKey?: string;
  createdAt: string;
  createdBy: string;
  doneAt?: string;
}

export interface TrackerSettings {
  pattern: string;
  /** Files that don't match the pattern but have one of these extensions are tracked too, one document per
   *  file, revisions = Connect versions (v1, v2…). Comma-separated, e.g. "pdf" or "pdf,dwg". Empty = off. */
  trackExts?: string;
  projectCode?: string; // used in transmittal numbers; defaults to most common parsed proj
  todoBackend?: "native" | "local";
}

export interface Tracker {
  schema: 1;
  settings: TrackerSettings;
  /** stored status per revision, key "1018-ST-DR-0101@R02" */
  status: Record<string, DocStatus>;
  log: StatusLogEntry[];
  transmittals: Transmittal[];
  todos: LocalTodo[];
}

export function emptyTracker(): Tracker {
  return { schema: 1, settings: { pattern: DEFAULT_PATTERN, trackExts: "pdf" }, status: {}, log: [], transmittals: [], todos: [] };
}

/** Accepts anything read from tracker.json and fills missing parts, so old/partial files still load. */
export function normalizeTracker(raw: unknown): Tracker {
  const t = emptyTracker();
  if (!raw || typeof raw !== "object") return t;
  const r = raw as Partial<Tracker>;
  return {
    schema: 1,
    settings: { ...t.settings, ...(r.settings ?? {}) },
    status: { ...(r.status ?? {}) },
    log: Array.isArray(r.log) ? r.log : [],
    transmittals: Array.isArray(r.transmittals) ? r.transmittals : [],
    todos: Array.isArray(r.todos) ? r.todos : [],
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
  status: DocStatus; // effective
  duplicates: number; // other files with the same key+rev (naming mistake)
}

export interface DocRow {
  /** "numbered" = parsed from the naming pattern; "file" = one Connect file, revisions are its versions */
  kind: "numbered" | "file";
  key: string; // stable id: "1018-ST-DR-0101" or "f:<fileId>"
  label: string; // what the user sees in the Number column
  proj: string;
  disc: string;
  type: string;
  num: string;
  title: string;
  revs: RevRow[]; // ascending
  current: RevRow; // highest revision
  status: DocStatus; // = current.status
  transmittals: string[]; // TR ids that contain any revision
}

export interface Register {
  docs: DocRow[];
  unnumbered: { fileId: string; name: string; folderPath: string; modified?: string; modifiedBy?: string }[];
  trackerFolderId?: string;
  trackerFileId?: string;
  folders: Map<string, SnapshotItem>;
}

export const TRACKER_FOLDER = "_ArstenDocs";
export const TRACKER_FILE = "tracker.json";

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

/** Effective status: stored (default Draft), but any revision below an Issued revision is Superseded. */
export function effectiveStatuses(key: string, revs: number[], status: Record<string, DocStatus>): Map<number, DocStatus> {
  const sorted = [...revs].sort((a, b) => a - b);
  const out = new Map<number, DocStatus>();
  let highestIssued = -1;
  for (const r of sorted) if (status[revId(key, revLabel(r))] === "Issued") highestIssued = r;
  for (const r of sorted) {
    const s = status[revId(key, revLabel(r))] ?? "Draft";
    out.set(r, r < highestIssued ? "Superseded" : s);
  }
  return out;
}

export function buildRegister(items: SnapshotItem[], tracker: Tracker, users: Map<string, UserRef>): Register {
  let re: RegExp;
  try {
    re = compilePattern(tracker.settings.pattern || DEFAULT_PATTERN);
  } catch {
    re = compilePattern(DEFAULT_PATTERN);
  }
  const live = items.filter((i) => !i.del);
  const folders = new Map(live.filter((i) => i.tp === "FOLDER").map((f) => [f.id, f]));
  const trackerFolder = live.find((f) => f.tp === "FOLDER" && f.nm === TRACKER_FOLDER && !folders.has(f.pid ?? ""));
  const trackerFolderAny = trackerFolder ?? live.find((f) => f.tp === "FOLDER" && f.nm === TRACKER_FOLDER);
  const inTrackerFolder = (pid?: string) => {
    let cur = pid ? folders.get(pid) : undefined;
    let guard = 0;
    while (cur && guard++ < 50) {
      if (cur.nm === TRACKER_FOLDER) return true;
      cur = cur.pid ? folders.get(cur.pid) : undefined;
    }
    return false;
  };
  const trackerFile = trackerFolderAny
    ? live.find((f) => f.tp === "FILE" && f.nm === TRACKER_FILE && f.pid === trackerFolderAny.id)
    : undefined;

  const byKey = new Map<string, { parsed: ParsedName; files: Map<number, SnapshotItem[]> }>();
  const fileDocs: SnapshotItem[] = [];
  const exts = new Set((tracker.settings.trackExts ?? "").split(/[\s,;]+/).map((e) => e.replace(/^\./, "").toLowerCase()).filter(Boolean));
  const unnumbered: Register["unnumbered"] = [];
  const userName = (id?: string) => (id ? users.get(id)?.name ?? id : undefined);

  for (const f of live) {
    if (f.tp !== "FILE" || inTrackerFolder(f.pid)) continue;
    const p = parseName(f.nm, re);
    const ext = f.nm.includes(".") ? f.nm.slice(f.nm.lastIndexOf(".") + 1).toLowerCase() : "";
    if (!p && exts.has(ext)) {
      fileDocs.push(f);
      continue;
    }
    if (!p) {
      unnumbered.push({ fileId: f.id, name: f.nm, folderPath: folderPathOf(f.pid, folders), modified: f.mt, modifiedBy: userName(f.mid) });
      continue;
    }
    let entry = byKey.get(p.key);
    if (!entry) byKey.set(p.key, (entry = { parsed: p, files: new Map() }));
    // keep the title from the highest revision that has one
    if (p.title && (!entry.parsed.title || p.rev >= entry.parsed.rev)) entry.parsed = p;
    const list = entry.files.get(p.rev) ?? [];
    list.push(f);
    entry.files.set(p.rev, list);
  }

  const trByRev = new Map<string, string[]>();
  for (const t of tracker.transmittals)
    for (const it of t.items) {
      const l = trByRev.get(it.key) ?? [];
      if (!l.includes(t.id)) l.push(t.id);
      trByRev.set(it.key, l);
    }

  const docs: DocRow[] = [];
  for (const [key, { parsed, files }] of byKey) {
    const revNums = [...files.keys()].sort((a, b) => a - b);
    const eff = effectiveStatuses(key, revNums, tracker.status);
    const revs: RevRow[] = revNums.map((r) => {
      const list = [...files.get(r)!].sort((a, b) => (b.mt ?? "").localeCompare(a.mt ?? ""));
      const f = list[0];
      return {
        rev: r,
        revLabel: revLabel(r),
        fileId: f.id,
        versionId: f.vid,
        name: f.nm,
        folderId: f.pid,
        folderPath: folderPathOf(f.pid, folders),
        modified: f.mt,
        modifiedBy: userName(f.mid),
        size: f.sz,
        connectVersion: f.rv,
        stored: tracker.status[revId(key, revLabel(r))],
        status: eff.get(r)!,
        duplicates: list.length - 1,
      };
    });
    const current = revs[revs.length - 1];
    docs.push({
      kind: "numbered",
      key,
      label: key,
      proj: parsed.proj,
      disc: parsed.disc,
      type: parsed.type,
      num: parsed.num,
      title: parsed.title,
      revs,
      current,
      status: current.status,
      transmittals: trByRev.get(key) ?? [],
    });
  }
  for (const f of fileDocs) {
    const key = `f:${f.id}`;
    const v = f.rv ?? 1;
    const label = f.nm.replace(/\.[^.]+$/, "");
    // only the current version exists in the snapshot; older versions' statuses stay in tracker.status
    const stored = tracker.status[revId(key, `v${v}`)];
    const folder = f.pid ? folders.get(f.pid) : undefined;
    const rev: RevRow = {
      rev: v, revLabel: `v${v}`, fileId: f.id, versionId: f.vid, name: f.nm, folderId: f.pid,
      folderPath: folderPathOf(f.pid, folders), modified: f.mt, modifiedBy: userName(f.mid), size: f.sz,
      connectVersion: v, stored, status: stored ?? "Draft", duplicates: 0,
    };
    docs.push({
      kind: "file", key, label, proj: "", disc: folder?.nm ?? "/", type: (f.nm.split(".").pop() ?? "").toUpperCase(),
      num: label, title: "", revs: [rev], current: rev, status: rev.status, transmittals: trByRev.get(key) ?? [],
    });
  }
  docs.sort((a, b) =>
    a.kind !== b.kind ? (a.kind === "numbered" ? -1 : 1)
    : a.kind === "file" ? a.disc.localeCompare(b.disc) || a.label.localeCompare(b.label, undefined, { numeric: true })
    : a.key.localeCompare(b.key, undefined, { numeric: true }));
  unnumbered.sort((a, b) => a.folderPath.localeCompare(b.folderPath) || a.name.localeCompare(b.name));
  return { docs, unnumbered, folders, trackerFolderId: trackerFolderAny?.id, trackerFileId: trackerFile?.id };
}

// ---------- Mutations (pure: return a new tracker) ----------
export interface Actor { name: string; id?: string }

export function setStatus(t: Tracker, key: string, rev: string, to: DocStatus, from: DocStatus, actor: Actor, note?: string, transmittal?: string, at = new Date().toISOString()): Tracker {
  if (from === to && t.status[revId(key, rev)] === to) return t;
  return {
    ...t,
    status: { ...t.status, [revId(key, rev)]: to },
    log: [...t.log, { at, by: actor.name, byId: actor.id, key, rev, from, to, ...(note ? { note } : {}), ...(transmittal ? { transmittal } : {}) }],
  };
}

export function statusForPurpose(p: TransmittalPurpose): DocStatus {
  return p === "For approval" ? "For approval" : "Issued";
}

export function mostCommonProject(docs: DocRow[]): string | undefined {
  const c = new Map<string, number>();
  for (const d of docs) if (d.proj) c.set(d.proj, (c.get(d.proj) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

export function nextTransmittalId(t: Tracker, projectCode: string): string {
  const prefix = `TR-${projectCode}-`;
  let max = 0;
  for (const x of t.transmittals)
    if (x.id.startsWith(prefix)) max = Math.max(max, parseInt(x.id.slice(prefix.length), 10) || 0);
  return prefix + String(max + 1).padStart(3, "0");
}

/** Adds a transmittal and moves every included revision to the status implied by its purpose. */
export function addTransmittal(t: Tracker, tr: Transmittal, currentStatus: (key: string, rev: string) => DocStatus, actor: Actor): Tracker {
  let next: Tracker = { ...t, transmittals: [...t.transmittals, tr] };
  const to = statusForPurpose(tr.purpose);
  for (const it of tr.items) {
    const from = currentStatus(it.key, it.rev);
    if (from === to) continue;
    // never downgrade an Issued revision back to For approval through a transmittal
    if (from === "Issued" && to === "For approval") continue;
    next = setStatus(next, it.key, it.rev, to, from, actor, undefined, tr.id, tr.createdAt);
  }
  return next;
}

export function isOverdue(due: string | undefined, done: boolean, today = new Date().toISOString().slice(0, 10)): boolean {
  return !!due && !done && due.slice(0, 10) < today;
}
