import { ApiError, type ConnectApi, type GroupRef, type NativeTodo, type NativeTodoInput, type UploadResult } from "./api";
import type { SnapshotItem, UserRef } from "./model";

/** In-memory Connect project for running the UI outside Trimble Connect (?mock=1 or opened directly). */
export class MockConnectApi implements ConnectApi {
  readonly projectId = "MOCK-PROJECT";
  readonly mode = "mock";
  private items: SnapshotItem[] = [];
  private blobs = new Map<string, ArrayBuffer | string>();
  private todos: NativeTodo[] = [];
  private seq = 1;

  constructor(private nativeTodos = true) {
    const now = Date.now();
    const day = 86400000;
    const iso = (d: number) => new Date(now - d * day).toISOString();
    const folder = (id: string, nm: string, pid = "root") => this.items.push({ id, nm, pid, tp: "FOLDER" });
    const file = (nm: string, pid: string, d: number, mid = "u1", rv = 1) =>
      this.items.push({ id: "fl" + this.seq++, vid: "v" + this.seq, nm, pid, tp: "FILE", mt: iso(d), ct: iso(d + 3), mid, cid: mid, sz: 250000 + this.seq * 1000, rv });
    folder("f-des", "03_DESIGN");
    folder("f-ex", "04_EXECUTION");
    folder("f-fw", "20_FORMWORK PLANS", "f-ex");
    folder("f-rp", "30_REINFORCEMENT PLANS", "f-ex");
    folder("f-rpl", "LATEST DRAWINGS", "f-rp");
    folder("f-docs", "Документация");
    folder("f-acts", "Актове", "f-docs");
    folder("f-sub", "Изпълнител");
    file("1028-ST-DR-0101_R01_Фундаменти.pdf", "f-des", 30);
    file("1028-ST-DR-0101_R02_Фундаменти.pdf", "f-des", 9);
    file("1028-ST-DR-0102_R01_Колони и шайби.pdf", "f-des", 8);
    file("1028-AR-DR-0101_R01_Разпределение партер.pdf", "f-des", 12, "u2");
    file("FP1.pdf", "f-rpl", 4, "u1", 3);
    file("FP2.pdf", "f-rpl", 4, "u1", 1);
    file("FP3.pdf", "f-rpl", 3, "u1", 1);
    file("FS1.pdf", "f-rpl", 2, "u1", 2);
    file("1028-TD-ST-B01-20 Formwork plans-CP02-Кофражен план.pdf", "f-fw", 6);
    file("Акт 12 - армировка плоча +3.20.pdf", "f-acts", 1, "u2");
    file("Декларация за съответствие - армировка B500B.pdf", "f-acts", 5, "u2");
    file("Стомана - монтажен чертеж M-01.pdf", "f-sub", 2, "u3");
    file("model_v5.ifc", "f-des", 3);
    this.todos = [
      { id: "t1", label: "1", title: "Проверка на армировка плоча +3.20", status: "IN_PROGRESS", dueDate: iso(-4).slice(0, 10), assignees: [{ id: "u1", name: "Найден Кочев", type: "USER" }], createdOn: iso(6) },
    ];
  }

