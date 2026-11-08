import "./style.css";
import { connectHost, type Host } from "./host";
import { TrackerStore } from "./store";
import { TodoService, type TodoView } from "./todos";
import {
  addTransmittal, buildRegister, emptyTracker, isOverdue, mostCommonProject, nextTransmittalId, setStatus,
  statusForPurpose, STATUSES, type DocRow, type DocStatus, type Register, type SnapshotItem, type Transmittal,
  type TransmittalPurpose, type UserRef, type TodoState,
} from "./model";
import { compilePattern, DEFAULT_PATTERN, DISCIPLINES, DOC_TYPES, parseName } from "./naming";
import { getLang, initLang, setLang, t } from "./i18n";
import { clear, downloadBlob, fmtDate, h, today } from "./dom";

const slug = (s: string) => s.replace(/s+/g, "-");
type Tab = "register" | "transmittals" | "todos" | "settings";
const PURPOSES: TransmittalPurpose[] = ["For approval", "For construction", "For information", "For tender"];
const TODO_STATES: TodoState[] = ["Open", "In progress", "Done"];

class App {
  root = document.getElementById("app")!;
  host!: Host;
  store!: TrackerStore;
  todos!: TodoService;
  items: SnapshotItem[] = [];
  users: UserRef[] = [];
  reg: Register = { docs: [], unnumbered: [], folders: new Map() };
  todoList: TodoView[] = [];
  todoError = "";
  tab: Tab = "register";
  busy = "";
  error = "";
  // register view state
  q = "";
  disc = "";
  status = "";
  sel = new Set<string>();
  sortCol: "key" | "status" | "modified" | "title" = "key";
  sortDir = 1;
  // transmittal draft
  draft: { to: string; attn: string; purpose: TransmittalPurpose; date: string; note: string; keys: Set<string>; filter: string } | null = null;
  todoFilter: "open" | "mine" | "overdue" | "all" = "open";
  showTodoForm = false;

  async start() {
    try {
      this.host = await connectHost();
    } catch (e: any) {
      clear(this.root, h("div", { class: "shell" }, h("div", { class: "banner error" }, `Trimble Connect: ${e?.message ?? e}`)));
      return;
    }
    initLang(this.host.language);
    this.store = new TrackerStore(this.host.api);
    this.todos = new TodoService(this.host.api, this.store, () => this.host.user.name);
    this.host.onCommand((c) => { if (["register", "transmittals", "todos", "settings"].includes(c)) this.go(c as Tab); });
    this.setMenu();
    await this.refresh(true);
  }

  setMenu() {
    this.host.setMenu([
      { title: t("register"), command: "register" },
      { title: t("transmittals"), command: "transmittals" },
      { title: t("todos"), command: "todos" },
      { title: t("settings"), command: "settings" },
    ]);
  }

  go(tab: Tab) { this.tab = tab; this.render(); }

  toast(msg: string) {
    const el = h("div", { class: "toast" }, msg);
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  }

