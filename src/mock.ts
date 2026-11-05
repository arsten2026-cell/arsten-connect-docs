import { ApiError, type ConnectApi, type NativeTodo, type NativeTodoInput, type UploadResult } from "./api";
import type { SnapshotItem, UserRef } from "./model";

/** In-memory Connect project for running the UI outside Trimble Connect (?mock=1 or opened directly). */
export class MockConnectApi implements ConnectApi {
  readonly projectId = "MOCK-PROJECT";
  readonly mode = "mock";
  private items: SnapshotItem[] = [];
  private blobs = new Map<string, string>();
  private todos: NativeTodo[] = [];
  private seq = 1;

  constructor(private nativeTodos = true) {
    const now = Date.now();
    const day = 86400000;
    const iso = (d: number) => new Date(now - d * day).toISOString();
    const folder = (id: string, nm: string, pid = "root") => this.items.push({ id, nm, pid, tp: "FOLDER" });
    folder("f-ar", "01 AR");
    folder("f-st", "02 ST");
    folder("f-st-dr", "Чертежи", "f-st");
    folder("f-st-calc", "Записки", "f-st");
    folder("f-fs", "05 FS");
    const file = (nm: string, pid: string, d: number, mid = "u1", rv = 1) =>
      this.items.push({ id: "fl" + this.seq++, vid: "v" + this.seq, nm, pid, tp: "FILE", mt: iso(d), ct: iso(d + 3), mid, cid: mid, sz: 250000 + this.seq * 1000, rv });
    file("1018-AR-DR-0101_R01_Разпределение партер.pdf", "f-ar", 40, "u2");
    file("1018-AR-DR-0101_R02_Разпределение партер.pdf", "f-ar", 12, "u2", 2);
    file("1018-AR-DR-0102_R01_Разпределение етаж 2.pdf", "f-ar", 12, "u2");
    file("1018-ST-DR-0101_R01_Фундаменти.pdf", "f-st-dr", 30);
    file("1018-ST-DR-0101_R02_Фундаменти.pdf", "f-st-dr", 9);
    file("1018-ST-DR-0101_R03_Фундаменти.pdf", "f-st-dr", 1, "u1", 3);
    file("1018-ST-DR-0102_R01_Колони и шайби.pdf", "f-st-dr", 8);
    file("1018-ST-DR-0103_R01_Плоча кота +3.20.pdf", "f-st-dr", 2);
    file("1018-ST-CA-0001_R01_Изчислителна записка.pdf", "f-st-calc", 5);
    file("1018-ST-EX-0001_R01_Обяснителна записка.docx", "f-st-calc", 5);
    file("1018-FS-DR-0201_R01_Евакуация.pdf", "f-fs", 20, "u3");
    file("Скица от клиента.jpg", "f-ar", 50, "u3");
    file("model_v5.ifc", "f-st", 3);
    this.todos = [
      { id: "t1", label: "1", title: "Проверка на армировка плоча +3.20", status: "IN_PROGRESS", dueDate: iso(-4).slice(0, 10), assignees: [{ id: "u1", name: "Найден Кочев", type: "USER" }], createdOn: iso(6) },
      { id: "t2", label: "2", title: "Коментари на ТК по фундаменти", status: "NEW", dueDate: iso(3).slice(0, 10), assignees: [{ id: "u3", name: "Мария Петрова", type: "USER" }], createdOn: iso(10), description: "[doc:1018-ST-DR-0101]" },
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
  async rootFolderId() { return "root"; }
  async readText(fileId: string) {
    const f = this.items.find((i) => i.id === fileId)!;
    return { text: this.blobs.get(fileId) ?? "{}", versionId: f.vid ?? "" };
  }
  async createFolder(name: string, parentId: string) {
    const id = "f" + this.seq++;
    this.items.push({ id, nm: name, pid: parentId, tp: "FOLDER" });
    return id;
  }
  async upload(parentId: string, name: string, body: Blob, ifMatch?: string): Promise<UploadResult> {
    await delay();
    let f = this.items.find((i) => i.tp === "FILE" && i.nm === name && i.pid === parentId);
    if (f && ifMatch && f.vid !== ifMatch) throw new ApiError(412, "mock upload", "version conflict");
    if (!f) this.items.push((f = { id: "fl" + this.seq++, nm: name, pid: parentId, tp: "FILE", rv: 0 }));
    f.vid = "v" + this.seq++;
    f.rv = (f.rv ?? 0) + 1;
    f.mt = new Date().toISOString();
    f.mid = "u1";
    f.sz = body.size;
    if (body.type.includes("json")) this.blobs.set(f.id, await body.text());
    else this.blobs.set(f.id, URL.createObjectURL(body));
    return { fileId: f.id, versionId: f.vid };
  }
  async downloadUrl(fileId: string) {
    const b = this.blobs.get(fileId);
    return b?.startsWith("blob:") ? b : "about:blank";
  }
  async listTodos() {
    if (!this.nativeTodos) throw new ApiError(403, "mock todos", "forbidden");
    return structuredClone(this.todos);
  }
  async createTodo(t: NativeTodoInput) {
    const users = await this.users();
    const n: NativeTodo = {
      id: "t" + this.seq++, label: String(this.todos.length + 1), title: t.title, description: t.description, dueDate: t.dueDate,
      status: t.status ?? "NEW", createdOn: new Date().toISOString(),
      assignees: t.assignees?.map((a) => ({ ...a, name: users.find((u) => u.id === a.id)?.name })),
    };
    this.todos.push(n);
    return n;
  }
  async updateTodo(id: string, t: Partial<NativeTodoInput>) {
    const x = this.todos.find((i) => i.id === id)!;
    Object.assign(x, t);
    return x;
  }
  async probe() {
    return [{ name: "Mock mode - no Trimble Connect connection", url: "", ok: true, status: "mock", ms: 0 }];
  }
}

const delay = () => new Promise((r) => setTimeout(r, 120));
