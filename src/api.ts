import type { SnapshotItem, UserRef } from "./model";

/** Region service map from GET https://app.connect.trimble.com/tc/api/2.0/regions (no auth). */
export interface RegionInfo {
  location: string; // "europe"
  region?: string; // "eu"
  trnRegion?: string;
  "tc-api": string; // https://app21.connect.trimble.com/tc/api/2.0/
  "connect-api"?: string; // https://eu.api.trimble.com/connect
  "issues-api"?: string; // https://app21.connect.trimble.com/v1/
  "pset-api"?: string;
  "topic-api"?: string; // BCF API, https://open21.connect.trimble.com/
}

const REGIONS_URL = "https://app.connect.trimble.com/tc/api/2.0/regions";
const EU_FALLBACK: RegionInfo = {
  location: "europe",
  region: "eu",
  trnRegion: "eu",
  "tc-api": "https://app21.connect.trimble.com/tc/api/2.0/",
  "connect-api": "https://eu.api.trimble.com/connect",
  "issues-api": "https://app21.connect.trimble.com/v1/",
  "topic-api": "https://open21.connect.trimble.com/",
};

export class ApiError extends Error {
  constructor(public status: number, public url: string, public body: string) {
    super(`HTTP ${status} ${url.replace(/\?.*/, "")}${body ? ": " + body.slice(0, 300) : ""}`);
  }
}