  async run<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    this.busy = label;
    this.error = "";
    this.renderHeaderState();
    try {
      return await fn();
    } catch (e: any) {
      console.error(e);
      this.error = `${t("error")}: ${e?.message ?? e}`;
      return undefined;
    } finally {
      this.busy = "";
      this.render();
    }
  }

  async refresh(first = false) {
    await this.run(t("loading"), async () => {
      const [items, users] = await Promise.all([this.host.api.snapshot(), this.host.api.users().catch(() => [] as UserRef[])]);
      this.items = items;
      this.users = users;
      const pre = buildRegister(items, emptyTracker(), new Map());
      await this.store.load(pre.trackerFolderId, pre.trackerFileId);
      this.rebuild();
      if (first) await this.todos.detect();
      await this.loadTodos();
    });
  }

  async loadTodos() {
    try {
      this.todoList = await this.todos.list();
      this.todoError = "";
    } catch (e: any) {
      this.todoError = e?.message ?? String(e);
    }
  }

  rebuild() {
    this.reg = buildRegister(this.items, this.store.tracker, new Map(this.users.map((u) => [u.id, u])));
  }

  actor() { return { name: this.host.user.name, id: this.host.user.id }; }

  statusOf(key: string, rev: string): DocStatus {
    const d = this.reg.docs.find((x) => x.key === key);
    return d?.revs.find((r) => r.revLabel === rev)?.status ?? "Draft";
  }

  async changeStatus(key: string, rev: string, to: DocStatus, note?: string) {
    const from = this.statusOf(key, rev);
    if (from === to) return;
    await this.run(t("saving"), async () => {
      await this.store.save((tr) => setStatus(tr, key, rev, to, from, this.actor(), note));
      this.rebuild();
      this.toast(`${this.labelOf(key)} ${rev} → ${t("st_" + to)}`);
    });
  }

  // ------------------------------------------------------------------ rendering
  render() {
    const shell = h("div", { class: "shell" });
    shell.append(this.header());
    if (!this.host.inConnect) shell.append(h("div", { class: "banner" }, t("mockBanner")));
    if (this.error) shell.append(h("div", { class: "banner error" }, this.error));
    const body = h("div", { id: "body" });
    shell.append(body);
    if (this.tab === "register") this.viewRegister(body);
    else if (this.tab === "transmittals") this.viewTransmittals(body);
    else if (this.tab === "todos") this.viewTodos(body);
    else this.viewSettings(body);
    shell.append(h("footer", { class: "foot mono" }, "arsten docs · plovdiv, bg", h("span", { class: "muted" }, ` · ${this.host.api.mode}`)));
    clear(this.root, shell);
    // keep an open history drawer in sync with the new data
    if (this.openKey && this.tab === "register") this.openDoc(this.openKey);
    else if (this.openKey) { this.openKey = ""; document.querySelectorAll(".drawer, .drawer-bg").forEach((e) => e.remove()); }
  }

  renderHeaderState() {
    const s = this.root.querySelector("#busy");
    if (s) s.textContent = this.busy;
  }

  header() {
    const tab = (k: Tab) => h("button", { class: this.tab === k ? "active" : "", onclick: () => this.go(k) }, t(k));
    return h("div", null,
      h("header", { class: "top" },
        h("img", { src: "arsten-logo.png", alt: "arsten" }),
        h("div", { class: "proj" },
          h("div", { class: "mono" }, "trimble connect · docs"),
          h("h1", null, this.host.projectName)),
        h("div", { class: "tools" },
          h("span", { id: "busy", class: "mono muted" }, this.busy),
          h("button", { onclick: () => this.refresh(), title: t("refresh") }, "↻ " + t("refresh")),
          h("button", { onclick: () => { setLang(getLang() === "bg" ? "en" : "bg"); this.setMenu(); this.render(); } }, getLang() === "bg" ? "EN" : "BG"))),
      h("nav", { class: "tabs" }, tab("register"), tab("transmittals"), tab("todos"), tab("settings")));
  }

  // ---------------- Register
  filteredDocs(): DocRow[] {
    const q = this.q.trim().toLowerCase();
    let docs = this.reg.docs.filter((d) =>
      (!this.disc || d.disc === this.disc) &&
      (!this.status || d.status === this.status) &&
      (!q || `${d.label} ${d.title} ${d.current.name} ${d.current.folderPath}`.toLowerCase().includes(q)));
    const dir = this.sortDir;
    const cmp: Record<string, (a: DocRow, b: DocRow) => number> = {
      key: (a, b) => (a.kind === b.kind ? 0 : a.kind === "numbered" ? -1 : 1) || a.disc.localeCompare(b.disc) || a.label.localeCompare(b.label, undefined, { numeric: true }),
      title: (a, b) => a.title.localeCompare(b.title),
      status: (a, b) => STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status),
      modified: (a, b) => (a.current.modified ?? "").localeCompare(b.current.modified ?? ""),
    };
    docs = [...docs].sort((a, b) => cmp[this.sortCol](a, b) * dir || a.key.localeCompare(b.key));
    return docs;
  }

  viewRegister(body: HTMLElement) {
    const docs = this.reg.docs;
    const count = (s: DocStatus) => docs.filter((d) => d.status === s).length;
    const overdue = this.todoList.filter((x) => isOverdue(x.due, x.state === "Done")).length;
    const lastTr = [...this.store.tracker.transmittals].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const stat = (n: number | string, label: string, on: boolean, onclick: () => void, cls = "") =>
      h("div", { class: `stat ${on ? "on" : ""} ${cls}`, onclick }, h("div", { class: "n" }, n), h("div", { class: "l" }, label));
    body.append(h("div", { class: "stats" },
      stat(docs.length, t("documents"), !this.status, () => { this.status = ""; this.render(); }),
      STATUSES.filter((s) => s !== "Superseded").map((s) =>
        stat(count(s), t("st_" + s), this.status === s, () => { this.status = this.status === s ? "" : s; this.render(); })),
      stat(overdue, `${t("todos").toLowerCase()} ${t("overdue")}`, false, () => { this.todoFilter = "overdue"; this.go("todos"); }, overdue ? "alert" : ""),
      stat(lastTr ? lastTr.id : t("none"), `${t("lastTransmittal")}${lastTr ? " · " + fmtDate(lastTr.date) : ""}`, false, () => this.go("transmittals"))));

    const discs = [...new Set(docs.map((d) => d.disc))].sort();
    const tableBox = h("div", { class: "tablewrap" });
    const selInfo = h("span", { class: "muted" });
    const bulkBtn = h("button", { class: "primary", onclick: () => this.startTransmittal([...this.sel]) }, t("fromSelected"));
    const bulkStatus = h("select", {
      onchange: async (e: Event) => {
        const v = (e.target as HTMLSelectElement).value as DocStatus;
        if (!v) return;
        const keys = [...this.sel];
        await this.run(t("saving"), async () => {
          await this.store.save((tr) => {
            let n = tr;
            for (const k of keys) {
              const d = this.reg.docs.find((x) => x.key === k);
              if (d) n = setStatus(n, d.key, d.current.revLabel, v, d.current.status, this.actor());
            }
            return n;
          });
          this.rebuild();
          this.toast(`${keys.length} → ${t("st_" + v)}`);
        });
      },
    }, h("option", { value: "" }, t("setStatus") + "…"), STATUSES.map((s) => h("option", { value: s }, t("st_" + s))));
    const updateSel = () => {
      selInfo.textContent = this.sel.size ? `${this.sel.size} ${t("selected")}` : "";
      bulkBtn.disabled = !this.sel.size;
      bulkStatus.disabled = !this.sel.size;
    };

    const search = h("input", { type: "search", placeholder: t("search"), value: this.q, oninput: (e: Event) => { this.q = (e.target as HTMLInputElement).value; drawTable(); } });
    body.append(h("div", { class: "toolbar" },
      search,
      h("select", { onchange: (e: Event) => { this.disc = (e.target as HTMLSelectElement).value; drawTable(); } },
        h("option", { value: "" }, t("allDisciplines")),
        discs.map((d) => h("option", { value: d, selected: this.disc === d }, `${d} · ${DISCIPLINES[d]?.[getLang()] ?? d}`))),
      h("select", { onchange: (e: Event) => { this.status = (e.target as HTMLSelectElement).value; this.render(); } },
        h("option", { value: "" }, t("allStatuses")),
        STATUSES.map((s) => h("option", { value: s, selected: this.status === s }, t("st_" + s)))),
      h("span", { class: "grow" }),
      selInfo, bulkStatus, bulkBtn,
      h("button", { onclick: () => this.exportCsv() }, t("exportCsv"))));
    body.append(tableBox);

    const drawTable = () => {
      const list = this.filteredDocs();
      if (!this.reg.docs.length) { clear(tableBox, h("div", { class: "empty" }, t("noDocs"))); updateSel(); return; }
      const th = (label: string, col?: typeof this.sortCol, cls = "") => h("th", {
        class: (col ? "sort " : "") + cls,
        onclick: col ? () => { this.sortDir = this.sortCol === col ? -this.sortDir : 1; this.sortCol = col; drawTable(); } : null,
      }, label, col && this.sortCol === col ? (this.sortDir > 0 ? " ↑" : " ↓") : "");
      const allCb = h("input", { type: "checkbox", checked: list.length > 0 && list.every((d) => this.sel.has(d.key)),
        onchange: (e: Event) => { const on = (e.target as HTMLInputElement).checked; list.forEach((d) => on ? this.sel.add(d.key) : this.sel.delete(d.key)); drawTable(); } });
      const rows: HTMLElement[] = [];
      let lastDisc = "";
      for (const d of list) {
        const grp = d.kind === "file" ? `f:${d.current.folderPath}` : d.disc;
        if (this.sortCol === "key" && grp !== lastDisc) {
          lastDisc = grp;
          const n = list.filter((x) => (x.kind === "file" ? `f:${x.current.folderPath}` : x.disc) === grp).length;
          rows.push(h("tr", { class: "group" }, h("td", { colspan: 8 }, d.kind === "file"
            ? [h("b", null, d.disc), ` · ${d.current.folderPath} · ${n}`]
            : [h("b", null, d.disc), ` · ${DISCIPLINES[d.disc]?.[getLang()] ?? ""} · ${n}`])));
        }
        const cb = h("input", { type: "checkbox", checked: this.sel.has(d.key), onclick: (e: Event) => e.stopPropagation(),
          onchange: (e: Event) => { (e.target as HTMLInputElement).checked ? this.sel.add(d.key) : this.sel.delete(d.key); (cb.closest("tr") as HTMLElement).classList.toggle("sel"); updateSel(); } });
        rows.push(h("tr", { class: "row" + (this.sel.has(d.key) ? " sel" : ""), onclick: () => this.openDoc(d.key) },
          h("td", { class: "cb" }, cb),
          h("td", { class: "key" }, d.label),
          h("td", { class: "num" }, d.current.revLabel, d.revs.length > 1 ? h("span", { class: "muted" }, ` /${d.revs.length}`) : "",
            d.current.duplicates ? h("span", { class: "warnmark", title: "duplicate file names" }, " ⚠") : ""),
          h("td", { class: "title" }, d.title || h("span", { class: "muted" }, d.current.name)),
          h("td", { class: "hide-sm" }, h("span", { class: "tag", title: DOC_TYPES[d.type]?.[getLang()] ?? "" }, d.type)),
          h("td", { onclick: (e: Event) => e.stopPropagation() }, this.statusSelect(d.key, d.current.revLabel, d.status)),
          h("td", { class: "date" }, fmtDate(d.current.modified), d.current.modifiedBy ? h("span", { class: "muted hide-sm" }, ` · ${d.current.modifiedBy}`) : ""),
          h("td", { class: "hide-sm" }, d.transmittals.slice(-2).map((x) => h("span", { class: "tag" }, x)))));
      }
      clear(tableBox, h("table", null,
        h("thead", null, h("tr", null, h("th", { class: "cb" }, allCb), th(t("number"), "key"), th(t("rev")), th(t("title"), "title"),
          th(t("type"), undefined, "hide-sm"), th(t("status"), "status"), th(t("modified"), "modified"), th(t("transmittals"), undefined, "hide-sm"))),
        h("tbody", null, rows)));
      updateSel();
    };
    drawTable();

    if (this.reg.unnumbered.length)
      body.append(h("details", { class: "unnum" },
        h("summary", null, `${t("unnumbered")} (${this.reg.unnumbered.length})`),
        h("div", { class: "tablewrap" }, h("table", null,
          h("thead", null, h("tr", null, h("th", null, "File"), h("th", null, t("folder")), h("th", null, t("modified")))),
          h("tbody", null, this.reg.unnumbered.map((f) => h("tr", null,
            h("td", null, f.name), h("td", { class: "soft" }, f.folderPath), h("td", { class: "date" }, fmtDate(f.modified), f.modifiedBy ? ` · ${f.modifiedBy}` : ""))))))));
  }

  statusSelect(key: string, rev: string, cur: DocStatus) {
    return h("select", { class: "stsel", onchange: (e: Event) => this.changeStatus(key, rev, (e.target as HTMLSelectElement).value as DocStatus) },
      STATUSES.map((s) => h("option", { value: s, selected: s === cur }, t("st_" + s))));
  }

  async openFile(fileId: string, versionId?: string) {
    const w = window.open("about:blank", "_blank");
    try {
      const url = await this.host.api.downloadUrl(fileId, versionId);
      if (w) w.location.href = url; else window.location.href = url;
    } catch (e: any) {
      w?.close();
      this.error = `${t("error")}: ${e?.message ?? e}`;
      this.render();
    }
  }

  openKey = "";

  labelOf(key: string) { return this.reg.docs.find((d) => d.key === key)?.label ?? key; }

  /** File documents: revisions are Connect versions, loaded on demand. */
  versionTable(d: DocRow) {
    const box = h("div", { class: "muted" }, t("loading"));
    this.host.api.versions(d.current.fileId).then((vs) => {
      const st = this.store.tracker.status;
      clear(box, h("table", null, h("tbody", null, vs.map((v) => {
        const lbl = `v${v.revision}`;
        const cur = v.revision === d.current.rev;
        // an older version is replaced by the newer upload, whatever it was marked
        const stored = st[`${d.key}@${lbl}`] as DocStatus | undefined;
        const status: DocStatus = cur ? d.status : stored === "Issued" || !stored ? "Superseded" : stored;
        return h("tr", null,
          h("td", { class: "num" }, lbl),
          h("td", null, cur ? this.statusSelect(d.key, lbl, d.status) : h("span", { class: `st s-${slug(status)}` }, t("st_" + status))),
          h("td", { class: "date" }, fmtDate(v.modified), v.modifiedBy ? ` · ${v.modifiedBy}` : ""),
          h("td", null, h("button", { class: "link", onclick: () => this.openFile(d.current.fileId, v.versionId) }, t("download"))));
      }))));
      box.className = "";
    }).catch((e) => { box.textContent = `${t("error")}: ${e?.message ?? e}`; });
    return box;
  }

  openDoc(key: string) {
    document.querySelectorAll(".drawer, .drawer-bg").forEach((e) => e.remove());
    const d = this.reg.docs.find((x) => x.key === key);
    this.openKey = d ? key : "";
    if (!d) return;
    const close = () => { this.openKey = ""; bg.remove(); dr.remove(); };
    const log = this.store.tracker.log.filter((l) => l.key === key).slice().reverse();
    const trs = this.store.tracker.transmittals.filter((x) => x.items.some((i) => i.key === key));
    const todos = this.todoList.filter((x) => x.docKey === key);
    const bg = h("div", { class: "drawer-bg", onclick: close });
    const dr = h("div", { class: "drawer" },
      h("button", { class: "close", onclick: close }, t("close")),
      h("div", { class: "mono muted" }, d.kind === "file" ? `${d.current.folderPath} · ${d.type}` : `${d.disc} · ${DISCIPLINES[d.disc]?.[getLang()] ?? ""} · ${DOC_TYPES[d.type]?.[getLang()] ?? d.type}`),
      h("h2", null, d.label),
      h("div", { class: "soft" }, d.title),
      h("h3", null, t("revisions")),
      d.kind === "file" ? this.versionTable(d) : h("table", null, h("tbody", null, [...d.revs].reverse().map((r) => h("tr", null,
        h("td", { class: "num" }, r.revLabel),
        h("td", null, this.statusSelect(d.key, r.revLabel, r.status)),
        h("td", { class: "date" }, fmtDate(r.modified), r.modifiedBy ? ` · ${r.modifiedBy}` : "", r.connectVersion && r.connectVersion > 1 ? h("span", { class: "muted" }, ` · v${r.connectVersion}`) : ""),
        h("td", null, h("button", { class: "link", onclick: () => this.openFile(r.fileId, r.versionId) }, t("download"))))))),
      h("div", { class: "muted", style: "font-size:12px;margin-top:6px" }, d.current.folderPath),
      h("h3", null, t("statusLog")),
      log.length ? h("table", null, h("tbody", null, log.map((l) => h("tr", null,
        h("td", { class: "date" }, fmtDate(l.at)),
        h("td", { class: "num" }, l.rev),
        h("td", null, `${t("st_" + l.from)} → `, h("span", { class: `st s-${slug(l.to)}` }, t("st_" + l.to))),
        h("td", { class: "soft" }, l.by, l.transmittal ? h("span", { class: "tag", style: "margin-left:6px" }, l.transmittal) : "", l.note ? ` – ${l.note}` : ""))))) : h("div", { class: "muted" }, t("noLog")),
      h("h3", null, t("transmittals")),
      trs.length ? h("table", null, h("tbody", null, trs.map((x) => h("tr", null,
        h("td", { class: "num" }, x.id), h("td", { class: "date" }, fmtDate(x.date)), h("td", null, x.to),
        h("td", null, x.items.filter((i) => i.key === key).map((i) => i.rev).join(", ")),
        h("td", null, t("pu_" + x.purpose)))))) : h("div", { class: "muted" }, t("none")),
      h("h3", null, t("todos")),
      todos.length ? h("table", null, h("tbody", null, todos.map((x) => h("tr", null,
        h("td", null, x.title), h("td", { class: isOverdue(x.due, x.state === "Done") ? "date overdue" : "date" }, fmtDate(x.due)), h("td", null, t("todoState_" + x.state)))))) : h("div", { class: "muted" }, t("none")),
      h("div", { class: "actions" },
        h("button", { onclick: () => { close(); this.startTransmittal([key]); } }, t("newTransmittal")),
        h("button", { onclick: () => { close(); this.showTodoForm = true; this.todoPrefillDoc = key; this.go("todos"); } }, t("newTodo"))));
    document.body.append(bg, dr);
  }
  todoPrefillDoc = "";

  exportCsv() {
    const esc = (s: unknown) => `"${String(s ?? "").replace(/"/g, '""')}"`;
    const head = ["Number", "Discipline", "Type", "Revision", "Title", "Status", "Modified", "Modified by", "Folder", "File", "Transmittals"];
    const lines = [head.join(";")].concat(this.filteredDocs().map((d) => [
      d.label, d.disc, d.type, d.current.revLabel, d.title, d.status, d.current.modified?.slice(0, 10), d.current.modifiedBy,
      d.current.folderPath, d.current.name, d.transmittals.join(" "),
    ].map(esc).join(";")));
    downloadBlob(new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" }), `register_${this.projectCode()}_${today()}.csv`);
  }

  projectCode() {
    return this.store.tracker.settings.projectCode || mostCommonProject(this.reg.docs) || /^\d{3,5}/.exec(this.host.projectName)?.[0] || "PRJ";
  }

  // ---------------- Transmittals
  startTransmittal(keys: string[]) {
    this.draft = { to: "", attn: "", purpose: "For approval", date: today(), note: "", keys: new Set(keys), filter: "" };
    this.go("transmittals");
  }

  viewTransmittals(body: HTMLElement) {
    if (this.draft) body.append(this.transmittalForm());
    else body.append(h("div", { class: "toolbar" }, h("button", { class: "primary", onclick: () => this.startTransmittal([]) }, "+ " + t("newTransmittal"))));
    const list = [...this.store.tracker.transmittals].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (!list.length) { body.append(h("div", { class: "empty" }, t("noTransmittals"))); return; }
    body.append(h("div", { class: "tablewrap" }, h("table", null,
      h("thead", null, h("tr", null, h("th", null, "№"), h("th", null, t("date")), h("th", null, t("to")), h("th", null, t("purpose")),
        h("th", null, t("items")), h("th", { class: "hide-sm" }, t("by")), h("th", null, ""))),
      h("tbody", null, list.map((x) => h("tr", null,
        h("td", { class: "key" }, x.id),
        h("td", { class: "date" }, fmtDate(x.date)),
        h("td", null, x.to, x.attn ? h("div", { class: "muted" }, x.attn) : ""),
        h("td", null, h("span", { class: `st s-${slug(statusForPurpose(x.purpose))}` }, t("pu_" + x.purpose))),
        h("td", null, h("details", null, h("summary", null, `${x.items.length}`),
          x.items.map((i) => h("div", { class: "mono", style: "font-size:12px" }, `${i.label ?? i.key} ${i.rev}`)))),
        h("td", { class: "soft hide-sm" }, x.by),
        h("td", null, x.pdfFileId ? h("button", { class: "link", onclick: () => this.openFile(x.pdfFileId!) }, t("pdf")) :
          h("button", { class: "link", onclick: () => this.regeneratePdf(x) }, "PDF ↻"))))))));
  }

  transmittalForm() {
    const dft = this.draft!;
    const set = (k: "to" | "attn" | "date" | "note" | "purpose") => (e: Event) => { (dft as any)[k] = (e.target as HTMLInputElement).value; if (k === "purpose") this.render(); };
    const pickBox = h("div", { class: "picker" });
    const countEl = h("span", { class: "muted" });
    const drawPicker = () => {
      const q = dft.filter.toLowerCase();
      const docs = this.reg.docs.filter((d) => d.status !== "Superseded" && (!q || `${d.label} ${d.title} ${d.current.folderPath}`.toLowerCase().includes(q)));
      clear(pickBox, h("table", null, h("tbody", null, docs.map((d) => h("tr", { class: "row" + (dft.keys.has(d.key) ? " sel" : ""), onclick: () => { dft.keys.has(d.key) ? dft.keys.delete(d.key) : dft.keys.add(d.key); drawPicker(); } },
        h("td", { class: "cb" }, h("input", { type: "checkbox", checked: dft.keys.has(d.key) })),
        h("td", { class: "key" }, d.label), h("td", { class: "num" }, d.current.revLabel), h("td", null, d.title || h("span", { class: "muted" }, d.current.folderPath)),
        h("td", null, h("span", { class: `st s-${slug(d.status)}` }, t("st_" + d.status))))))));
      countEl.textContent = `${dft.keys.size} ${t("selected")}`;
    };
    drawPicker();
    const target = statusForPurpose(dft.purpose);
    return h("div", { class: "panel" },
      h("h2", null, t("newTransmittal"), h("span", { class: "mono muted", style: "font-size:13px;margin-left:12px" }, nextTransmittalId(this.store.tracker, this.projectCode()))),
      h("div", { class: "form" },
        h("label", null, t("to")), h("input", { value: dft.to, oninput: set("to"), placeholder: "Възложител / Client, ТК, Изпълнител…", list: "recips" }),
        h("datalist", { id: "recips" }, [...new Set(this.store.tracker.transmittals.map((x) => x.to))].map((r) => h("option", { value: r }))),
        h("label", null, t("attn")), h("input", { value: dft.attn, oninput: set("attn") }),
        h("label", null, t("purpose")), h("select", { onchange: set("purpose") }, PURPOSES.map((p) => h("option", { value: p, selected: p === dft.purpose }, t("pu_" + p)))),
        h("label", null, t("date")), h("input", { type: "date", value: dft.date, oninput: set("date") }),
        h("label", null, t("note")), h("textarea", { rows: 2, oninput: set("note") }, dft.note),
        h("label", null, t("items")),
        h("div", null, h("div", { class: "toolbar" },
          h("input", { type: "search", placeholder: t("search"), value: dft.filter, oninput: (e: Event) => { dft.filter = (e.target as HTMLInputElement).value; drawPicker(); } }),
          countEl), pickBox,
          h("div", { class: "muted", style: "font-size:12px;margin-top:6px" }, `${t("trWillSet")}: `, h("span", { class: `st s-${slug(target)}` }, t("st_" + target))))),
      h("div", { class: "actions" },
        h("button", { class: "primary", onclick: () => this.createTransmittal() }, t("create")),
        h("button", { onclick: () => { this.draft = null; this.render(); } }, t("cancel"))));
  }

  async createTransmittal() {
    const dft = this.draft!;
    if (!dft.to.trim()) { alert(t("to") + "?"); return; }
    if (!dft.keys.size) { alert(t("pickDocs")); return; }
    await this.run(t("saving"), async () => {
      const docs = this.reg.docs.filter((d) => dft.keys.has(d.key));
      const now = new Date().toISOString();
      let created!: Transmittal;
      await this.store.save((tr) => {
        created = {
          id: nextTransmittalId(tr, this.projectCode()),
          date: dft.date, to: dft.to.trim(), attn: dft.attn.trim() || undefined, purpose: dft.purpose, note: dft.note.trim() || undefined,
          by: this.host.user.name, byId: this.host.user.id, createdAt: now,
          items: docs.map((d) => ({ key: d.key, ...(d.kind === "file" ? { label: d.label } : {}), rev: d.current.revLabel, name: d.current.name, title: d.title, fileId: d.current.fileId, versionId: d.current.versionId })),
        };
        return addTransmittal(tr, created, (k, r) => this.statusOf(k, r), this.actor());
      });
      this.draft = null;
      this.rebuild();
      this.toast(`${t("trCreated")}: ${created.id}`);
      await this.attachPdf(created, true);
    });
  }

  async regeneratePdf(tr: Transmittal) {
    await this.run(t("saving"), () => this.attachPdf(tr, true));
  }

  /** Builds the PDF, uploads it to _ArstenDocs/Transmittals/ and stores its file id. */
  async attachPdf(tr: Transmittal, alsoDownload: boolean) {
    const { transmittalPdf } = await import("./pdf");
    const bytes = await transmittalPdf(tr, this.host.projectName);
    const blob = new Blob([bytes], { type: "application/pdf" });
    if (alsoDownload) downloadBlob(blob, `${tr.id}.pdf`);
    try {
      const items = await this.host.api.snapshot();
      this.items = items;
      const parent = this.store.folderId!;
      let folder = items.find((i) => i.tp === "FOLDER" && i.nm === "Transmittals" && i.pid === parent && !i.del)?.id;
      if (!folder) folder = await this.host.api.createFolder("Transmittals", parent);
      const up = await this.host.api.upload(folder, `${tr.id}.pdf`, blob);
      await this.store.save((x) => ({ ...x, transmittals: x.transmittals.map((y) => (y.id === tr.id ? { ...y, pdfFileId: up.fileId } : y)) }));
      this.rebuild();
    } catch (e: any) {
      this.error = `PDF upload: ${e?.message ?? e}`;
    }
  }

  // ---------------- Todos
  viewTodos(body: HTMLElement) {
    body.append(h("div", { class: "banner" }, this.todos.backend === "native" ? t("todoNative") : t("todoLocal")));
    if (this.todoError) body.append(h("div", { class: "banner error" }, this.todoError));
    const f = (k: typeof this.todoFilter, label: string) => h("button", { class: this.todoFilter === k ? "primary" : "", onclick: () => { this.todoFilter = k; this.render(); } }, label);
    body.append(h("div", { class: "toolbar" }, f("open", t("filterOpen")), f("mine", t("filterMine")), f("overdue", t("filterOverdue")), f("all", t("filterAll")),
      h("span", { class: "grow" }), h("button", { class: "primary", onclick: () => { this.showTodoForm = !this.showTodoForm; this.render(); } }, "+ " + t("newTodo"))));
    if (this.showTodoForm) body.append(this.todoForm());
    const me = this.host.user.id;
    const list = this.todoList.filter((x) =>
      this.todoFilter === "all" ? true :
      this.todoFilter === "open" ? x.state !== "Done" :
      this.todoFilter === "mine" ? x.assignee?.id === me && x.state !== "Done" :
      isOverdue(x.due, x.state === "Done"))
      .sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999"));
    if (!list.length) { body.append(h("div", { class: "empty" }, t("noTodos"))); return; }
    body.append(h("div", { class: "tablewrap" }, h("table", null,
      h("thead", null, h("tr", null, h("th", null, t("title")), h("th", null, t("document")), h("th", null, t("assignee")), h("th", null, t("due")), h("th", null, t("status")))),
      h("tbody", null, list.map((x) => h("tr", null,
        h("td", null, x.label ? h("span", { class: "muted mono" }, `#${x.label} `) : "", x.title, x.description ? h("div", { class: "muted", style: "font-size:12px" }, x.description) : ""),
        h("td", { class: "key" }, x.docKey ? h("button", { class: "link", onclick: () => { this.tab = "register"; this.render(); this.openDoc(x.docKey!); } }, this.labelOf(x.docKey)) : ""),
        h("td", null, x.assignee?.name ?? ""),
        h("td", { class: isOverdue(x.due, x.state === "Done") ? "date overdue" : "date" }, x.due ? fmtDate(x.due) : ""),
        h("td", null, h("select", { class: "stsel", onchange: (e: Event) => this.setTodoState(x, (e.target as HTMLSelectElement).value as TodoState) },
          TODO_STATES.map((s) => h("option", { value: s, selected: s === x.state }, t("todoState_" + s)))))))))));
  }

  todoForm() {
    const v = { title: "", description: "", assignee: "", due: "", doc: this.todoPrefillDoc };
    this.todoPrefillDoc = "";
    const set = (k: keyof typeof v) => (e: Event) => { v[k] = (e.target as HTMLInputElement).value; };
    return h("div", { class: "panel" },
      h("h2", null, t("newTodo")),
      h("div", { class: "form" },
        h("label", null, t("title")), h("input", { oninput: set("title") }),
        h("label", null, t("assignee")), h("select", { onchange: set("assignee") }, h("option", { value: "" }, "—"), this.users.map((u) => h("option", { value: u.id }, u.name))),
        h("label", null, t("due")), h("input", { type: "date", oninput: set("due") }),
        h("label", null, t("document")), h("select", { onchange: set("doc") }, h("option", { value: "" }, "—"),
          this.reg.docs.map((d) => h("option", { value: d.key, selected: d.key === v.doc }, `${d.label} ${d.title}`))),
        h("label", null, t("description")), h("textarea", { rows: 2, oninput: set("description") })),
      h("div", { class: "actions" },
        h("button", { class: "primary", onclick: async () => {
          if (!v.title.trim()) return;
          await this.run(t("saving"), async () => {
            await this.todos.create({ title: v.title.trim(), description: v.description.trim() || undefined, due: v.due || undefined, docKey: v.doc || undefined, assignee: this.users.find((u) => u.id === v.assignee) });
            this.showTodoForm = false;
            await this.loadTodos();
          });
        } }, t("create")),
        h("button", { onclick: () => { this.showTodoForm = false; this.render(); } }, t("cancel"))));
  }

  async setTodoState(x: TodoView, s: TodoState) {
    await this.run(t("saving"), async () => { await this.todos.setState(x, s); await this.loadTodos(); });
  }

  // ---------------- Settings
  viewSettings(body: HTMLElement) {
    const st = this.store.tracker.settings;
    const v = { pattern: st.pattern || DEFAULT_PATTERN, trackExts: st.trackExts ?? "", projectCode: st.projectCode ?? "", todoBackend: st.todoBackend ?? "" };
    const testOut = h("div", { class: "mono soft", style: "font-size:12px" });
    let testName = "1018-ST-DR-0101_R02_Фундаменти.pdf";
    const runTest = () => {
      try {
        const p = parseName(testName, compilePattern(v.pattern));
        testOut.textContent = p ? `key=${p.key}  disc=${p.disc}  type=${p.type}  rev=${p.revLabel}  title="${p.title}"` : "— no match —";
      } catch (e: any) { testOut.textContent = `invalid pattern: ${e.message}`; }
    };
    runTest();
    const diag = h("div");
    body.append(h("div", { class: "panel" },
      h("h2", null, t("settings")),
      h("div", { class: "form" },
        h("label", null, t("pattern")), h("div", null, h("input", { value: v.pattern, style: "width:100%", class: "mono", oninput: (e: Event) => { v.pattern = (e.target as HTMLInputElement).value; runTest(); } }),
          h("div", { class: "muted", style: "font-size:12px" }, t("patternHelp"))),
        h("label", null, t("testName")), h("div", null, h("input", { value: testName, style: "width:100%", oninput: (e: Event) => { testName = (e.target as HTMLInputElement).value; runTest(); } }), testOut),
        h("label", null, t("trackExts")), h("div", null, h("input", { value: v.trackExts, placeholder: "pdf", oninput: (e: Event) => { v.trackExts = (e.target as HTMLInputElement).value.trim(); } }),
          h("div", { class: "muted", style: "font-size:12px" }, t("trackExtsHelp"))),
        h("label", null, t("projectCode")), h("input", { value: v.projectCode, placeholder: mostCommonProject(this.reg.docs) ?? "", oninput: (e: Event) => { v.projectCode = (e.target as HTMLInputElement).value.trim(); } }),
        h("label", null, t("todoBackend")), h("select", { onchange: (e: Event) => { v.todoBackend = (e.target as HTMLSelectElement).value; } },
          h("option", { value: "", selected: !v.todoBackend }, t("auto")),
          h("option", { value: "native", selected: v.todoBackend === "native" }, "Trimble Connect ToDo"),
          h("option", { value: "local", selected: v.todoBackend === "local" }, "tracker.json")),
        h("label", null, t("trackerFile")), h("div", { class: "soft" }, this.store.fileId
          ? h("span", null, `_ArstenDocs/tracker.json · ${this.store.versionId ?? ""} `, h("button", { class: "link", onclick: () => this.openFile(this.store.fileId!) }, t("download")))
          : t("notCreated"))),
      h("div", { class: "actions" }, h("button", { class: "primary", onclick: async () => {
        try { compilePattern(v.pattern); } catch { alert("Invalid pattern"); return; }
        await this.run(t("saving"), async () => {
          await this.store.save((tr) => ({ ...tr, settings: { ...tr.settings, pattern: v.pattern, trackExts: v.trackExts, projectCode: v.projectCode || undefined, todoBackend: (v.todoBackend || undefined) as any } }));
          this.rebuild();
          await this.todos.detect();
          await this.loadTodos();
          this.toast(t("saved"));
        });
      } }, t("save")))),
      h("div", { class: "panel" },
        h("h2", null, t("diagnostics")),
        h("div", { class: "soft", style: "margin-bottom:8px" }, `mode: ${this.host.api.mode} · project ${this.host.projectId} · user ${this.host.user.name}`),
        h("button", { onclick: async () => {
          clear(diag, h("div", { class: "muted" }, t("loading")));
          const res = await this.host.api.probe();
          clear(diag, h("table", null, h("tbody", null, res.map((r) => h("tr", null,
            h("td", null, r.ok ? "✓" : "✗"), h("td", null, r.name), h("td", { class: r.ok ? "soft" : "overdue" }, r.status), h("td", { class: "date" }, `${r.ms} ms`))))));
          console.table(res);
        } }, t("runDiagnostics")), diag));
  }
}

new App().start();