  async snapshot() { await delay(); return structuredClone(this.items); }
  async users(): Promise<UserRef[]> {
    return [
      { id: "u1", name: "Найден Кочев", email: "nkochev@arsten-bg.com" },
      { id: "u2", name: "Иван Георгиев" },
      { id: "u3", name: "Мария Петрова" },
    ];
  }
  async groups(): Promise<GroupRef[]> {
    return [
      { id: "g0", name: "00_ADMIN" }, { id: "g2", name: "02.GENERAL CONTRACTOR" }, { id: "g21", name: "02.1-EXECUTION PROJECT MANAGER" },
      { id: "g4", name: "04.DESIGNERS" }, { id: "g41", name: "4.1-STRUCTURAL DESIGNER" },
    ];
  }
  async groupMembers(id: string) { return id === "g0" || id === "g2" ? ["u1"] : id === "g41" ? ["u3"] : []; }
  async rootFolderId() { return "root"; }
  async readText(fileId: string) {
    const f = this.items.find((i) => i.id === fileId)!;
    const b = this.blobs.get(fileId);
    return { text: typeof b === "string" ? b : b ? new TextDecoder().decode(b) : "{}", versionId: f.vid ?? "" };
  }
  async readBytes(fileId: string): Promise<ArrayBuffer> {
    const b = this.blobs.get(fileId);
    if (b instanceof ArrayBuffer) return b;
    // seeded files: a small landscape "drawing" with a title block
    const f = this.items.find((i) => i.id === fileId)!;
    const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
    const doc = await PDFDocument.create();
    const page = doc.addPage([1190, 842]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawRectangle({ x: 20, y: 20, width: 1150, height: 802, borderColor: rgb(0, 0, 0), borderWidth: 1 });
    page.drawRectangle({ x: 870, y: 20, width: 300, height: 120, borderColor: rgb(0, 0, 0), borderWidth: 1 });
    page.drawText("DEMO DRAWING  " + f.nm.replace(/[^\x20-\x7e]/g, "?"), { x: 880, y: 110, size: 11, font });
    page.drawText("Rev v" + (f.rv ?? 1), { x: 880, y: 90, size: 11, font });
    for (let i = 0; i < 12; i++) page.drawLine({ start: { x: 100 + i * 60, y: 200 }, end: { x: 100 + i * 60, y: 700 }, thickness: 2, color: rgb(0.3, 0.3, 0.3) });
    const bytes = await doc.save();
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }
  async createFolder(name: string, parentId: string) {
    const ex = this.items.find((i) => i.tp === "FOLDER" && i.nm === name && i.pid === parentId);
    if (ex) throw new ApiError(409, "mock folder", "exists");
    const id = "fo" + this.seq++;
    this.items.push({ id, nm: name, pid: parentId, tp: "FOLDER" });
    return id;
  }
  async upload(parentId: string, name: string, body: Blob, ifMatch?: string, mustBeNew?: boolean): Promise<UploadResult> {
    await delay();
    let f = this.items.find((i) => i.tp === "FILE" && i.nm === name && i.pid === parentId);
    if (f && mustBeNew) throw new ApiError(412, "mock upload", "exists");
    if (f && ifMatch && f.vid !== ifMatch) throw new ApiError(412, "mock upload", "version conflict");
    if (!f) this.items.push((f = { id: "fl" + this.seq++, nm: name, pid: parentId, tp: "FILE", rv: 0 }));
    f.vid = "v" + this.seq++;
    f.rv = (f.rv ?? 0) + 1;
    f.mt = new Date().toISOString();
    f.mid = "u1";
    f.sz = body.size;
    this.blobs.set(f.id, await body.arrayBuffer());
    return { fileId: f.id, versionId: f.vid };
  }
  async moveFile(fileId: string, parentId: string) {
    const f = this.items.find((i) => i.id === fileId);
    if (!f) throw new ApiError(404, "mock move", "no file");
    if (this.items.some((i) => i.tp === "FILE" && i.nm === f.nm && i.pid === parentId && i.id !== fileId)) throw new ApiError(409, "mock move", "name exists");
    f.pid = parentId;
  }
  async downloadUrl(fileId: string) {
    const b = await this.readBytes(fileId);
    return URL.createObjectURL(new Blob([b], { type: "application/pdf" }));
  }
  async listTodos() {
    if (!this.nativeTodos) throw new ApiError(403, "mock todos", "forbidden");
    return structuredClone(this.todos);
  }
  async getTodo(id: string) { return structuredClone(this.todos.find((t) => t.id === id)); }
  async createTodo(t: NativeTodoInput) {
    if (!this.nativeTodos) throw new ApiError(403, "mock todos", "forbidden");
    const users = await this.users();
    const groups = await this.groups();
    const n: NativeTodo = {
      id: "t" + this.seq++, label: String(this.todos.length + 1), title: t.title, description: t.description, dueDate: t.dueDate,
      status: t.status ?? "NEW", createdOn: new Date().toISOString(),
      assignees: t.assignees?.map((a) => ({ ...a, name: users.find((u) => u.id === a.id)?.name ?? groups.find((g) => g.id === a.id)?.name })),
    };
    this.todos.push(n);
    return n;
  }
  async updateTodo(id: string, t: Partial<NativeTodoInput>) {
    const x = this.todos.find((i) => i.id === id)!;
    Object.assign(x, t, { modifiedOn: new Date().toISOString(), modifiedBy: { firstName: "Найден", lastName: "Кочев" } });
    return x;
  }
  async versions(fileId: string) {
    const f = this.items.find((i) => i.id === fileId)!;
    return Array.from({ length: f.rv ?? 1 }, (_, i) => ({
      versionId: i + 1 === f.rv ? f.vid ?? "" : `${f.vid}-old${i + 1}`, revision: i + 1,
      modified: new Date(Date.parse(f.mt ?? new Date().toISOString()) - ((f.rv ?? 1) - i - 1) * 5 * 86400000).toISOString(), modifiedBy: "Найден Кочев",
    })).reverse();
  }
  async probe() {
    return [{ name: "Mock mode - no Trimble Connect connection", url: "", ok: true, status: "mock", ms: 0 }];
  }
}

const delay = () => new Promise((r) => setTimeout(r, 60));