const trim = (u: string) => u.replace(/\/+$/, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function loadRegions(): Promise<RegionInfo[]> {
  try {
    const r = await fetch(REGIONS_URL);
    if (r.ok) return (await r.json()) as RegionInfo[];
  } catch {
    /* offline or blocked: fall through */
  }
  return [EU_FALLBACK];
}

export function pickRegion(regions: RegionInfo[], projectLocation?: string): RegionInfo {
  const loc = (projectLocation ?? "").toLowerCase();
  return (
    regions.find((r) => r.location?.toLowerCase() === loc) ??
    regions.find((r) => (r.region ?? "").toLowerCase() === loc) ??
    regions.find((r) => r.location === "europe") ??
    EU_FALLBACK
  );
}

export interface UploadResult { fileId: string; versionId?: string }

export interface ConnectApi {
  readonly projectId: string;
  readonly mode: string; // "core-v2" | "legacy" | "mock"
  snapshot(): Promise<SnapshotItem[]>;
  users(): Promise<UserRef[]>;
  rootFolderId(): Promise<string>;
  readText(fileId: string): Promise<{ text: string; versionId: string }>;
  createFolder(name: string, parentId: string): Promise<string>;
  upload(parentId: string, name: string, body: Blob, ifMatchVersionId?: string, mustBeNew?: boolean): Promise<UploadResult>;
  downloadUrl(fileId: string, versionId?: string): Promise<string>;
  // legacy ToDos (Connect native)
  listTodos(): Promise<NativeTodo[]>;
  createTodo(t: NativeTodoInput): Promise<NativeTodo>;
  updateTodo(id: string, t: Partial<NativeTodoInput>): Promise<NativeTodo>;
  probe(): Promise<ProbeResult[]>;
  /** BCF test: create a topic, comment, viewpoint, read back, close. Returns one line per step. */
  bcfTest?(): Promise<ProbeResult[]>;
  versions(fileId: string): Promise<FileVersion[]>;
  groups(): Promise<GroupRef[]>;
  groupMembers(groupId: string): Promise<string[]>;
  readBytes(fileId: string, versionId?: string): Promise<ArrayBuffer>;
  moveFile(fileId: string, parentId: string): Promise<void>;
  getTodo(id: string): Promise<NativeTodo | undefined>;
}

export interface GroupRef { id: string; name: string }

export interface FileVersion { versionId: string; revision: number; modified?: string; modifiedBy?: string; size?: number }

export interface ProbeResult { name: string; url: string; ok: boolean; status: string; ms: number }

export type NativeTodoStatus = "NEW" | "IN_PROGRESS" | "RESOLVED" | "BLOCKED" | "CLOSED";
export interface NativeTodo {
  id: string;
  label?: string;
  title: string;
  description?: string;
  dueDate?: string;
  status: NativeTodoStatus;
  priority?: string;
  assignees?: { id: string; name?: string; firstName?: string; lastName?: string; type: string }[];
  createdBy?: { firstName?: string; lastName?: string };
  createdOn?: string;
  modifiedBy?: { firstName?: string; lastName?: string };
  modifiedOn?: string;
}
export interface NativeTodoInput {
  title: string;
  description?: string;
  dueDate?: string;
  status?: NativeTodoStatus;
  priority?: "LOW" | "NORMAL" | "HIGH" | "CRITICAL";
  assignees?: { id: string; type: "USER" | "GROUP" }[];
  type?: string;
}

/** Thin REST client. `fs` endpoints (snapshot/upload/downloadurl/folders) are identical on Core v2 and legacy 2.0. */
export class RestConnectApi implements ConnectApi {
  constructor(
    public readonly projectId: string,
    private token: () => Promise<string>,
    public readonly region: RegionInfo,
    /** base for files/folders/projects: Core v2 or legacy */
    private coreBase: string,
    public readonly mode: "core-v2" | "legacy",
  ) {}

  static async create(projectId: string, projectLocation: string | undefined, token: () => Promise<string>): Promise<RestConnectApi> {
    const region = pickRegion(await loadRegions(), projectLocation);
    const v2 = region["connect-api"] ? trim(region["connect-api"]) + "/v2" : undefined;
    const legacy = trim(region["tc-api"]);
    // Verified 2026-11-08 in project 1028: Core v2 (eu.api.trimble.com) sends no CORS headers for the
    // extension origin, while legacy 2.0 answers everything we need. Use legacy unless ?core=v2 is set.
    if (v2 && new URLSearchParams(location.search).get("core") === "v2") {
      const api = new RestConnectApi(projectId, token, region, v2, "core-v2");
      try {
        await api.json(`${v2}/projects/${projectId}`);
        return api;
      } catch (e) {
        console.warn("[arsten-docs] Core v2 not usable, falling back to legacy 2.0", e);
      }
    }
    return new RestConnectApi(projectId, token, region, legacy, "legacy");
  }

  get legacyBase() { return trim(this.region["tc-api"]); }

  async request(url: string, init: RequestInit = {}, attempt = 0): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${await this.token()}`);
    if (init.body && typeof init.body === "string" && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    let res: Response;
    try {
      res = await fetch(url, { ...init, headers });
    } catch (e) {
      if (attempt < 2) { await sleep(1000 * 4 ** attempt); return this.request(url, init, attempt + 1); }
      throw e;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await sleep(1000 * 4 ** attempt);
      return this.request(url, init, attempt + 1);
    }
    if (!res.ok) throw new ApiError(res.status, url, await res.text().catch(() => ""));
    return res;
  }

  async json<T = any>(url: string, init?: RequestInit): Promise<T> {
    const r = await this.request(url, init);
    if (r.status === 204) return undefined as T;
    const text = await r.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  private abs(next: string) {
    if (/^https?:/i.test(next)) return next;
    const origin = new URL(this.coreBase).origin;
    return next.startsWith("/") ? origin + next : `${this.coreBase}/${next}`;
  }

  async snapshot(): Promise<SnapshotItem[]> {
    const out: SnapshotItem[] = [];
    let url: string | undefined = `${this.coreBase}/files/fs/snapshot?projectId=${encodeURIComponent(this.projectId)}`;
    let guard = 0;
    while (url && guard++ < 50) {
      const r: any = await this.json(url);
      if (Array.isArray(r)) { out.push(...r); break; }
      out.push(...(r?.items ?? []));
      url = r?.next ? this.abs(r.next) : undefined;
    }
    return out;
  }

  async users(): Promise<UserRef[]> {
    const r: any = await this.json(`${this.coreBase}/projects/${this.projectId}/users`);
    const list: any[] = Array.isArray(r) ? r : r?.items ?? [];
    return list.map((u) => ({
      id: u.id,
      name: [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || u.id,
      email: u.email,
      role: u.role,
    }));
  }

  async rootFolderId(): Promise<string> {
    const p: any = await this.json(`${this.coreBase}/projects/${this.projectId}`);
    if (!p?.rootId) throw new Error("Project has no rootId");
    return p.rootId;
  }

  async downloadUrl(fileId: string, versionId?: string): Promise<string> {
    const q = versionId ? `?versionId=${encodeURIComponent(versionId)}` : "";
    const r: any = await this.json(`${this.coreBase}/files/fs/${fileId}/downloadurl${q}`);
    return r.url;
  }

  async readText(fileId: string) {
    const r: any = await this.json(`${this.coreBase}/files/fs/${fileId}/downloadurl`);
    const res = await fetch(r.url, { cache: "no-store" });
    if (!res.ok) throw new ApiError(res.status, "download", await res.text().catch(() => ""));
    return { text: await res.text(), versionId: r.versionId as string };
  }

  async createFolder(name: string, parentId: string): Promise<string> {
    const r: any = await this.json(`${this.coreBase}/folders`, { method: "POST", body: JSON.stringify({ name, parentId }) });
    return r.id;
  }

  async upload(parentId: string, name: string, body: Blob, ifMatchVersionId?: string, mustBeNew?: boolean): Promise<UploadResult> {
    const headers: Record<string, string> = { "tc-enable-process": "false" };
    if (ifMatchVersionId) headers["If-Match"] = ifMatchVersionId;
    else if (mustBeNew) headers["If-None-Match"] = "*"; // fail if someone created the file meanwhile
    const init: any = await this.json(
      `${this.coreBase}/files/fs/upload?parentId=${encodeURIComponent(parentId)}&parentType=FOLDER`,
      { method: "POST", headers, body: JSON.stringify({ name }) },
    );
    const put = init?.contents?.[0]?.url ?? init?.uploadUrl;
    if (!put) throw new Error("Upload URL missing in response");
    const res = await fetch(put, { method: "PUT", body });
    if (!res.ok) throw new ApiError(res.status, "upload PUT", await res.text().catch(() => ""));
    // poll until DONE
    for (let i = 0; i < 30; i++) {
      const st: any = await this.json(`${this.coreBase}/files/fs/upload?uploadId=${encodeURIComponent(init.uploadId)}&wait=true`);
      if (st.status === "DONE") return { fileId: st.fileId, versionId: st.versionId };
      if (st.status === "ERROR" || st.status === "EXPIRED") throw new Error(`Upload ${st.status}: ${st.errorReason ?? ""}`);
      await sleep(Math.min(500 * (i + 1), 3000));
    }
    throw new Error("Upload did not finish in time");
  }

  async versions(fileId: string): Promise<FileVersion[]> {
    const r: any = await this.json(`${this.legacyBase}/files/${fileId}/versions?projectId=${encodeURIComponent(this.projectId)}`);
    const list: any[] = Array.isArray(r) ? r : r?.items ?? [];
    return list.map((v) => ({
      versionId: v.versionId ?? v.id,
      revision: v.revision ?? v.rv ?? 0,
      modified: v.modifiedOn ?? v.modified,
      modifiedBy: v.modifiedBy ? [v.modifiedBy.firstName, v.modifiedBy.lastName].filter(Boolean).join(" ") : undefined,
      size: v.size,
    })).sort((a, b) => b.revision - a.revision);
  }

  async groups(): Promise<GroupRef[]> {
    const r: any = await this.json(`${this.legacyBase}/groups?projectId=${encodeURIComponent(this.projectId)}`, { headers: { Range: "items=0-999" } });
    const list: any[] = Array.isArray(r) ? r : r?.items ?? [];
    return list.map((g) => ({ id: g.id, name: g.name }));
  }

  async groupMembers(groupId: string): Promise<string[]> {
    const r: any = await this.json(`${this.legacyBase}/groups/${encodeURIComponent(groupId)}/users`, { headers: { Range: "items=0-999" } });
    const list: any[] = Array.isArray(r) ? r : r?.items ?? [];
    return list.map((u) => u.id);
  }

  async readBytes(fileId: string, versionId?: string): Promise<ArrayBuffer> {
    const url = await this.downloadUrl(fileId, versionId);
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new ApiError(res.status, "download", await res.text().catch(() => ""));
    return res.arrayBuffer();
  }

  async moveFile(fileId: string, parentId: string): Promise<void> {
    await this.json(`${this.legacyBase}/files/${encodeURIComponent(fileId)}`, { method: "PATCH", body: JSON.stringify({ parentId }) });
  }

  async getTodo(id: string): Promise<NativeTodo | undefined> {
    try { return await this.json(`${this.legacyBase}/todos/${encodeURIComponent(id)}`); } catch (e) { if (e instanceof ApiError && e.status === 404) return undefined; throw e; }
  }

  async listTodos(): Promise<NativeTodo[]> {
    const r: any = await this.json(`${this.legacyBase}/todos?projectId=${encodeURIComponent(this.projectId)}`, {
      headers: { Range: "items=0-999" },
    });
    return Array.isArray(r) ? r : r?.items ?? [];
  }

  /** Connect is picky about the due-date format ("invalid date format" for toISOString()); try the known forms, and as a
   *  last resort create the ToDo without a due date (the date is then only in the description). */
  async createTodo(t: NativeTodoInput): Promise<NativeTodo> {
    const day = t.dueDate ? t.dueDate.slice(0, 10) : "";
    const forms = day ? [`${day}T12:00:00.000+0000`, `${day}T12:00:00+0000`, `${day}T12:00:00Z`, `${day}`, ""] : [""];
    let last: unknown;
    for (const due of forms) {
      const body: any = { type: "Request", priority: "NORMAL", status: "NEW", ...t, projectId: this.projectId };
      if (due) body.dueDate = due; else { delete body.dueDate; if (day) body.description = `${body.description ?? ""}
Срок: ${day.split("-").reverse().join(".")}`.trim(); }
      try {
        return await this.json(`${this.legacyBase}/todos`, { method: "POST", body: JSON.stringify(body) });
      } catch (e) {
        last = e;
        if (!(e instanceof ApiError && e.status === 400 && /date/i.test(e.body))) throw e;
      }
    }
    throw last;
  }

  async updateTodo(id: string, t: Partial<NativeTodoInput>): Promise<NativeTodo> {
    return this.json(`${this.legacyBase}/todos/${id}`, { method: "PATCH", body: JSON.stringify(t) });
  }

  get bcfBase() { return trim(this.region["topic-api"] ?? "https://open21.connect.trimble.com/") + "/bcf"; }

  async bcfTest(): Promise<ProbeResult[]> {
    const base = `${this.bcfBase}/2.1/projects/${encodeURIComponent(this.projectId)}`;
    const out: ProbeResult[] = [];
    const step = async <T>(name: string, url: string, init?: RequestInit): Promise<T | undefined> => {
      const t0 = performance.now();
      try {
        const v = await this.json<T>(url, init);
        out.push({ name, url, ok: true, status: JSON.stringify(v ?? "").slice(0, 160), ms: Math.round(performance.now() - t0) });
        return v;
      } catch (e: any) {
        out.push({ name, url, ok: false, status: e instanceof ApiError ? `${e.status} ${e.body.slice(0, 160)}` : `blocked (${e?.message ?? e})`, ms: Math.round(performance.now() - t0) });
        return undefined;
      }
    };
    const ext = await step<any>("extensions", `${base}/extensions`);
    const types: string[] = ext?.topic_type ?? [];
    const statuses: string[] = ext?.topic_status ?? [];
    const type = types.find((t) => /request|rfi|question|въпрос/i.test(t)) ?? types[0];
    const topic: any = {
      title: "ТЕСТ: BCF проба от Документи (може да се изтрие)",
      description: "Автоматична проба: създаване, коментар, изглед, затваряне. RFI-TEST-000.",
      labels: ["RFI"],
      ...(type ? { topic_type: type } : {}),
      ...(statuses[0] ? { topic_status: statuses[0] } : {}),
    };
    const created = await step<any>("create topic", `${base}/topics`, { method: "POST", body: JSON.stringify(topic) });
    if (!created?.guid) return out;
    const tUrl = `${base}/topics/${created.guid}`;
    await step("comment", `${tUrl}/comments`, { method: "POST", body: JSON.stringify({ comment: "Проба: отговор на въпроса." }) });
    await step("viewpoint", `${tUrl}/viewpoints`, { method: "POST", body: JSON.stringify({
      perspective_camera: { camera_view_point: { x: 10, y: -10, z: 10 }, camera_direction: { x: -1, y: 1, z: -1 }, camera_up_vector: { x: 0, y: 0, z: 1 }, field_of_view: 60 },
    }) });
    await step("read topic", tUrl);
    await step("read comments", `${tUrl}/comments`);
    const closed = statuses.find((s) => /closed|done|resolved|затвор/i.test(s));
    if (closed) await step(`close (${closed})`, tUrl, { method: "PUT", body: JSON.stringify({ ...topic, topic_status: closed }) });
    out.push({ name: "topic guid", url: tUrl, ok: true, status: `${created.guid} · types: ${types.join(", ")} · statuses: ${statuses.join(", ")}`, ms: 0 });
    return out;
  }

  /** Diagnostics: one call per API family, reports status without throwing. */
  async probe(): Promise<ProbeResult[]> {
    const pid = encodeURIComponent(this.projectId);
    const v2 = this.region["connect-api"] ? trim(this.region["connect-api"]) + "/v2" : "";
    const issues = this.region["issues-api"] ? trim(this.region["issues-api"]) : "";
    const trn = `trn:2:tc:${this.region.trnRegion ?? this.region.region ?? "eu"}:projects:${this.projectId}`;
    const checks: [string, string, RequestInit?][] = [
      ["Core v2 · project", `${v2}/projects/${pid}`],
      ["Core v2 · file snapshot", `${v2}/files/fs/snapshot?projectId=${pid}&maxItems=5`],
      ["Core v2 · project users", `${v2}/projects/${pid}/users`],
      ["Legacy 2.0 · project", `${this.legacyBase}/projects/${pid}`],
      ["Legacy 2.0 · ToDos", `${this.legacyBase}/todos?projectId=${pid}`, { headers: { Range: "items=0-4" } }],
      ["Legacy 2.0 · Releases", `${this.legacyBase}/releases?projectId=${pid}`, { headers: { Range: "items=0-4" } }],
      ["Legacy 2.0 · change cursor", `${this.legacyBase}/projects/${pid}/status`],
      ["Issues API v1 · issues", `${issues}/context/${encodeURIComponent(trn)}/issues?pageSize=5`],
      ["BCF · versions", `${this.bcfBase}/versions`],
      ["BCF 2.1 · project", `${this.bcfBase}/2.1/projects/${pid}`],
      ["BCF 2.1 · extensions", `${this.bcfBase}/2.1/projects/${pid}/extensions`],
      ["BCF 2.1 · topics", `${this.bcfBase}/2.1/projects/${pid}/topics?$top=5`],
      ["BCF 3.0 · topics", `${this.bcfBase}/3.0/projects/${pid}/topics?$top=5`],
    ];
    const out: ProbeResult[] = [];
    for (const [name, url, init] of checks) {
      const t0 = performance.now();
      try {
        const r = await this.request(url, init, 3);
        out.push({ name, url, ok: true, status: String(r.status), ms: Math.round(performance.now() - t0) });
      } catch (e: any) {
        const status = e instanceof ApiError ? `${e.status} ${e.body.slice(0, 120)}` : `blocked (${e?.message ?? e}) - likely CORS`;
        out.push({ name, url, ok: false, status, ms: Math.round(performance.now() - t0) });
      }
    }
    return out;
  }
}
