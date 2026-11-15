import { ApiError, type ConnectApi } from "./api";
import {
  addDays, addTransmittal, applyPurpose, nextRfiId, nextTransmittalId, revId, setStatus,
  type Actor, type DocRow, type DocStatus, type Rfi, type SiteCopy, type SnapshotItem, type Transmittal, type TransmittalPurpose,
  DEFAULT_SITE_FOLDER, TRACKER_FOLDER,
} from "./model";
import type { TrackerStore } from "./store";
import { isPdf, stampPdf, type StampInfo } from "./stamp";

export interface OpsContext {
  api: ConnectApi;
  store: TrackerStore;
  projectId: string;
  projectName: string;
  region: string; // project location for web links
  actor: () => Actor;
  projectCode: () => string;
  loadFont: (name: string) => Promise<ArrayBuffer>;
  progress?: (msg: string) => void;
}

const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const today = () => localDay();
/** dd.mm.yyyy; a full timestamp is shown in local time (a UTC date is "yesterday" after midnight in Bulgaria). */
const bgDate = (iso: string) => (iso.length > 10 ? localDay(new Date(iso)) : iso.slice(0, 10)).split("-").reverse().join(".");
const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 150);

export function folderUrl(projectId: string, folderId: string, region = "europe") {
  return `https://web.connect.trimble.com/projects/${projectId}/data/folder/${folderId}?region=${encodeURIComponent(region)}`;
}

/** Folder tree helper over one snapshot; creates missing folders (handles "already exists" from a parallel user). */
export class Folders {
  private items: SnapshotItem[] = [];
  private root = "";
  constructor(private api: ConnectApi) {}
  async init() {
    this.items = await this.api.snapshot();
    this.root = await this.api.rootFolderId();
  }
  private child(parent: string, name: string) {
    return this.items.find((i) => i.tp === "FOLDER" && !i.del && i.nm === name && (i.pid ?? "") === parent);
  }
  /** Root-level folders may have pid = root id or no pid at all in the snapshot. */
  private childOfRoot(name: string) {
    return this.items.find((i) => i.tp === "FOLDER" && !i.del && i.nm === name && (i.pid === this.root || !this.items.some((x) => x.id === i.pid)));
  }
  async ensure(path: string[]): Promise<string> {
    let parent = this.root;
    for (const [i, seg] of path.entries()) {
      const name = safeName(seg);
      const ex = i === 0 ? this.childOfRoot(name) : this.child(parent, name);
      if (ex) { parent = ex.id; continue; }
      let id: string;
      try {
        id = await this.api.createFolder(name, parent);
      } catch (e) {
        this.items = await this.api.snapshot();
        const again = i === 0 ? this.childOfRoot(name) : this.child(parent, name);
        if (!again) throw e;
        id = again.id;
      }
      this.items.push({ id, nm: name, pid: parent, tp: "FOLDER" });
      parent = id;
    }
    return parent;
  }
  fileIn(folderId: string, name: string) {
    return this.items.find((i) => i.tp === "FILE" && !i.del && i.pid === folderId && i.nm === name);
  }
}

export function sitePath(siteFolder?: string): string[] {
  return (siteFolder || DEFAULT_SITE_FOLDER).split("/").map((s) => s.trim()).filter(Boolean);
}

/** The part folder inside the site set: meta.part, else the parsed discipline, else the source folder name. */
export function partFolder(d: DocRow): string {
  return safeName(d.meta.part || d.disc || "Общи") || "Общи";
}

export function siteCopyName(d: DocRow): string {
  const ext = d.current.name.includes(".") ? d.current.name.slice(d.current.name.lastIndexOf(".")) : "";
  return safeName(`${d.label} ${d.current.revLabel}`) + ext;
}

export interface IssueOptions {
  purpose?: TransmittalPurpose; // default For construction
  to: string;
  attn?: string;
  note?: string;
  date?: string;
  ack?: boolean; // create the acknowledgement ToDo (when an assignee is configured)
}

export interface IssueResult { tr: Transmittal; warnings: string[]; copies: number; todoId?: string }

/**
 * "Издай за изпълнение" – one action:
 *  1. transmittal + statuses (older revisions become superseded through the effective-status rule)
 *  2. stamped controlled copy of each document in <site folder>/<part>/, previous copy stamped SUPERSEDED and moved to
 *     <site folder>/Заменени/
 *  3. one acknowledgement ToDo for the configured site group/user
 */
