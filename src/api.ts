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
}

const REGIONS_URL = "https://app.connect.trimble.com/tc/api/2.0/regions";
const EU_FALLBACK: RegionInfo = {
  location: "europe",
  region: "eu",
  trnRegion: "eu",
  "tc-api": "https://app21.connect.trimble.com/tc/api/2.0/",
  "connect-api": "https://eu.api.trimble.com/connect",
  "issues-api": "https://app21.connect.trimble.com/v1/",
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
  upload(parentId: string, name: string, body: Blob, ifMatchVersionId?: string): Promise<UploadResult>;
  downloadUrl(fileId: string, versionId?: string): Promise<string>;
  // legacy ToDos (Connect native)
  listTodos(): Promise<NativeTodo[]>;
  createTodo(t: NativeTodoInput): Promise<NativeTodo>;
  updateTodo(id: string, t: Partial<NativeTodoInput>): Promise<NativeTodo>;
  probe(): Promise<ProbeResult[]>;
}

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
    if (v2) {
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

  async upload(parentId: string, name: string, body: Blob, ifMatchVersionId?: string): Promise<UploadResult> {
    const headers: Record<string, string> = { "tc-enable-process": "false" };
    if (ifMatchVersionId) headers["If-Match"] = ifMatchVersionId;
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

  async listTodos(): Promise<NativeTodo[]> {
    const r: any = await this.json(`${this.legacyBase}/todos?projectId=${encodeURIComponent(this.projectId)}`, {
      headers: { Range: "items=0-999" },
    });
    return Array.isArray(r) ? r : r?.items ?? [];
  }

  async createTodo(t: NativeTodoInput): Promise<NativeTodo> {
    return this.json(`${this.legacyBase}/todos`, {
      method: "POST",
      body: JSON.stringify({ type: "Request", priority: "NORMAL", status: "NEW", ...t, projectId: this.projectId }),
    });
  }

  async updateTodo(id: string, t: Partial<NativeTodoInput>): Promise<NativeTodo> {
    return this.json(`${this.legacyBase}/todos/${id}`, { method: "PATCH", body: JSON.stringify(t) });
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