export async function issueForConstruction(ctx: OpsContext, docs: DocRow[], opt: IssueOptions, statusOf: (key: string, rev: string) => DocStatus): Promise<IssueResult> {
  const { api, store } = ctx;
  const warnings: string[] = [];
  const actor = ctx.actor();
  const purpose = opt.purpose ?? "For construction";
  const now = new Date().toISOString();
  let tr!: Transmittal;
  ctx.progress?.("Трансмитал…");
  // 1. the transmittal record only; statuses follow per document once its controlled copy exists (a failed copy can be retried)
  await store.save((t) => {
    tr = {
      id: nextTransmittalId(t, ctx.projectCode()), date: opt.date || today(), to: opt.to.trim() || "Обект / Site", attn: opt.attn?.trim() || undefined,
      purpose, note: opt.note?.trim() || undefined, by: actor.name, byId: actor.id, createdAt: now,
      items: docs.map((d) => ({ key: d.key, ...(d.source === "file" ? { label: d.label } : {}), rev: d.current.revLabel, name: d.current.name, title: d.title || undefined, fileId: d.current.fileId, versionId: d.current.versionId })),
    };
    return addTransmittal(t, tr, statusOf, actor, purpose !== "For construction");
  });

  let copies = 0;
  if (purpose === "For construction") {
    const folders = new Folders(api);
    await folders.init();
    const base = sitePath(store.tracker.settings.siteFolder);
    const newSite: Record<string, SiteCopy> = {};
    const ok: string[] = [];
    for (const [i, d] of docs.entries()) {
      ctx.progress?.(`Копие за обекта ${i + 1}/${docs.length}: ${d.label}`);
      try {
        const folderId = await folders.ensure([...base, partFolder(d)]);
        const name = siteCopyName(d);
        let bytes: ArrayBuffer | Uint8Array = await api.readBytes(d.current.fileId, d.current.versionId);
        if (isPdf(d.current.name)) {
          try {
            bytes = await stampPdf(bytes, stampInfo(ctx, d, "construction", tr, folderUrl(ctx.projectId, folderId, ctx.region)), ctx.loadFont);
          } catch (e: any) {
            warnings.push(`${d.label}: печатът не можа да се постави (${e?.message ?? e}); копирано без печат`);
          }
        }
        const up = await api.upload(folderId, name, new Blob([bytes as BlobPart], { type: isPdf(name) ? "application/pdf" : "application/octet-stream" }));
        newSite[d.key] = { fileId: up.fileId, rev: d.current.revLabel, folderId, name, at: now };
        ok.push(d.key);
        copies++;
        const old = store.tracker.site[d.key];
        if (old && old.fileId !== up.fileId) {
          try { await retireCopy(ctx, folders, base, old, d, tr); } catch (e: any) { warnings.push(`${d.label}: старото копие ${old.name} не беше преместено (${e?.message ?? e})`); }
        }
      } catch (e: any) {
        warnings.push(`${d.label}: копието за обекта не беше създадено – документът НЕ е издаден, опитайте пак (${e?.message ?? e})`);
      }
    }
    // 2. statuses + site copies together, only for the documents that got their copy
    await store.save((t) => {
      const withStatus = applyPurpose(t, tr, ok, statusOf, actor);
      const items = tr.items.filter((it) => ok.includes(it.key));
      const transmittals = withStatus.transmittals.map((x) => (x.id === tr.id ? { ...x, items: items.length ? items : x.items, ...(items.length ? {} : { note: [x.note, "НЕУСПЕШНО – няма създадени копия"].filter(Boolean).join(" · ") }) } : x));
      return { ...withStatus, transmittals, site: { ...withStatus.site, ...newSite } };
    });
    tr = store.tracker.transmittals.find((x) => x.id === tr.id) ?? tr;
    if (!ok.length) return { tr, warnings, copies };
  }

  let todoId: string | undefined;
  const who = store.tracker.settings.ackAssignee;
  if (opt.ack !== false && who && purpose === "For construction") {
    ctx.progress?.("Задача за потвърждение…");
    try {
      const todo = await api.createTodo({
        title: `За изпълнение: ${tr.items.length} ${tr.items.length === 1 ? "документ" : "документа"} (${tr.id})`,
        description: [
          `Издадени за изпълнение на ${bgDate(tr.date)} от ${actor.name}:`,
          ...tr.items.map((it) => `• ${it.label ?? it.key} ${it.rev}${it.title ? " – " + it.title : ""}`),
          "",
          `Текущите чертежи са в папка „${store.tracker.settings.siteFolder || DEFAULT_SITE_FOLDER}“. Заменените копия са в „Заменени“.`,
          "Моля, потвърдете получаването, като затворите тази задача.",
          `[tr:${tr.id}]`,
        ].join("\n"),
        dueDate: new Date(addDays(tr.date, 2) + "T12:00:00Z").toISOString(),
        assignees: [{ id: who.id, type: who.type }],
        priority: "HIGH",
      });
      todoId = todo?.id;
      if (todoId) await store.save((t) => ({ ...t, transmittals: t.transmittals.map((x) => (x.id === tr.id ? { ...x, todoId, ackTarget: who.name } : x)) }));
    } catch (e: any) {
      warnings.push(`Задачата за потвърждение не беше създадена (${e?.message ?? e})`);
    }
  }
  return { tr: store.tracker.transmittals.find((x) => x.id === tr.id) ?? tr, warnings, copies, todoId };
}

function stampInfo(ctx: OpsContext, d: DocRow, kind: StampInfo["kind"], tr?: Transmittal, qr?: string, extra: Partial<StampInfo> = {}): StampInfo {
  return {
    kind, project: ctx.projectName, doc: d.label + (d.title ? " · " + d.title : ""), rev: d.current.revLabel,
    date: bgDate(tr?.date ?? today()), by: ctx.actor().name, ref: tr?.id, qr, ...extra,
  };
}

/** Stamp the previous controlled copy SUPERSEDED (as a new version of that copy) and move it to Заменени. */
async function retireCopy(ctx: OpsContext, folders: Folders, base: string[], old: SiteCopy, d: DocRow, tr: Transmittal) {
  const { api } = ctx;
  if (isPdf(old.name)) {
    const bytes = await api.readBytes(old.fileId);
    const out = await stampPdf(bytes, {
      kind: "superseded", project: ctx.projectName, doc: d.label, rev: old.rev, date: bgDate(tr.date), by: ctx.actor().name, supersededBy: d.current.revLabel,
    }, ctx.loadFont);
    await api.upload(old.folderId, old.name, new Blob([out as BlobPart], { type: "application/pdf" }));
  }
  const zam = await folders.ensure([...base, "Заменени"]);
  try {
    await api.moveFile(old.fileId, zam);
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) return; // a file with that name is already there: leave the stamped copy in place
    throw e;
  }
}

/** Withdraw a document from site (e.g. issued by mistake, or superseded without a replacement). */
export async function withdrawFromSite(ctx: OpsContext, d: DocRow, note: string): Promise<string[]> {
  const warnings: string[] = [];
  const old = ctx.store.tracker.site[d.key];
  const actor = ctx.actor();
  if (old) {
    try {
      const folders = new Folders(ctx.api);
      await folders.init();
      const tr = { id: "", date: today() } as Transmittal;
      await retireCopy(ctx, folders, sitePath(ctx.store.tracker.settings.siteFolder), old, { ...d, current: { ...d.current, revLabel: "—" } }, tr);
    } catch (e: any) {
      warnings.push(`Копието ${old.name} не беше маркирано/преместено (${e?.message ?? e}); проверете папката ръчно.`);
    }
  }
  const rev = old?.rev ?? d.current.revLabel; // the revision that was on site
  await ctx.store.save((t) => {
    const site = { ...t.site };
    delete site[d.key];
    const n = setStatus(t, d.key, rev, "superseded", "construction", actor, note || "Изтеглен от обекта");
    return { ...n, site };
  });
  return warnings;
}

// ---------- RFIs ----------
export interface RfiInput { title: string; question: string; docs: string[]; location?: string; due?: string; assignee?: Rfi["assignee"] }

export async function createRfi(ctx: OpsContext, inp: RfiInput, labelOf: (key: string) => string): Promise<{ rfi: Rfi; warning?: string }> {
  const actor = ctx.actor();
  let rfi!: Rfi;
  await ctx.store.save((t) => {
    rfi = {
      id: nextRfiId(t, ctx.projectCode()), title: inp.title.trim(), question: inp.question.trim(), docs: inp.docs, location: inp.location?.trim() || undefined,
      askedBy: actor.name, askedById: actor.id, askedAt: new Date().toISOString(), assignee: inp.assignee, due: inp.due, state: "open",
    };
    return { ...t, rfis: [...t.rfis, rfi] };
  });
  const warning = await ensureRfiTodo(ctx, rfi.id, labelOf);
  return { rfi: ctx.store.tracker.rfis.find((x) => x.id === rfi.id) ?? rfi, warning };
}

/** Creates the Connect ToDo of an RFI if it has none yet (also the "retry" when Connect refused it the first time). */
export async function ensureRfiTodo(ctx: OpsContext, id: string, labelOf: (key: string) => string): Promise<string | undefined> {
  const rfi = ctx.store.tracker.rfis.find((x) => x.id === id);
  if (!rfi || rfi.todoId) return undefined;
  try {
    const todo = await ctx.api.createTodo({
      title: `${rfi.id}: ${rfi.title}`,
      description: [
        rfi.question,
        rfi.docs.length ? "Документи: " + rfi.docs.map(labelOf).join(", ") : "",
        rfi.location ? "Място: " + rfi.location : "",
        `Зададен от ${rfi.askedBy}. Отговорете в „Документи“ (Arsten / MULTIPLAN) или в коментар тук.`,
        `[rfi:${rfi.id}]`,
      ].filter(Boolean).join("\n"),
      dueDate: rfi.due ? new Date(rfi.due + "T12:00:00Z").toISOString() : undefined,
      assignees: rfi.assignee ? [{ id: rfi.assignee.id, type: rfi.assignee.type }] : undefined,
      type: "Request",
    });
    if (todo?.id) await ctx.store.save((t) => ({ ...t, rfis: t.rfis.map((x) => (x.id === id ? { ...x, todoId: todo.id } : x)) }));
    return undefined;
  } catch (e: any) {
    return `Задачата в Connect не беше създадена (${e?.message ?? e}); въпросът е записан само тук.`;
  }
}

export async function answerRfi(ctx: OpsContext, id: string, answer: string, outcome: Rfi["outcome"]) {
  const actor = ctx.actor();
  await ctx.store.save((t) => ({
    ...t,
    rfis: t.rfis.map((x) => (x.id === id ? { ...x, answer: answer.trim(), outcome, answeredBy: actor.name, answeredAt: new Date().toISOString(), state: "answered" } : x)),
  }));
  const r = ctx.store.tracker.rfis.find((x) => x.id === id);
  if (r?.todoId) { try { await ctx.api.updateTodo(r.todoId, { status: "RESOLVED" }); } catch { /* the answer is saved; the ToDo stays open */ } }
}

export async function closeRfi(ctx: OpsContext, id: string) {
  const actor = ctx.actor();
  await ctx.store.save((t) => ({ ...t, rfis: t.rfis.map((x) => (x.id === id ? { ...x, state: "closed", closedBy: actor.name, closedAt: new Date().toISOString() } : x)) }));
  const r = ctx.store.tracker.rfis.find((x) => x.id === id);
  if (r?.todoId) { try { await ctx.api.updateTodo(r.todoId, { status: "CLOSED" }); } catch { /* ignore */ } }
}

// ---------- shop drawings (submittals) ----------
/** Designer decision A/B/C/D. Writes a review-stamped copy next to the tracker (Submittals/) for the fabricator. */
export async function decideSubmittal(ctx: OpsContext, d: DocRow, decision: "A" | "B" | "C" | "D", remark: string): Promise<string[]> {
  const warnings: string[] = [];
  const actor = ctx.actor();
  await ctx.store.save((t) => setStatus(t, d.key, d.current.revLabel, decision, d.status, actor, remark || undefined));
  if (isPdf(d.current.name)) {
    try {
      const folders = new Folders(ctx.api);
      await folders.init();
      const folderId = await folders.ensure([TRACKER_FOLDER, "Submittals"]);
      const bytes = await ctx.api.readBytes(d.current.fileId, d.current.versionId);
      const out = await stampPdf(bytes, stampInfo(ctx, d, "review", undefined, undefined, { decision, remark: remark || undefined }), ctx.loadFont);
      await ctx.api.upload(folderId, safeName(`${d.label} ${d.current.revLabel} - ${decision}`) + ".pdf", new Blob([out as BlobPart], { type: "application/pdf" }));
    } catch (e: any) {
      warnings.push(`Копието с печат не беше създадено (${e?.message ?? e})`);
    }
  }
  return warnings;
}

/** Acknowledgement ToDos: a closed ToDo counts as "received" by whoever closed it. */
export async function ackTodoStates(api: ConnectApi, trs: Transmittal[]): Promise<Map<string, { closed: boolean; by?: string; at?: string }>> {
  const out = new Map<string, { closed: boolean; by?: string; at?: string }>();
  const ids = trs.filter((t) => t.todoId).map((t) => t.todoId!);
  if (!ids.length) return out;
  let list: any[] = [];
  try { list = await api.listTodos(); } catch { return out; }
  for (const td of list) {
    if (!ids.includes(td.id)) continue;
    const closed = td.status === "CLOSED" || td.status === "RESOLVED";
    const by = td.modifiedBy ? [td.modifiedBy.firstName, td.modifiedBy.lastName].filter(Boolean).join(" ") : undefined;
    out.set(td.id, { closed, by, at: td.modifiedOn });
  }
  return out;
}

export { revId };
