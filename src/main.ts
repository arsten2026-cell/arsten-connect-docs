import "./style.css";
import { connectHost, type Host } from "./host";
import { TrackerStore } from "./store";
import {
  addAck, buildRegister, canIssue, emptyTracker, folderPathOf, isOverdue, mostCommonProject, nextTransmittalId, revId, setMeta, setStatus, addTransmittal,
  statusForPurpose, addDays, nextPackageId, ALL_STATUSES, KINDS, STATUS_BY_KIND, DEFAULT_SITE_FOLDER, TOOL_FOLDERS, TRACKER_FOLDER, DEFAULT_STATUS as DEFAULT_FOR,
  type DocRow, type DocStatus, type Kind, type SiteCopy, type Register, type SnapshotItem, type Transmittal, type TransmittalPurpose, type UserRef, type Rfi, type DocMeta,
} from "./model";
import { compilePattern, DEFAULT_PATTERN, DISCIPLINES, parseName } from "./naming";
import { getLang, initLang, setLang, t } from "./i18n";
import { clear, downloadBlob, fmtDate, h, today } from "./dom";
import type { GroupRef } from "./api";
import { loadAccess, can, type Access } from "./roles";
import { matchExpected, mergeExpected, parseExpected, type ExpState, type ParseResult } from "./expected";
import { findTestData, goLiveChecks, removeTestData, type Check } from "./golive";
import {
  issueForConstruction, createRfi, ensureRfiTodo, answerRfi, closeRfi, decideSubmittal, withdrawFromSite, ackTodoStates, folderUrl, sitePath,
  type OpsContext, type IssueResult,
} from "./ops";

type Tab = "site" | "register" | "transmittals" | "rfis" | "settings";
const TABS: Tab[] = ["site", "register", "transmittals", "rfis", "settings"];
const OTHER_PURPOSES: TransmittalPurpose[] = ["For information", "For review", "For approval", "For tender"];
const slug = (s: string) => s.replace(/\s+/g, "-");
const stLabel = (s: DocStatus) => t("st_" + s);
const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
/** dd.mm.yyyy; full timestamps in local time (UTC would show "yesterday" after midnight in Bulgaria). */
const bgDate = (iso?: string) => (iso ? (iso.length > 10 ? localDay(new Date(iso)) : iso.slice(0, 10)).split("-").reverse().join(".") : "");

async function asset(path: string) {
  const r = await fetch(new URL(path, document.baseURI).href);
  if (!r.ok) throw new Error(`Cannot load ${path}`);
  return r.arrayBuffer();
}

type Assignee = { type: "USER" | "GROUP"; id: string; name: string };
type SiteEntry = { d: DocRow; rev: string; copy?: SiteCopy; newer?: string };

class App {
  root = document.getElementById("app")!;
  host!: Host;
  store!: TrackerStore;
  ctx!: OpsContext;
  access: Access = { roles: [], role: "none", groups: [] };
  items: SnapshotItem[] = [];
  users: UserRef[] = [];
  groups: GroupRef[] = [];
  reg: Register = { docs: [], unnumbered: [], folders: new Map(), siteFolderIds: new Set() };
  todoStates = new Map<string, { closed: boolean; by?: string; at?: string }>();
  tab: Tab = "site";
  busy = "";
  error = "";
  info = "";
  // register view
  kind: Kind = "design";
  q = "";
  status: DocStatus | "" = "";
  part = "";
  sel = new Set<string>();
  openKey = "";
  // dialogs
  issue: { keys: string[]; to: string; attn: string; note: string; date: string; baseline?: boolean; ack: boolean; result?: IssueResult } | null = null;
  expView = false;
  expFilter: ExpState | "" = "";
  expImport: { text: string; parsed?: ParseResult } | null = null;
  checks: Check[] | null = null;
  cleanSel: { keys: Set<string>; tr: Set<string>; rfi: Set<string> } | null = null;
  trForm: { to: string; attn: string; purpose: TransmittalPurpose; date: string; note: string; keys: Set<string>; filter: string } | null = null;
  rfiForm: { title: string; question: string; docs: Set<string>; location: string; due: string; assignee: string; filter: string } | null = null;
  upload: { folderId: string; newFolder: string; files: File[]; from: string; kind: Kind; done?: string[] } | null = null;
  rfiOpen = "";
  rfiFilter: "open" | "all" = "open";
  siteQ = "";

  // ------------------------------------------------------------------ start / data
  async start() {
    try {
      this.host = await connectHost();
    } catch (e: any) {
      clear(this.root, h("div", { class: "shell" }, h("div", { class: "banner error" }, `Trimble Connect: ${e?.message ?? e}`)));
      return;
    }
    initLang(this.host.language);
    document.body.classList.toggle("in-shell", this.host.inShell);
    this.store = new TrackerStore(this.host.api);
    this.ctx = {
      api: this.host.api, store: this.store, projectId: this.host.projectId, projectName: this.host.projectName, region: this.host.location,
      actor: () => this.actor(), projectCode: () => this.projectCode(), loadFont: (n) => asset(`fonts/${n}.ttf`),
      progress: (m) => { this.busy = m; this.renderBusy(); },
    };
    this.host.onCommand((c) => { if ((TABS as string[]).includes(c)) this.go(c as Tab); });
    this.setMenu();
    await this.refresh(true);
  }

  setMenu() {
    this.host.setMenu(TABS.map((k) => ({ title: t(k), command: k })));
  }

  actor() { return { name: this.host.user.name, id: this.host.user.id }; }
  get canEdit() { return can.edit(this.access); }

  projectCode() {
    return this.store.tracker.settings.projectCode || mostCommonProject(this.reg.docs) || /^\d{3,5}/.exec(this.host.projectName)?.[0] || "PRJ";
  }

  go(tab: Tab) { this.tab = tab; this.openKey = ""; this.render(); }

  toast(msg: string) {
    const el = h("div", { class: "toast" }, msg);
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3000);
  }

  async run<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    if (this.busy) return undefined;
    this.busy = label;
    this.error = "";
    this.renderBusy();
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
      const api = this.host.api;
      const [items, users] = await Promise.all([api.snapshot(), api.users().catch(() => [] as UserRef[])]);
      this.items = items;
      this.users = users;
      if (first) {
        const me = users.find((u) => u.id === this.host.user.id || (u.email && u.email === this.host.user.email));
        this.access = await loadAccess(api, me?.id ?? this.host.user.id, String(me?.role ?? "").toUpperCase() === "ADMIN");
        this.groups = await api.groups().catch(() => []);
      }
      const pre = buildRegister(items, emptyTracker(), new Map());
      await this.store.load(pre.trackerFolderId, pre.trackerFileId);
      this.rebuild();
      this.todoStates = await ackTodoStates(api, this.store.tracker.transmittals);
    });
  }

  rebuild() {
    this.reg = buildRegister(this.items, this.store.tracker, new Map(this.users.map((u) => [u.id, u])));
  }

  /** Re-read files after operations that create files (site copies, PDFs). */
  async reloadFiles() {
    this.items = await this.host.api.snapshot();
    this.rebuild();
  }

  doc(key: string) { return this.reg.docs.find((d) => d.key === key); }
  labelOf = (key: string) => this.doc(key)?.label ?? key;

  statusOf = (key: string, rev: string): DocStatus => {
    const d = this.doc(key);
    return d?.revs.find((r) => r.revLabel === rev)?.status ?? d?.status ?? "received";
  };

  issuedAt(key: string, rev: string) {
    const l = [...this.store.tracker.log].reverse().find((x) => x.key === key && x.rev === rev && x.to === "construction");
    return l?.at;
  }

  acksOf(key: string, rev: string) { return this.store.tracker.acks[revId(key, rev)] ?? []; }
  ackedByMe(key: string, rev: string) {
    const me = this.host.user;
    return this.acksOf(key, rev).some((a) => (me.id && a.byId === me.id) || a.by === me.name);
  }

  /** What is on site: the controlled copies (tracker.site), plus documents issued before copies existed. A copy stays
   *  listed (with its own revision) while a newer revision is received but not yet issued. */
  siteEntries(): SiteEntry[] {
    const out: SiteEntry[] = [];
    const seen = new Set<string>();
    for (const [key, copy] of Object.entries(this.store.tracker.site)) {
      const d = this.doc(key);
      if (!d) continue;
      seen.add(key);
      out.push({ d, rev: copy.rev, copy, newer: d.current.revLabel !== copy.rev && d.status !== "construction" ? d.current.revLabel : undefined });
    }
    for (const d of this.reg.docs) if (!seen.has(d.key) && d.status === "construction") out.push({ d, rev: d.current.revLabel });
    return out;
  }
  issuable = (d: DocRow) => canIssue(d, this.store.tracker.site[d.key]?.rev);
  siteRootId(): string | undefined {
    const want = sitePath(this.store.tracker.settings.siteFolder).join(" / ");
    for (const id of this.reg.siteFolderIds) {
      const f = this.reg.folders.get(id);
      if (!f) continue;
      const parts: string[] = [];
      let cur: SnapshotItem | undefined = f;
      while (cur) { parts.unshift(cur.nm); cur = cur.pid ? this.reg.folders.get(cur.pid) : undefined; }
      if (parts.join(" / ") === want) return id;
    }
    return undefined;
  }

  assignees(): Assignee[] {
    return [
      ...this.groups.map((g) => ({ type: "GROUP" as const, id: g.id, name: g.name })),
      ...this.users.map((u) => ({ type: "USER" as const, id: u.id, name: u.name })),
    ];
  }

  // ------------------------------------------------------------------ rendering
  render() {
    const shell = h("div", { class: "shell" });
    shell.append(this.header());
    if (!this.host.inConnect) shell.append(h("div", { class: "banner" }, t("mockBanner")));
    if (!can.view(this.access) && this.host.inConnect && !this.busy) {
      shell.append(h("div", { class: "banner error" }, t("noAccess"), this.access.error ? ` (${this.access.error})` : ""));
      clear(this.root, shell);
      return;
    }
    if (!this.canEdit && can.view(this.access) && this.host.inConnect) shell.append(h("div", { class: "banner" }, t("readOnly")));
    if (this.error) shell.append(h("div", { class: "banner error" }, this.error));
    if (this.info) shell.append(h("div", { class: "banner ok" }, this.info, " ", h("button", { class: "link", onclick: () => { this.info = ""; this.render(); } }, "×")));
    const body = h("div", { id: "body" });
    shell.append(body);
    if (this.tab === "site") this.viewSite(body);
    else if (this.tab === "register") this.viewRegister(body);
    else if (this.tab === "transmittals") this.viewTransmittals(body);
    else if (this.tab === "rfis") this.viewRfis(body);
    else this.viewSettings(body);
    shell.append(h("footer", { class: "foot mono" }, "arsten / multiplan · документи", h("span", { class: "muted" }, ` · ${this.host.api.mode} · ${t("role_" + this.access.role)}`)));
    clear(this.root, shell);
    if (this.openKey) this.openDoc(this.openKey);
    else document.querySelectorAll(".drawer, .drawer-bg").forEach((e) => e.remove());
  }

  renderBusy() {
    const s = this.root.querySelector("#busy");
    if (s) s.textContent = this.busy;
  }

  header() {
    const openRfis = this.store.tracker.rfis.filter((r) => r.state === "open").length;
    const inbox = this.reg.docs.filter((d) => d.status === "received" || d.status === "submitted").length;
    const badge = (n: number) => (n ? h("span", { class: "badge" }, n) : "");
    const tab = (k: Tab, extra: any = "") => h("button", { class: this.tab === k ? "active" : "", onclick: () => this.go(k) }, t(k), extra);
    return h("div", null,
      h("header", { class: "top" },
        h("img", { src: "arsten-logo.png", alt: "arsten", class: "logo" }),
        h("div", { class: "proj" },
          h("div", { class: "mono" }, "arsten / multiplan · документи"),
          h("h1", null, this.host.projectName)),
        h("div", { class: "tools" },
          h("span", { id: "busy", class: "mono muted" }, this.busy),
          h("button", { onclick: () => this.refresh(), title: t("refresh") }, "↻"),
          h("button", { onclick: () => { setLang(getLang() === "bg" ? "en" : "bg"); this.setMenu(); this.render(); } }, getLang() === "bg" ? "EN" : "BG"))),
      h("nav", { class: "tabs" }, tab("site", badge(this.siteEntries().filter((e) => !this.ackedByMe(e.d.key, e.rev)).length)), tab("register", badge(inbox)),
        tab("transmittals"), tab("rfis", badge(openRfis)), tab("settings")));
  }

  // ---------------- За изпълнение (site set)
  viewSite(body: HTMLElement) {
    const entries = this.siteEntries();
    const newForMe = entries.filter((e) => !this.ackedByMe(e.d.key, e.rev));
    const rfisOpen = this.store.tracker.rfis.filter((r) => r.state === "open");
    const overdue = rfisOpen.filter((r) => isOverdue(r.due, false)).length;
    const inbox = this.reg.docs.filter((d) => d.status === "received" || d.status === "submitted").length;
    const rootId = this.siteRootId();

    // "Is it current?"
    const out = h("div", { class: "current-out" });
    const check = () => {
      const q = this.siteQ.trim().toLowerCase().replace(/\s+/g, " ");
      if (!q) { clear(out); return; }
      const hits = this.reg.docs.filter((d) => d.label.toLowerCase().includes(q) || d.key.toLowerCase().includes(q) || d.current.name.toLowerCase().includes(q)).slice(0, 6);
      if (!hits.length) { clear(out, h("div", { class: "cur no" }, h("b", null, t("currentNo")), " – ", t("noDocs"))); return; }
      clear(out, hits.map((d) => {
        const e = entries.find((x) => x.d.key === d.key);
        return h("div", { class: "cur " + (e ? "yes" : "no"), onclick: () => this.openDoc(d.key) },
          h("b", null, e ? t("currentYes") : t("currentNo")), " · ",
          h("span", { class: "mono" }, d.label), ` · ${t("currentRev")}: `, h("b", { class: "mono" }, e ? e.rev : "—"),
          e?.newer ? h("span", { class: "muted" }, ` (${t("newerReceived")} ${e.newer})`) : "",
          e ? "" : h("span", { class: "muted" }, ` (${stLabel(d.status)} ${d.current.revLabel})`));
      }));
    };
    const search = h("input", { type: "search", class: "big", placeholder: t("isCurrentHint"), value: this.siteQ, oninput: (ev: Event) => { this.siteQ = (ev.target as HTMLInputElement).value; check(); } });
    body.append(h("div", { class: "currentbox" }, h("label", null, t("isCurrent")), search, out));
    check();

    const stat = (n: number | string, label: string, cls = "", onclick?: () => void) => h("div", { class: `stat ${cls}`, onclick }, h("div", { class: "n" }, n), h("div", { class: "l" }, label));
    body.append(h("div", { class: "stats" },
      stat(entries.length, t("st_construction").toLowerCase()),
      stat(newForMe.length, t("newForMe"), newForMe.length ? "on" : ""),
      stat(inbox, t("inbox").toLowerCase(), inbox ? "on" : "", () => { this.kind = "design"; this.status = "received"; this.go("register"); }),
      stat(rfisOpen.length, t("openRfi"), "", () => this.go("rfis")),
      overdue ? stat(overdue, t("overdueRfi"), "alert", () => this.go("rfis")) : ""));

    const folderName = this.store.tracker.settings.siteFolder || DEFAULT_SITE_FOLDER;
    body.append(h("div", { class: "hint" }, t("siteIntro"), " ", rootId
      ? h("a", { href: folderUrl(this.host.projectId, rootId, this.host.location), target: "_top" }, `„${folderName}“`)
      : h("b", null, `„${folderName}“`), "."));

    if (!entries.length) { body.append(h("div", { class: "empty" }, t("siteEmpty"))); return; }
    if (newForMe.length)
      body.append(h("div", { class: "toolbar" }, h("button", { class: "primary", onclick: () => this.ack(newForMe) }, `✓ ${t("ackAll")} (${newForMe.length})`)));

    const parts = [...new Set(entries.map((e) => e.d.disc))].sort();
    const rows: HTMLElement[] = [];
    for (const p of parts) {
      const list = entries.filter((e) => e.d.disc === p).sort((a, b) => a.d.label.localeCompare(b.d.label, undefined, { numeric: true }));
      rows.push(h("tr", { class: "group" }, h("td", { colspan: 6 }, h("b", null, p), ` · ${DISCIPLINES[p]?.[getLang()] ?? ""} · ${list.length}`)));
      for (const e of list) {
        const d = e.d;
        const acks = this.acksOf(d.key, e.rev);
        const mine = this.ackedByMe(d.key, e.rev);
        rows.push(h("tr", { class: "row" + (mine ? "" : " fresh"), onclick: () => this.openDoc(d.key) },
          h("td", { class: "key" }, d.label, e.newer ? h("div", { class: "muted small" }, `${t("newerReceived")} ${e.newer}`) : ""),
          h("td", { class: "num" }, h("span", { class: "revbig" }, e.rev)),
          h("td", { class: "title hide-sm" }, d.title || h("span", { class: "muted" }, d.current.name)),
          h("td", { class: "date" }, bgDate(this.issuedAt(d.key, e.rev) ?? e.copy?.at)),
          h("td", { class: "hide-sm", title: acks.map((a) => `${a.by} ${bgDate(a.at)}`).join("\n") }, acks.length ? `✓ ${acks.length}` : h("span", { class: "muted" }, t("notAcked"))),
          h("td", { onclick: (ev: Event) => ev.stopPropagation() },
            e.copy ? h("button", { class: "link", onclick: () => this.openFile(e.copy!.fileId) }, "PDF") : "",
            mine ? h("span", { class: "okmark", title: t("acked") }, " ✓") : h("button", { class: "small", onclick: () => this.ack([e]) }, t("ack")))));
      }
    }
    body.append(h("div", { class: "tablewrap" }, h("table", null,
      h("thead", null, h("tr", null, h("th", null, t("number")), h("th", null, t("rev")), h("th", { class: "hide-sm" }, t("title")), h("th", null, t("issued")),
        h("th", { class: "hide-sm" }, t("ackedBy")), h("th", null, ""))),
      h("tbody", null, rows))));
  }

  async ack(entries: { d: DocRow; rev: string }[]) {
    await this.run(t("saving"), async () => {
      const a = { by: this.host.user.name, byId: this.host.user.id, at: new Date().toISOString(), via: "app" as const };
      await this.store.save((tr) => entries.reduce((n, e) => addAck(n, e.d.key, e.rev, a), tr));
      this.toast(`${t("acked")}: ${entries.length}`);
    });
  }

  async ackDocs(docs: DocRow[]) {
    const site = this.store.tracker.site;
    await this.ack(docs.map((d) => ({ d, rev: site[d.key]?.rev ?? d.current.revLabel })));
  }

  // ---------------- Регистър
  filteredDocs(): DocRow[] {
    const q = this.q.trim().toLowerCase();
    return this.reg.docs.filter((d) =>
      d.kind === this.kind &&
      (!this.status || d.status === this.status) &&
      (!this.part || d.disc === this.part) &&
      (!q || `${d.label} ${d.title} ${d.current.name} ${d.current.folderPath}`.toLowerCase().includes(q)));
  }

  viewRegister(body: HTMLElement) {
    if (this.issue) { body.append(this.issuePanel()); return; }
    if (this.upload) { body.append(this.uploadPanel()); return; }
    const all = this.reg.docs;
    const exp = this.expectedRows();
    const expOpen = exp.rows.filter((r) => r.state === "missing" || r.state === "late").length;
    // category chips
    body.append(h("div", { class: "chips" }, KINDS.map((k) => {
      const n = all.filter((d) => d.kind === k).length;
      return h("button", { class: "chip" + (!this.expView && this.kind === k ? " on" : ""), onclick: () => { this.kind = k; this.expView = false; this.status = ""; this.sel.clear(); this.render(); } }, `${t("kind_" + k)} · ${n}`);
    }), h("button", { class: "chip" + (this.expView ? " on" : ""), onclick: () => { this.expView = true; this.sel.clear(); this.render(); } },
      `${t("expected")}`, exp.rows.length ? ` · ${expOpen ? expOpen + " " + t("exp_missing").toLowerCase() : "✓"}` : "")));
    if (this.expView) { this.viewExpected(body, exp); return; }
    const ofKind = all.filter((d) => d.kind === this.kind);
    body.append(h("div", { class: "chips small" },
      h("button", { class: "chip" + (!this.status ? " on" : ""), onclick: () => { this.status = ""; this.render(); } }, `${t("all")} · ${ofKind.length}`),
      STATUS_BY_KIND[this.kind].map((s) => {
        const n = ofKind.filter((d) => d.status === s).length;
        if (!n && s !== this.status) return "";
        return h("button", { class: `chip st-chip s-${slug(s)}` + (this.status === s ? " on" : ""), onclick: () => { this.status = this.status === s ? "" : s; this.render(); } }, `${stLabel(s)} · ${n}`);
      })));

    const tableBox = h("div", { class: "tablewrap" });
    const actions = h("div", { class: "actions-bar" });
    const parts = [...new Set(ofKind.map((d) => d.disc))].sort();
    body.append(h("div", { class: "toolbar" },
      h("input", { type: "search", placeholder: t("search"), value: this.q, oninput: (e: Event) => { this.q = (e.target as HTMLInputElement).value; draw(); } }),
      parts.length > 1 ? h("select", { onchange: (e: Event) => { this.part = (e.target as HTMLSelectElement).value; draw(); } },
        h("option", { value: "" }, t("part") + ": " + t("all")),
        parts.map((p) => h("option", { value: p, selected: this.part === p }, p))) : "",
      h("span", { class: "grow" }),
      this.canEdit ? h("button", { onclick: () => { this.upload = { folderId: "", newFolder: "", files: [], from: "", kind: this.kind }; this.render(); } }, "⇪ " + t("uploadReceived")) : "",
      this.canEdit && this.kind === "design" && !this.store.tracker.transmittals.some((x) => x.purpose === "For construction" && !/НЕУСПЕШНО/.test(x.note ?? ""))
        ? h("button", { title: t("baselineHelp"), onclick: () => this.startBaseline() }, t("baseline")) : "",
      h("button", { onclick: () => this.exportCsv() }, t("exportCsv"))));
    body.append(actions, tableBox);

    const drawActions = () => {
      const docs = this.reg.docs.filter((d) => this.sel.has(d.key));
      if (!docs.length || !this.canEdit) { clear(actions); actions.hidden = true; return; }
      actions.hidden = false;
      const issuable = docs.every(this.issuable);
      clear(actions,
        h("span", null, `${docs.length} ${t("selected")}`),
        h("button", { class: "primary", disabled: !issuable, title: issuable ? "" : "Само получени проектни документи или одобрени работни чертежи (A/B)", onclick: () => this.startIssue(docs.map((d) => d.key)) }, `▶ ${t("issue")}`),
        this.kind === "design" ? h("button", { onclick: () => this.bulkStatus(docs, "info") }, t("markInfo")) : "",
        this.kind === "design" ? h("button", { onclick: () => this.bulkStatus(docs, "review") }, t("markReview")) : "",
        h("select", { onchange: (e: Event) => { const v = (e.target as HTMLSelectElement).value as DocStatus; if (v) this.bulkStatus(docs, v); } },
          h("option", { value: "" }, t("setStatus") + "…"), STATUS_BY_KIND[this.kind].filter((s) => !["A", "B", "C", "D", "superseded", "construction"].includes(s)).map((s) => h("option", { value: s }, stLabel(s)))),
        h("select", { onchange: (e: Event) => { const v = (e.target as HTMLSelectElement).value as Kind; if (v) this.bulkKind(docs, v); } },
          h("option", { value: "" }, t("setKind") + "…"), KINDS.filter((k) => k !== this.kind).map((k) => h("option", { value: k }, t("kind_" + k)))),
        h("button", { onclick: () => this.startRfi(docs.map((d) => d.key)) }, t("newRfi")),
        h("button", { class: "link", onclick: () => { this.sel.clear(); draw(); } }, "×"));
    };

    const draw = () => {
      const list = this.filteredDocs();
      if (!list.length) { clear(tableBox, h("div", { class: "empty" }, t("noDocs"))); drawActions(); return; }
      const allCb = h("input", { type: "checkbox", checked: list.every((d) => this.sel.has(d.key)),
        onchange: (e: Event) => { const on = (e.target as HTMLInputElement).checked; list.forEach((d) => (on ? this.sel.add(d.key) : this.sel.delete(d.key))); draw(); } });
      const rows: HTMLElement[] = [];
      let last = "";
      for (const d of list) {
        const grp = d.source === "file" ? d.current.folderPath : d.disc;
        if (grp !== last) {
          last = grp;
          rows.push(h("tr", { class: "group" }, h("td", { colspan: 7 }, h("b", null, d.disc), d.source === "file" ? ` · ${d.current.folderPath}` : ` · ${DISCIPLINES[d.disc]?.[getLang()] ?? ""}`)));
        }
        const cb = h("input", { type: "checkbox", checked: this.sel.has(d.key), onclick: (e: Event) => e.stopPropagation(),
          onchange: (e: Event) => { (e.target as HTMLInputElement).checked ? this.sel.add(d.key) : this.sel.delete(d.key); (cb.closest("tr") as HTMLElement).classList.toggle("sel"); drawActions(); } });
        rows.push(h("tr", { class: "row" + (this.sel.has(d.key) ? " sel" : ""), onclick: () => this.openDoc(d.key) },
          h("td", { class: "cb" }, this.canEdit ? cb : ""),
          h("td", { class: "key" }, d.label, this.store.tracker.site[d.key] ? h("span", { class: "sitemark", title: t("st_construction") }, " ●") : ""),
          h("td", { class: "num" }, d.current.revLabel, d.revs.length > 1 ? h("span", { class: "muted" }, ` /${d.revs.length}`) : ""),
          h("td", { class: "title hide-sm" }, d.title || h("span", { class: "muted" }, d.current.name)),
          h("td", { onclick: (e: Event) => e.stopPropagation() }, this.statusCell(d, d.current.revLabel, d.status)),
          h("td", { class: "date hide-sm" }, fmtDate(d.current.modified), d.current.modifiedBy ? h("span", { class: "muted" }, ` · ${d.current.modifiedBy}`) : ""),
          h("td", { class: "hide-sm" }, d.transmittals.slice(-1).map((x) => h("span", { class: "tag" }, x)))));
      }
      clear(tableBox, h("table", null,
        h("thead", null, h("tr", null, h("th", { class: "cb" }, this.canEdit ? allCb : ""), h("th", null, t("number")), h("th", null, t("rev")), h("th", { class: "hide-sm" }, t("title")),
          h("th", null, t("status")), h("th", { class: "hide-sm" }, t("modified")), h("th", { class: "hide-sm" }, t("transmittals")))),
        h("tbody", null, rows)));
      drawActions();
    };
    draw();

    if (this.reg.unnumbered.length && this.kind === "design")
      body.append(h("details", { class: "unnum" },
        h("summary", null, `${t("unnumbered")} (${this.reg.unnumbered.length})`),
        h("div", { class: "tablewrap" }, h("table", null, h("tbody", null, this.reg.unnumbered.map((f) => h("tr", null,
          h("td", null, f.name), h("td", { class: "soft hide-sm" }, f.folderPath), h("td", { class: "date" }, fmtDate(f.modified)))))))));
  }

  statusCell(d: DocRow, rev: string, cur: DocStatus) {
    const editable = this.canEdit && cur !== "superseded" && cur !== "construction" && !(d.kind === "submittal" && ["A", "B", "C", "D"].includes(cur) && !can.decide(this.access));
    if (!editable) return h("span", { class: `st s-${slug(cur)}` }, stLabel(cur));
    const opts = STATUS_BY_KIND[d.kind].filter((s) => s !== "superseded" && (d.kind !== "submittal" || !["A", "B", "C", "D"].includes(s) || can.decide(this.access)));
    return h("select", { class: `stsel s-${slug(cur)}`, onchange: (e: Event) => this.changeStatus(d, rev, (e.target as HTMLSelectElement).value as DocStatus) },
      opts.map((s) => h("option", { value: s, selected: s === cur }, stLabel(s))));
  }

  async changeStatus(d: DocRow, rev: string, to: DocStatus) {
    if (to === "construction") { this.startIssue([d.key]); return; }
    if (d.kind === "submittal" && ["A", "B", "C", "D"].includes(to)) { await this.decide(d, to as any, ""); return; }
    const from = this.statusOf(d.key, rev);
    if (from === to) return;
    await this.run(t("saving"), async () => {
      await this.store.save((tr) => setStatus(tr, d.key, rev, to, from, this.actor()));
      this.rebuild();
      this.toast(`${d.label} ${rev} → ${stLabel(to)}`);
    });
  }

  async bulkStatus(docs: DocRow[], to: DocStatus) {
    if (to === "construction") { this.startIssue(docs.map((d) => d.key)); return; }
    await this.run(t("saving"), async () => {
      const skip = docs.filter((d) => d.status === "superseded" || d.status === "construction" || (["A", "B", "C", "D"].includes(d.status) && !can.decide(this.access)));
      const go = docs.filter((d) => !skip.includes(d));
      await this.store.save((tr) => go.reduce((n, d) => setStatus(n, d.key, d.current.revLabel, to, d.status, this.actor()), tr));
      if (skip.length) this.error = `${t("skipped")}: ${skip.map((d) => d.label).join(", ")}`;
      this.sel.clear();
      this.rebuild();
      this.toast(`${docs.length} → ${stLabel(to)}`);
    });
  }

  async bulkKind(docs: DocRow[], kind: Kind) {
    await this.run(t("saving"), async () => {
      await this.store.save((tr) => docs.reduce((n, d) => setMeta(n, d.key, { kind }), tr));
      this.sel.clear();
      this.rebuild();
      this.kind = kind;
      this.toast(`${docs.length} → ${t("kind_" + kind)}`);
    });
  }

  async decide(d: DocRow, decision: "A" | "B" | "C" | "D", remark: string) {
    await this.run(t("saving"), async () => {
      const w = await decideSubmittal(this.ctx, d, decision, remark);
      await this.reloadFiles();
      if (w.length) this.error = w.join(" · ");
      this.toast(`${d.label} → ${stLabel(decision)}`);
    });
  }

  // ---------------- upload received files (the GC receives designs by email and files them in Connect)
  folderOptions(): { id: string; path: string }[] {
    const out: { id: string; path: string }[] = [];
    for (const [id, f] of this.reg.folders) {
      if (this.reg.siteFolderIds.has(id)) continue;
      const parts: string[] = [];
      let cur: SnapshotItem | undefined = f;
      let skip = false;
      while (cur) { if (TOOL_FOLDERS.includes(cur.nm)) skip = true; parts.unshift(cur.nm); cur = cur.pid ? this.reg.folders.get(cur.pid) : undefined; }
      if (!skip) out.push({ id, path: parts.join(" / ") });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  uploadPanel() {
    const u = this.upload!;
    const folders = this.folderOptions();
    const list = h("div", { class: "muted small" });
    const drawList = () => clear(list, u.files.map((f) => {
      const exists = this.items.some((i) => i.tp === "FILE" && !i.del && i.pid === u.folderId && i.nm === f.name);
      return h("div", null, `${f.name} · ${Math.round(f.size / 1024)} KB`, exists ? h("b", { class: "okmark" }, ` – ${t("newRevision")}`) : "");
    }));
    if (u.done) {
      return h("div", { class: "panel" }, h("h2", null, `✓ ${t("uploaded")}: ${u.done.length}`), h("div", null, u.done.map((n) => h("div", { class: "soft" }, n))),
        h("p", { class: "hint" }, t("uploadNext")),
        h("div", { class: "actions" }, h("button", { class: "primary", onclick: () => { this.upload = null; this.kind = u.kind; this.status = DEFAULT_FOR[u.kind]; this.render(); } }, t("register") + " →")));
    }
    const fileInput = h("input", { type: "file", multiple: true, accept: ".pdf,.dwg,.dxf,.ifc,.docx,.xlsx,.zip,image/*",
      onchange: (e: Event) => { u.files = [...((e.target as HTMLInputElement).files ?? [])]; drawList(); } });
    return h("div", { class: "panel" },
      h("h2", null, t("uploadReceived")),
      h("p", { class: "hint" }, t("uploadHint")),
      h("div", { class: "form" },
        h("label", null, t("folder")), h("select", { onchange: (e: Event) => { u.folderId = (e.target as HTMLSelectElement).value; drawList(); } },
          h("option", { value: "" }, "—"), folders.map((f) => h("option", { value: f.id, selected: f.id === u.folderId }, f.path))),
        h("label", null, t("newSubfolder")), h("input", { value: u.newFolder, placeholder: "напр. 2026-11-17 Пакет от проектанта", oninput: (e: Event) => { u.newFolder = (e.target as HTMLInputElement).value; } }),
        h("label", null, t("kind")), h("select", { onchange: (e: Event) => { u.kind = (e.target as HTMLSelectElement).value as Kind; } },
          KINDS.map((k) => h("option", { value: k, selected: k === u.kind }, t("kind_" + k)))),
        h("label", null, t("receivedFrom")), h("input", { value: u.from, placeholder: "проектант / доставчик", oninput: (e: Event) => { u.from = (e.target as HTMLInputElement).value; } }),
        h("label", null, t("files")), h("div", null, fileInput, list)),
      h("div", { class: "actions" },
        h("button", { class: "primary", onclick: () => this.doUpload() }, "⇪ " + t("uploadReceived")),
        h("button", { onclick: () => { this.upload = null; this.render(); } }, t("cancel"))));
  }

  async doUpload() {
    const u = this.upload!;
    if (!u.files.length) { alert(t("files") + "?"); return; }
    if (!u.folderId && !u.newFolder.trim()) { alert(t("folder") + "?"); return; }
    await this.run(t("saving"), async () => {
      const api = this.host.api;
      let folderId = u.folderId || (await api.rootFolderId());
      if (u.newFolder.trim()) folderId = await api.createFolder(u.newFolder.trim().replace(/[\/:*?"<>|]+/g, "-"), folderId);
      const done: string[] = [];
      const ids: string[] = [];
      for (const [i, f] of u.files.entries()) {
        this.busy = `${i + 1}/${u.files.length} ${f.name}`; this.renderBusy();
        const r = await api.upload(folderId, f.name, f);
        done.push(f.name);
        ids.push(r.fileId);
      }
      await this.reloadFiles();
      // register the package and the category of the new documents
      const keys = this.reg.docs.filter((d) => d.revs.some((r) => ids.includes(r.fileId))).map((d) => `${d.key}@${d.current.revLabel}`);
      await this.store.save((tr) => {
        let n = tr;
        if (u.kind !== "design") for (const k of keys) n = setMeta(n, k.split("@")[0], { kind: u.kind });
        const pkgId = nextPackageId(n, this.projectCode());
        return { ...n, packages: [...n.packages, { id: pkgId, date: today(), from: u.from.trim(), by: this.host.user.name, createdAt: new Date().toISOString(), items: keys }] };
      });
      this.rebuild();
      u.done = done;
    });
  }

  // ---------------- issue for construction
  startIssue(keys: string[]) {
    const docs = keys.map((k) => this.doc(k)).filter((d): d is DocRow => !!d && this.issuable(d));
    if (!docs.length) return;
    this.issue = { keys: docs.map((d) => d.key), to: "Обект / Site", attn: "", note: "", date: today(), ack: true };
    this.tab = "register";
    this.openKey = "";
    this.render();
  }

  /** Starting set: every design document whose current revision can be issued (not yet on site). */
  startBaseline() {
    const docs = this.reg.docs.filter((d) => d.kind === "design" && this.issuable(d) && !this.store.tracker.site[d.key]);
    if (!docs.length) { this.toast(t("baselineNone")); return; }
    this.issue = { keys: docs.map((d) => d.key), to: "Обект / Site", attn: "", note: `${t("baselineNote")} ${bgDate(today())}`, date: today(), baseline: true, ack: true };
    this.expView = false;
    this.tab = "register";
    this.openKey = "";
    this.render();
  }

  issuePanel() {
    const s = this.issue!;
    const docs = s.keys.map((k) => this.doc(k)).filter(Boolean) as DocRow[];
    const set = (k: "to" | "attn" | "note" | "date") => (e: Event) => { (s as any)[k] = (e.target as HTMLInputElement).value; };
    const ack = this.store.tracker.settings.ackAssignee;
    const folder = this.store.tracker.settings.siteFolder || DEFAULT_SITE_FOLDER;
    if (s.result) {
      const r = s.result;
      return h("div", { class: "panel" },
        h("h2", null, `✓ ${t("issuedOk")}: ${r.tr.id}`),
        h("p", null, `${r.tr.items.length} ${t("documents")} · ${r.copies} ${t("copies")} „${folder}“`, r.todoId ? ` · ${t("ackTodo")} → ${ack?.name ?? ""}` : ""),
        r.warnings.length ? h("div", { class: "banner error" }, h("b", null, t("warnings") + ": "), h("ul", null, r.warnings.map((w) => h("li", null, w)))) : "",
        h("div", { class: "actions" },
          r.tr.pdfFileId ? h("button", { onclick: () => this.openFile(r.tr.pdfFileId!) }, `${t("pdf")} ${r.tr.id}`) : "",
          h("button", { onclick: () => this.mailDraft(r.tr) }, `✉ ${t("mailDraft")}`),
          h("button", { class: "primary", onclick: () => { this.issue = null; this.sel.clear(); this.go("site"); } }, t("site") + " →"),
          h("button", { onclick: () => { this.issue = null; this.sel.clear(); this.render(); } }, t("close"))));
    }
    return h("div", { class: "panel issue" },
      h("h2", null, s.baseline ? t("baseline") : t("issueTitle"), h("span", { class: "mono muted", style: "font-size:13px;margin-left:10px" }, nextTransmittalId(this.store.tracker, this.projectCode()))),
      s.baseline ? h("p", { class: "soft" }, t("baselineHelp")) : "",
      h("div", { class: "tablewrap" + (docs.length > 12 ? " scroll" : "") }, h("table", null, h("tbody", null, docs.map((d) => {
        const prev = this.store.tracker.site[d.key];
        return h("tr", null, h("td", { class: "key" }, d.label), h("td", { class: "num" }, h("span", { class: "revbig" }, d.current.revLabel)),
          h("td", { class: "hide-sm" }, d.title || d.current.name), h("td", { class: "muted" }, prev ? `${t("st_superseded").toLowerCase()}: ${prev.rev}` : ""),
          docs.length > 1 ? h("td", null, h("button", { class: "link", title: t("removeRow"), onclick: () => { s.keys = s.keys.filter((k) => k !== d.key); this.render(); } }, "×")) : "");
      })))),
      h("div", { class: "explain" }, h("b", null, t("issueWhat")), h("ol", null,
        h("li", null, t("issueStep1")),
        h("li", null, t("issueStep2"), ` „${folder}/<${t("part").toLowerCase()}>“`),
        h("li", null, t("issueStep3")),
        h("li", null, t("issueStep4"), " ", ack ? h("b", null, ack.name) : h("span", { class: "muted" }, t("issueNoAck"))))),
      h("div", { class: "form" },
        h("label", null, t("to")), h("input", { value: s.to, oninput: set("to"), list: "recips" }),
        h("datalist", { id: "recips" }, [...new Set(this.store.tracker.transmittals.map((x) => x.to))].map((r) => h("option", { value: r }))),
        h("label", null, t("attn")), h("input", { value: s.attn, oninput: set("attn") }),
        h("label", null, t("date")), h("input", { type: "date", value: s.date, oninput: set("date") }),
        h("label", null, t("note")), h("textarea", { rows: 2, oninput: set("note") }, s.note),
        ack ? h("label", null, "") : "", ack ? h("label", { class: "check" }, h("input", { type: "checkbox", checked: s.ack, onchange: (e: Event) => { s.ack = (e.target as HTMLInputElement).checked; } }), ` ${t("ackCreate")} → ${ack.name}`) : ""),
      h("div", { class: "actions" },
        h("button", { class: "primary", disabled: !!this.busy || !docs.length, onclick: () => this.doIssue() }, `▶ ${t("issue")} (${docs.length})`),
        h("button", { onclick: () => { this.issue = null; this.render(); } }, t("cancel"))));
  }

  async doIssue() {
    const s = this.issue!;
    const docs = s.keys.map((k) => this.doc(k)).filter(Boolean) as DocRow[];
    await this.run(t("saving"), async () => {
      const r = await issueForConstruction(this.ctx, docs, { to: s.to, attn: s.attn, note: s.note, date: s.date, baseline: s.baseline, ack: s.ack }, this.statusOf);
      this.busy = "PDF…"; this.renderBusy();
      await this.attachPdf(r.tr);
      await this.reloadFiles();
      r.tr = this.store.tracker.transmittals.find((x) => x.id === r.tr.id) ?? r.tr;
      s.result = r;
      this.todoStates = await ackTodoStates(this.host.api, this.store.tracker.transmittals);
    });
  }

  mailDraft(tr: Transmittal) {
    const lines = tr.items.map((i) => `- ${i.label ?? i.key} ${i.rev}${i.title ? " – " + i.title : ""}`);
    const body = [
      `Здравейте,`, ``, `Издаваме за изпълнение (${tr.id}, ${bgDate(tr.date)}):`, ...lines, ``,
      `Текущите чертежи са в Trimble Connect, проект „${this.host.projectName}“, папка „${this.store.tracker.settings.siteFolder || DEFAULT_SITE_FOLDER}“.`,
      `Моля, потвърдете получаването.`, ``, this.host.user.name, `Arsten / MULTIPLAN`,
    ].join("\n");
    const href = `mailto:?subject=${encodeURIComponent(`${tr.id} – ${t("pu_" + tr.purpose)} – ${this.host.projectName}`)}&body=${encodeURIComponent(body)}`;
    window.open(href, "_blank");
  }

  // ---------------- document drawer
  openDoc(key: string) {
    document.querySelectorAll(".drawer, .drawer-bg").forEach((e) => e.remove());
    const d = this.doc(key);
    this.openKey = d ? key : "";
    if (!d) return;
    const close = () => { this.openKey = ""; bg.remove(); dr.remove(); };
    const tr = this.store.tracker;
    const log = tr.log.filter((l) => l.key === key).slice().reverse();
    const trs = tr.transmittals.filter((x) => x.items.some((i) => i.key === key));
    const rfis = tr.rfis.filter((r) => r.docs.includes(key));
    const acks = this.acksOf(key, d.current.revLabel);
    const copy = tr.site[key];
    const bg = h("div", { class: "drawer-bg", onclick: close });
    const metaBox = h("div");
    const drawMeta = (editing: boolean) => {
      const m = d.meta;
      if (!editing) {
        clear(metaBox, h("div", { class: "metagrid" },
          h("span", null, t("kind")), h("b", null, t("kind_" + d.kind)),
          h("span", null, t("part")), h("b", null, d.disc),
          h("span", null, t("type")), h("b", null, d.type),
          m.form ? [h("span", null, t("meta_form")), h("b", null, m.form)] : "",
          m.location ? [h("span", null, t("meta_location")), h("b", null, m.location)] : "",
          m.originator ? [h("span", null, t("meta_originator")), h("b", null, m.originator)] : "",
          h("span", null, t("folder")), h("span", null, d.current.folderPath)),
          this.canEdit ? h("button", { class: "link", onclick: () => drawMeta(true) }, "✎ " + t("editMeta")) : "");
        return;
      }
      const v: DocMeta = { ...m };
      const field = (k: keyof DocMeta, label: string) => [h("label", null, label), h("input", { value: (v as any)[k] ?? "", oninput: (e: Event) => { (v as any)[k] = (e.target as HTMLInputElement).value.trim(); } })];
      clear(metaBox, h("div", { class: "form tight" },
        h("label", null, t("kind")), h("select", { onchange: (e: Event) => { v.kind = (e.target as HTMLSelectElement).value as Kind; } },
          KINDS.map((k) => h("option", { value: k, selected: k === d.kind }, t("kind_" + k)))),
        field("number", t("meta_number")), field("title", t("meta_title")), field("part", t("meta_part")), field("type", t("meta_type")),
        field("form", t("meta_form")), field("location", t("meta_location")), field("originator", t("meta_originator"))),
        h("div", { class: "actions" },
          h("button", { class: "primary", onclick: () => this.run(t("saving"), async () => { await this.store.save((x) => setMeta(x, key, v)); this.rebuild(); }) }, t("save")),
          h("button", { onclick: () => drawMeta(false) }, t("cancel"))));
    };
    drawMeta(false);
    const decision = h("div");
    if (d.kind === "submittal" && can.decide(this.access) && d.status !== "superseded" && d.status !== "construction") {
      const remark = h("input", { placeholder: t("note") });
      clear(decision, h("h3", null, t("decide")), remark, h("div", { class: "actions wrap" },
        (["A", "B", "C", "D"] as const).map((x) => h("button", { class: `dec dec-${x}`, onclick: () => this.decide(d, x, (remark as HTMLInputElement).value) }, stLabel(x)))));
    }
    const dr = h("div", { class: "drawer" },
      h("button", { class: "close", onclick: close }, t("close")),
      h("div", { class: "mono muted" }, `${t("kind_" + d.kind)} · ${d.disc}`),
      h("h2", null, d.label),
      h("div", { class: "soft" }, d.title || d.current.name),
      h("div", { class: "bigstatus" }, h("span", { class: `st s-${slug(d.status)}` }, stLabel(d.status)), " ", h("span", { class: "revbig" }, d.current.revLabel)),
      h("div", { class: "actions wrap" },
        this.canEdit && this.issuable(d) ? h("button", { class: "primary", onclick: () => { close(); this.startIssue([key]); } }, `▶ ${t("issue")}`) : "",
        copy ? h("button", { onclick: () => this.openFile(copy.fileId) }, `PDF „${t("st_construction")}“`) : "",
        h("button", { onclick: () => this.openFile(d.current.fileId, d.current.versionId) }, t("download") + " (оригинал)"),
        d.status === "construction" && !this.ackedByMe(key, d.current.revLabel) ? h("button", { onclick: () => this.ackDocs([d]) }, "✓ " + t("ack")) : "",
        this.canEdit ? h("button", { onclick: () => { close(); this.startRfi([key]); } }, t("newRfi")) : "",
        this.canEdit && copy ? h("button", { class: "danger", onclick: () => this.withdraw(d) }, t("withdraw")) : ""),
      decision,
      h("h3", null, t("editMeta")), metaBox,
      h("h3", null, t("revisions")),
      d.source === "file" ? this.versionTable(d) : h("table", null, h("tbody", null, [...d.revs].reverse().map((r) => h("tr", null,
        h("td", { class: "num" }, r.revLabel),
        h("td", null, r === d.current ? this.statusCell(d, r.revLabel, r.status) : h("span", { class: `st s-${slug(r.status)}` }, stLabel(r.status))),
        h("td", { class: "date" }, fmtDate(r.modified), r.modifiedBy ? ` · ${r.modifiedBy}` : ""),
        h("td", null, h("button", { class: "link", onclick: () => this.openFile(r.fileId, r.versionId) }, t("download"))))))),
      d.status === "construction" ? [h("h3", null, `${t("ackedBy")} (${d.current.revLabel})`),
        acks.length ? h("div", null, acks.map((a) => h("div", { class: "soft" }, `✓ ${a.by} · ${bgDate(a.at)}`))) : h("div", { class: "muted" }, t("notAcked"))] : "",
      h("h3", null, t("statusLog")),
      log.length ? h("table", null, h("tbody", null, log.map((l) => h("tr", null,
        h("td", { class: "date" }, fmtDate(l.at)), h("td", { class: "num" }, l.rev),
        h("td", null, `${stLabel(l.from)} → `, h("span", { class: `st s-${slug(l.to)}` }, stLabel(l.to))),
        h("td", { class: "soft" }, l.by, l.transmittal ? h("span", { class: "tag", style: "margin-left:6px" }, l.transmittal) : "", l.note ? ` – ${l.note}` : ""))))) : h("div", { class: "muted" }, t("noLog")),
      h("h3", null, t("transmittals")),
      trs.length ? h("table", null, h("tbody", null, trs.map((x) => h("tr", null,
        h("td", { class: "num" }, x.id), h("td", { class: "date" }, fmtDate(x.date)), h("td", null, x.to),
        h("td", null, x.items.filter((i) => i.key === key).map((i) => i.rev).join(", ")), h("td", null, t("pu_" + x.purpose)))))) : h("div", { class: "muted" }, t("none")),
      h("h3", null, t("rfis")),
      rfis.length ? h("div", null, rfis.map((r) => h("div", { class: "soft link-row", onclick: () => { close(); this.rfiOpen = r.id; this.go("rfis"); } }, `${r.id} · ${r.title} · ${t("rfiState_" + r.state)}`))) : h("div", { class: "muted" }, t("none")));
    document.body.append(bg, dr);
  }

  /** File documents: revisions are Connect versions, loaded on demand. */
  versionTable(d: DocRow) {
    const box = h("div", { class: "muted" }, t("loading"));
    this.host.api.versions(d.current.fileId).then((vs) => {
      const st = this.store.tracker.status;
      clear(box, h("table", null, h("tbody", null, vs.map((v) => {
        const lbl = `v${v.revision}`;
        const cur = v.revision === d.current.rev;
        const stored = st[revId(d.key, lbl)];
        const status: DocStatus = cur ? d.status : !stored || stored === "construction" ? "superseded" : stored;
        return h("tr", null,
          h("td", { class: "num" }, lbl),
          h("td", null, cur ? this.statusCell(d, lbl, d.status) : h("span", { class: `st s-${slug(status)}` }, stLabel(status))),
          h("td", { class: "date" }, fmtDate(v.modified), v.modifiedBy ? ` · ${v.modifiedBy}` : ""),
          h("td", null, h("button", { class: "link", onclick: () => this.openFile(d.current.fileId, v.versionId) }, t("download"))));
      }))));
      box.className = "";
    }).catch((e) => { box.textContent = `${t("error")}: ${e?.message ?? e}`; });
    return box;
  }

  async withdraw(d: DocRow) {
    const note = prompt(`${t("withdraw")}: ${d.label} ${d.current.revLabel}?`, "");
    if (note === null) return;
    await this.run(t("saving"), async () => {
      const w = await withdrawFromSite(this.ctx, d, note);
      if (w.length) this.error = w.join(" · ");
      await this.reloadFiles();
      this.toast(`${d.label} → ${stLabel("superseded")}`);
    });
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

  exportCsv() {
    const esc = (s: unknown) => `"${String(s ?? "").replace(/"/g, '""')}"`;
    const head = ["Категория", "Номер", "Част", "Вид", "Ревизия", "Наименование", "Статус", "Издаден", "Потвърдили", "Качен", "Качил", "Папка", "Файл", "Трансмитали"];
    const lines = [head.join(";")].concat(this.reg.docs.map((d) => [
      t("kindShort_" + d.kind), d.label, d.disc, d.type, d.current.revLabel, d.title, stLabel(d.status),
      bgDate(this.issuedAt(d.key, d.current.revLabel)), this.acksOf(d.key, d.current.revLabel).map((a) => a.by).join(", "),
      d.current.modified?.slice(0, 10), d.current.modifiedBy, d.current.folderPath, d.current.name, d.transmittals.join(" "),
    ].map(esc).join(";")));
    downloadBlob(new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" }), `register_${this.projectCode()}_${today()}.csv`);
  }

  // ---------------- Трансмитали
  viewTransmittals(body: HTMLElement) {
    if (this.trForm) body.append(this.transmittalForm());
    else if (this.canEdit) body.append(h("div", { class: "toolbar" }, h("button", { onclick: () => this.startTransmittal() }, "+ " + t("newTransmittal")),
      h("span", { class: "muted" }, ` ${t("issue")}: ${t("register")} → ▶`)));
    const list = [...this.store.tracker.transmittals].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (!list.length) { body.append(h("div", { class: "empty" }, t("noTransmittals"))); return; }
    body.append(h("div", { class: "tablewrap" }, h("table", null,
      h("thead", null, h("tr", null, h("th", null, "№"), h("th", null, t("date")), h("th", null, t("to")), h("th", null, t("purpose")),
        h("th", null, t("items")), h("th", null, t("ackedBy")), h("th", null, ""))),
      h("tbody", null, list.map((x) => {
        const todo = x.todoId ? this.todoStates.get(x.todoId) : undefined;
        const appAcks = x.items.reduce((n, i) => n + this.acksOf(i.key, i.rev).length, 0);
        return h("tr", null,
          h("td", { class: "key" }, x.id, x.baseline ? h("div", null, h("span", { class: "tag" }, t("baseline").toLowerCase())) : ""),
          h("td", { class: "date" }, fmtDate(x.date)),
          h("td", null, x.to, x.attn ? h("div", { class: "muted" }, x.attn) : "", h("div", { class: "muted" }, x.by)),
          h("td", null, h("span", { class: `st s-${slug(statusForPurpose(x.purpose))}` }, t("pu_" + x.purpose))),
          h("td", null, h("details", null, h("summary", null, `${x.items.length}`),
            x.items.map((i) => h("div", { class: "mono", style: "font-size:12px" }, `${i.label ?? this.labelOf(i.key)} ${i.rev}`)))),
          h("td", { class: "soft" },
            x.todoId ? h("div", null, `${t("ackTodo")} (${x.ackTarget ?? ""}): `, todo ? (todo.closed ? h("b", { class: "okmark" }, `✓ ${t("ackClosed")}${todo.by ? " – " + todo.by : ""}`) : t("ackOpen")) : "…") : "",
            appAcks ? h("div", null, `✓ ${appAcks}`) : ""),
          h("td", null,
            x.pdfFileId ? h("button", { class: "link", onclick: () => this.openFile(x.pdfFileId!) }, t("pdf")) : (this.canEdit ? h("button", { class: "link", onclick: () => this.run(t("saving"), () => this.attachPdf(x)) }, "PDF ↻") : ""),
            " ", h("button", { class: "link", onclick: () => this.mailDraft(x) }, "✉")));
      })))));
  }

  startTransmittal() {
    this.trForm = { to: "", attn: "", purpose: "For information", date: today(), note: "", keys: new Set(), filter: "" };
    this.go("transmittals");
  }

  transmittalForm() {
    const f = this.trForm!;
    const set = (k: "to" | "attn" | "date" | "note" | "purpose") => (e: Event) => { (f as any)[k] = (e.target as HTMLInputElement).value; };
    const pick = h("div", { class: "picker" });
    const count = h("span", { class: "muted" });
    const draw = () => {
      const q = f.filter.toLowerCase();
      const docs = this.reg.docs.filter((d) => d.status !== "superseded" && (!q || `${d.label} ${d.title} ${d.current.folderPath}`.toLowerCase().includes(q)));
      clear(pick, h("table", null, h("tbody", null, docs.map((d) => h("tr", { class: "row" + (f.keys.has(d.key) ? " sel" : ""), onclick: () => { f.keys.has(d.key) ? f.keys.delete(d.key) : f.keys.add(d.key); draw(); } },
        h("td", { class: "cb" }, h("input", { type: "checkbox", checked: f.keys.has(d.key) })),
        h("td", { class: "key" }, d.label), h("td", { class: "num" }, d.current.revLabel), h("td", { class: "hide-sm" }, d.title || d.current.folderPath),
        h("td", null, h("span", { class: `st s-${slug(d.status)}` }, stLabel(d.status))))))));
      count.textContent = `${f.keys.size} ${t("selected")}`;
    };
    draw();
    return h("div", { class: "panel" },
      h("h2", null, t("newTransmittal"), h("span", { class: "mono muted", style: "font-size:13px;margin-left:10px" }, nextTransmittalId(this.store.tracker, this.projectCode()))),
      h("div", { class: "form" },
        h("label", null, t("to")), h("input", { value: f.to, oninput: set("to"), list: "recips2" }),
        h("datalist", { id: "recips2" }, [...new Set(this.store.tracker.transmittals.map((x) => x.to))].map((r) => h("option", { value: r }))),
        h("label", null, t("attn")), h("input", { value: f.attn, oninput: set("attn") }),
        h("label", null, t("purpose")), h("select", { onchange: set("purpose") }, OTHER_PURPOSES.map((p) => h("option", { value: p, selected: p === f.purpose }, t("pu_" + p)))),
        h("label", null, t("date")), h("input", { type: "date", value: f.date, oninput: set("date") }),
        h("label", null, t("note")), h("textarea", { rows: 2, oninput: set("note") }, f.note),
        h("label", null, t("items")),
        h("div", null, h("div", { class: "toolbar" }, h("input", { type: "search", placeholder: t("search"), value: f.filter, oninput: (e: Event) => { f.filter = (e.target as HTMLInputElement).value; draw(); } }), count), pick)),
      h("div", { class: "actions" },
        h("button", { class: "primary", onclick: () => this.createTransmittal() }, t("create")),
        h("button", { onclick: () => { this.trForm = null; this.render(); } }, t("cancel"))));
  }

  async createTransmittal() {
    const f = this.trForm!;
    if (!f.to.trim()) { alert(t("to") + "?"); return; }
    if (!f.keys.size) { alert(t("pickDocs")); return; }
    await this.run(t("saving"), async () => {
      const docs = this.reg.docs.filter((d) => f.keys.has(d.key));
      let created!: Transmittal;
      await this.store.save((tr) => {
        created = {
          id: nextTransmittalId(tr, this.projectCode()), date: f.date, to: f.to.trim(), attn: f.attn.trim() || undefined, purpose: f.purpose, note: f.note.trim() || undefined,
          by: this.host.user.name, byId: this.host.user.id, createdAt: new Date().toISOString(),
          items: docs.map((d) => ({ key: d.key, ...(d.source === "file" ? { label: d.label } : {}), rev: d.current.revLabel, name: d.current.name, title: d.title || undefined, fileId: d.current.fileId, versionId: d.current.versionId })),
        };
        return addTransmittal(tr, created, this.statusOf, this.actor());
      });
      this.trForm = null;
      this.rebuild();
      await this.attachPdf(created);
      this.toast(`${t("trCreated")}: ${created.id}`);
    });
  }

  /** Builds the transmittal PDF, uploads it to <tool folder>/Transmittals/ (_AM_Docs, or an existing _ArstenDocs) and stores its file id. */
  async attachPdf(tr: Transmittal) {
    const { transmittalPdf } = await import("./pdf");
    const bytes = await transmittalPdf(tr, this.host.projectName);
    const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
    try {
      const items = await this.host.api.snapshot();
      this.items = items;
      const parent = await this.store.ensureFolder();
      let folder = items.find((i) => i.tp === "FOLDER" && i.nm === "Transmittals" && i.pid === parent && !i.del)?.id;
      if (!folder) folder = await this.host.api.createFolder("Transmittals", parent);
      const up = await this.host.api.upload(folder, `${tr.id}.pdf`, blob);
      await this.store.save((x) => ({ ...x, transmittals: x.transmittals.map((y) => (y.id === tr.id ? { ...y, pdfFileId: up.fileId } : y)) }));
      this.rebuild();
    } catch (e: any) {
      downloadBlob(blob, `${tr.id}.pdf`);
      this.error = `PDF upload: ${e?.message ?? e}`;
    }
  }

  // ---------------- Въпроси (RFI)
  startRfi(keys: string[]) {
    const def = this.store.tracker.settings.rfiAssignee;
    this.rfiForm = { title: "", question: "", docs: new Set(keys), location: "", due: addDays(today(), 5), assignee: def ? `${def.type}:${def.id}` : "", filter: "" };
    this.rfiOpen = "";
    this.go("rfis");
  }

  viewRfis(body: HTMLElement) {
    if (this.rfiForm) body.append(this.rfiFormPanel());
    else body.append(h("div", { class: "toolbar" },
      this.canEdit ? h("button", { class: "primary", onclick: () => this.startRfi([]) }, "+ " + t("newRfi")) : "",
      h("button", { class: this.rfiFilter === "open" ? "chip on" : "chip", onclick: () => { this.rfiFilter = "open"; this.render(); } }, t("rfiState_open")),
      h("button", { class: this.rfiFilter === "all" ? "chip on" : "chip", onclick: () => { this.rfiFilter = "all"; this.render(); } }, t("all"))));
    const list = this.store.tracker.rfis.filter((r) => this.rfiFilter === "all" || r.state !== "closed").slice().sort((a, b) => b.askedAt.localeCompare(a.askedAt));
    if (!list.length) { body.append(h("div", { class: "empty" }, t("rfiNone"))); return; }
    body.append(h("div", { class: "hint" }, t("rfiNotInstruction")));
    body.append(h("div", { class: "rfilist" }, list.map((r) => this.rfiCard(r))));
  }

  rfiCard(r: Rfi) {
    const open = this.rfiOpen === r.id;
    const late = r.state === "open" && isOverdue(r.due, false);
    const ball = r.state === "open" ? r.assignee?.name ?? "—" : r.state === "answered" ? r.askedBy : "—";
    const head = h("div", { class: "rfihead", onclick: () => { this.rfiOpen = open ? "" : r.id; this.render(); } },
      h("span", { class: "key" }, r.id), h("b", null, r.title),
      h("span", { class: `st rfi-${r.state}` }, t("rfiState_" + r.state)),
      h("span", { class: late ? "date overdue" : "date" }, r.due ? `${t("rfiDue")} ${bgDate(r.due)}` : ""),
      h("span", { class: "muted" }, `${t("rfiBall")}: ${ball}`));
    if (!open) return h("div", { class: "rficard" }, head);
    const answer = h("textarea", { rows: 3, placeholder: t("rfiAnswer") }) as HTMLTextAreaElement;
    let outcome: Rfi["outcome"] = "none";
    return h("div", { class: "rficard open" }, head,
      h("div", { class: "rfibody" },
        h("div", { class: "q" }, r.question),
        h("div", { class: "muted" }, `${t("rfiAsked")}: ${r.askedBy} · ${bgDate(r.askedAt)}`, r.location ? ` · ${r.location}` : "", r.todoId ? ` · ToDo` : ""),
        r.docs.length ? h("div", null, `${t("rfiDocs")}: `, r.docs.map((k) => h("button", { class: "link", onclick: () => { this.tab = "register"; const d = this.doc(k); if (d) this.kind = d.kind; this.openKey = k; this.render(); } }, this.labelOf(k) + " "))) : "",
        r.answer ? h("div", { class: "a" }, h("b", null, `${t("rfiAnswer")} (${r.answeredBy}, ${bgDate(r.answeredAt)}): `), r.answer,
          r.outcome ? h("div", { class: "muted" }, `${t("rfiOutcome")}: ${t("out_" + r.outcome)}`) : "") : "",
        r.state === "open" && can.answer(this.access) ? h("div", null, answer,
          h("div", { class: "actions wrap" },
            h("select", { onchange: (e: Event) => { outcome = (e.target as HTMLSelectElement).value as Rfi["outcome"]; } },
              (["none", "order", "revision"] as const).map((o) => h("option", { value: o }, t("out_" + o)))),
            h("button", { class: "primary", onclick: () => { if (!answer.value.trim()) return; this.run(t("saving"), async () => { await answerRfi(this.ctx, r.id, answer.value, outcome); }); } }, t("rfiAnswerBtn")))) : "",
        r.state !== "closed" && this.canEdit ? h("div", { class: "actions" },
          h("button", { onclick: () => this.run(t("saving"), async () => { await closeRfi(this.ctx, r.id); }) }, t("rfiClose")),
          !r.todoId ? h("button", { onclick: () => this.run(t("saving"), async () => { const w = await ensureRfiTodo(this.ctx, r.id, this.labelOf); if (w) this.error = w; else this.toast("ToDo ✓"); }) }, t("rfiMakeTodo")) : "") : ""));
  }

  rfiFormPanel() {
    const f = this.rfiForm!;
    const set = (k: "title" | "question" | "location" | "due" | "assignee") => (e: Event) => { (f as any)[k] = (e.target as HTMLInputElement).value; };
    const pick = h("div", { class: "picker small" });
    const draw = () => {
      const q = f.filter.toLowerCase();
      const docs = this.reg.docs.filter((d) => f.docs.has(d.key) || (q && `${d.label} ${d.title}`.toLowerCase().includes(q))).slice(0, 40);
      clear(pick, h("table", null, h("tbody", null, docs.map((d) => h("tr", { class: "row" + (f.docs.has(d.key) ? " sel" : ""), onclick: () => { f.docs.has(d.key) ? f.docs.delete(d.key) : f.docs.add(d.key); draw(); } },
        h("td", { class: "cb" }, h("input", { type: "checkbox", checked: f.docs.has(d.key) })), h("td", { class: "key" }, d.label), h("td", { class: "num" }, d.current.revLabel))))));
    };
    draw();
    return h("div", { class: "panel" },
      h("h2", null, t("newRfi")),
      h("div", { class: "form" },
        h("label", null, t("title")), h("input", { value: f.title, oninput: set("title") }),
        h("label", null, t("rfiQuestion")), h("textarea", { rows: 4, oninput: set("question") }, f.question),
        h("label", null, t("rfiDocs")), h("div", null, h("input", { type: "search", placeholder: t("search"), value: f.filter, oninput: (e: Event) => { f.filter = (e.target as HTMLInputElement).value; draw(); } }), pick),
        h("label", null, t("rfiLocation")), h("input", { value: f.location, oninput: set("location") }),
        h("label", null, t("rfiAssignee")), this.assigneeSelect(f.assignee, (v) => { f.assignee = v; }),
        h("label", null, t("rfiDue")), h("input", { type: "date", value: f.due, oninput: set("due") })),
      h("div", { class: "actions" },
        h("button", { class: "primary", onclick: () => this.saveRfi() }, t("create")),
        h("button", { onclick: () => { this.rfiForm = null; this.render(); } }, t("cancel"))));
  }

  assigneeSelect(value: string, onChange: (v: string) => void) {
    const all = this.assignees();
    return h("select", { onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value) },
      h("option", { value: "" }, t("nobody")),
      h("optgroup", { label: "Групи / Groups" }, all.filter((a) => a.type === "GROUP").map((a) => h("option", { value: `GROUP:${a.id}`, selected: value === `GROUP:${a.id}` }, a.name))),
      h("optgroup", { label: "Хора / People" }, all.filter((a) => a.type === "USER").map((a) => h("option", { value: `USER:${a.id}`, selected: value === `USER:${a.id}` }, a.name))));
  }
  parseAssignee(v: string): Assignee | undefined {
    if (!v) return undefined;
    const [type, id] = v.split(":");
    return this.assignees().find((a) => a.type === type && a.id === id);
  }

  async saveRfi() {
    const f = this.rfiForm!;
    if (!f.title.trim() || !f.question.trim()) { alert(`${t("title")} / ${t("rfiQuestion")}?`); return; }
    await this.run(t("saving"), async () => {
      const { rfi, warning } = await createRfi(this.ctx, { title: f.title, question: f.question, docs: [...f.docs], location: f.location, due: f.due || undefined, assignee: this.parseAssignee(f.assignee) }, this.labelOf);
      this.rfiForm = null;
      this.rfiOpen = rfi.id;
      if (warning) this.error = warning;
      this.toast(rfi.id);
    });
  }

  // ---------------- Настройки
  // ---------------- expected drawing list
  expectedRows() {
    return matchExpected(this.store.tracker.expected ?? [], this.reg.docs, (d) => !!this.store.tracker.site[d.key] || d.status === "construction", today());
  }

  viewExpected(body: HTMLElement, exp: ReturnType<App["expectedRows"]>) {
    if (this.expImport) { body.append(this.expImportPanel()); return; }
    const states: ExpState[] = ["late", "missing", "received", "onsite"];
    body.append(h("p", { class: "soft" }, t("expHelp")));
    body.append(h("div", { class: "toolbar" },
      h("div", { class: "chips small" },
        h("button", { class: "chip" + (!this.expFilter ? " on" : ""), onclick: () => { this.expFilter = ""; this.render(); } }, `${t("all")} · ${exp.rows.length}`),
        states.map((st) => {
          const n = exp.rows.filter((r) => r.state === st).length;
          return n ? h("button", { class: `chip exp-${st}` + (this.expFilter === st ? " on" : ""), onclick: () => { this.expFilter = this.expFilter === st ? "" : st; this.render(); } }, `${t("exp_" + st)} · ${n}`) : "";
        })),
      h("span", { class: "grow" }),
      this.canEdit ? h("button", { onclick: () => { this.expImport = { text: "" }; this.render(); } }, "⇪ " + t("expImport")) : "",
      this.canEdit && exp.rows.length ? h("button", { class: "link", onclick: () => {
        if (!confirm(t("expClearConfirm"))) return;
        this.run(t("saving"), async () => { await this.store.save((x) => ({ ...x, expected: [] })); });
      } }, t("expClear")) : ""));
    if (!exp.rows.length) { body.append(h("div", { class: "empty" }, t("expEmpty"))); return; }
    const list = exp.rows.filter((r) => !this.expFilter || r.state === this.expFilter);
    body.append(h("div", { class: "tablewrap" }, h("table", null,
      h("thead", null, h("tr", null, h("th", null, t("number")), h("th", { class: "hide-sm" }, t("title")), h("th", null, t("part")), h("th", null, t("planned")), h("th", null, t("status")), h("th", null, t("rev")))),
      h("tbody", null, list.map((r) => h("tr", { class: r.doc ? "row" : "", onclick: () => { if (r.doc) this.openDoc(r.doc.key); } },
        h("td", { class: "key" }, r.e.number),
        h("td", { class: "title hide-sm" }, r.e.title ?? r.doc?.title ?? "", r.e.note ? h("div", { class: "muted" }, r.e.note) : ""),
        h("td", null, r.e.part ?? ""),
        h("td", { class: "date" + (r.state === "late" ? " overdue" : "") }, bgDate(r.e.planned)),
        h("td", null, h("span", { class: `exp exp-${r.state}` }, t("exp_" + r.state))),
        h("td", { class: "num" }, r.doc ? r.doc.current.revLabel : "")))))));
    if (exp.extra.length)
      body.append(h("details", { class: "unnum" }, h("summary", null, `${t("expExtra")} (${exp.extra.length})`),
        h("div", { class: "tablewrap" }, h("table", null, h("tbody", null, exp.extra.map((d) => h("tr", { class: "row", onclick: () => this.openDoc(d.key) },
          h("td", { class: "key" }, d.label), h("td", { class: "num" }, d.current.revLabel), h("td", { class: "soft hide-sm" }, d.title))))))));
  }

  expImportPanel() {
    const s = this.expImport!;
    const preview = h("div");
    const show = () => {
      s.parsed = s.text.trim() ? parseExpected(s.text) : undefined;
      const p = s.parsed;
      clear(preview, p ? h("div", null,
        h("p", null, h("b", null, `${t("expPreview")}: ${p.rows.length}`), p.skipped ? h("span", { class: "muted" }, ` · ${p.skipped} ${t("expSkipped")}`) : ""),
        h("div", { class: "tablewrap scroll" }, h("table", null, h("tbody", null, p.rows.slice(0, 200).map((e) => h("tr", null,
          h("td", { class: "key" }, e.number), h("td", null, e.title ?? ""), h("td", null, e.part ?? ""), h("td", { class: "date" }, bgDate(e.planned)))))))) : "");
    };
    const ta = h("textarea", { rows: 8, style: "width:100%", class: "mono", placeholder: "Номер\tНаименование\tЧаст\tСрок", oninput: (e: Event) => { s.text = (e.target as HTMLTextAreaElement).value; show(); } }, s.text);
    const file = h("input", { type: "file", accept: ".csv,.txt,.tsv", onchange: async (e: Event) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (!f) return;
      s.text = await f.text();
      (ta as HTMLTextAreaElement).value = s.text;
      show();
    } });
    show();
    return h("div", { class: "panel" },
      h("h2", null, t("expImport")),
      h("p", { class: "soft" }, t("expPasteHelp")),
      ta, h("div", { style: "margin:6px 0" }, file),
      preview,
      h("div", { class: "actions" },
        h("button", { class: "primary", onclick: () => {
          const rows = s.parsed?.rows ?? [];
          if (!rows.length) return;
          this.run(t("saving"), async () => {
            await this.store.save((x) => ({ ...x, expected: mergeExpected(x.expected ?? [], rows) }));
            this.expImport = null;
            this.toast(`${t("saved")} (${rows.length})`);
          });
        } }, t("save")),
        h("button", { onclick: () => { this.expImport = null; this.render(); } }, t("cancel"))));
  }

  // ---------------- go-live check, test data
  goLivePanel() {
    const box = h("div");
    const draw = () => clear(box, this.checks ? h("ul", { class: "checks" }, this.checks.map((c) => h("li", { class: `ck ck-${c.level}` },
      h("span", { class: "ckmark" }, { ok: "✓", warn: "!", error: "✗", info: "i" }[c.level]), " ", c.text, c.hint ? h("div", { class: "muted" }, c.hint) : ""))) : "");
    draw();
    return h("div", { class: "panel" },
      h("h2", null, t("goLive")),
      h("button", { onclick: async () => {
        const groups = this.groups.length ? this.groups : await this.host.api.groups().catch(() => [] as GroupRef[]);
        const site = sitePath(this.store.tracker.settings.siteFolder).join(" / ");
        this.checks = goLiveChecks({
          tracker: this.store.tracker, reg: this.reg, items: this.items, trackerExists: !!this.store.fileId, canEdit: this.canEdit,
          groupIds: new Set(groups.map((g) => g.id)), userIds: new Set(this.users.map((u) => u.id)), projectCode: this.projectCode(),
          siteFolderExists: [...this.reg.folders.keys()].some((id) => folderPathOf(id, this.reg.folders) === site),
        });
        const test = findTestData(this.store.tracker, this.reg);
        if (test.keys.size + test.transmittals.length + test.rfis.length)
          this.checks.push({ level: "warn", text: `${t("testData")}: ${test.keys.size} ${t("testDocs").toLowerCase()}, ${test.transmittals.length} ${t("transmittals").toLowerCase()}, ${test.rfis.length} RFI.`, hint: "↓ " + t("testRemove") });
        draw();
      } }, t("goLiveRun")), box);
  }

  testDataPanel() {
    const test = findTestData(this.store.tracker, this.reg);
    if (!test.keys.size && !test.transmittals.length && !test.rfis.length)
      return h("div", { class: "panel" }, h("h2", null, t("testData")), h("div", { class: "muted" }, t("testNone")));
    if (!this.cleanSel) this.cleanSel = { keys: new Set(test.keys), tr: new Set(test.transmittals.map((x) => x.id)), rfi: new Set(test.rfis.map((x) => x.id)) };
    const sel = this.cleanSel;
    const cb = (set: Set<string>, id: string, label: string) => h("label", { class: "check", style: "display:block" },
      h("input", { type: "checkbox", checked: set.has(id), onchange: (e: Event) => { (e.target as HTMLInputElement).checked ? set.add(id) : set.delete(id); } }), " ", label);
    return h("div", { class: "panel" },
      h("h2", null, t("testData")),
      h("p", { class: "soft" }, t("testDataHelp")),
      test.transmittals.length ? h("div", null, h("b", null, t("transmittals")), test.transmittals.map((x) => cb(sel.tr, x.id, `${x.id} · ${bgDate(x.date)} · ${x.items.map((i) => i.label ?? this.labelOf(i.key)).join(", ")}`))) : "",
      test.rfis.length ? h("div", null, h("b", null, "RFI"), test.rfis.map((r) => cb(sel.rfi, r.id, `${r.id} · ${r.title}`))) : "",
      test.keys.size ? h("div", null, h("b", null, t("testDocs")), [...test.keys].map((k) => cb(sel.keys, k, this.labelOf(k)))) : "",
      h("div", { class: "actions" }, h("button", { class: "danger", onclick: () => this.removeTest() }, t("testRemove"))));
  }

  async removeTest() {
    const sel = this.cleanSel;
    if (!sel || (!sel.keys.size && !sel.tr.size && !sel.rfi.size)) return;
    if (!confirm(t("testConfirm"))) return;
    await this.run(t("saving"), async () => {
      const pdfs = this.store.tracker.transmittals.filter((x) => sel.tr.has(x.id) && x.pdfFileId).map((x) => x.pdfFileId!);
      await this.store.save((x) => removeTestData(x, sel.keys, sel.tr, sel.rfi));
      if (pdfs.length) {
        const parent = this.items.find((i) => i.id === pdfs[0])?.pid;
        if (parent) {
          let sub = this.items.find((i) => i.tp === "FOLDER" && i.nm === "Тест" && i.pid === parent && !i.del)?.id;
          try { if (!sub) sub = await this.host.api.createFolder("Тест", parent); } catch { /* keep in place */ }
          if (sub) for (const id of pdfs) { try { await this.host.api.moveFile(id, sub); } catch { /* already moved or name exists */ } }
        }
      }
      await this.reloadFiles();
      this.cleanSel = null;
      this.checks = null;
      this.toast(t("testRemoved"));
    });
  }

  viewSettings(body: HTMLElement) {
    const st = this.store.tracker.settings;
    const v = {
      pattern: st.pattern || DEFAULT_PATTERN, trackExts: st.trackExts ?? "", projectCode: st.projectCode ?? "", siteFolder: st.siteFolder ?? DEFAULT_SITE_FOLDER,
      ack: st.ackAssignee ? `${st.ackAssignee.type}:${st.ackAssignee.id}` : "", rfi: st.rfiAssignee ? `${st.rfiAssignee.type}:${st.rfiAssignee.id}` : "",
    };
    const testOut = h("div", { class: "mono soft", style: "font-size:12px" });
    let testName = "1028-ST-DR-0101_R02_Фундаменти.pdf";
    const runTest = () => {
      try {
        const p = parseName(testName, compilePattern(v.pattern));
        testOut.textContent = p ? `key=${p.key}  disc=${p.disc}  type=${p.type}  rev=${p.revLabel}  title="${p.title}"` : "— no match —";
      } catch (e: any) { testOut.textContent = `invalid pattern: ${e.message}`; }
    };
    runTest();
    const diag = h("div");
    const inp = (k: keyof typeof v, extra: Record<string, any> = {}) => h("input", { value: v[k], oninput: (e: Event) => { (v as any)[k] = (e.target as HTMLInputElement).value; if (k === "pattern") runTest(); }, ...extra });
    const editable = this.canEdit;
    body.append(h("div", { class: "panel" },
      h("h2", null, t("settings")),
      h("div", { class: "metagrid" }, h("span", null, t("role")), h("b", null, (this.access.roles.length ? this.access.roles : ["none"]).map((r) => t("role_" + r)).join(", "), this.access.groups.length ? ` (${this.access.groups.join(", ")})` : "")),
      h("div", { class: "form" },
        h("label", null, t("siteFolder")), h("div", null, inp("siteFolder", { style: "width:100%" }), h("div", { class: "muted small" }, t("siteFolderHelp"))),
        h("label", null, t("ackAssignee")), this.assigneeSelect(v.ack, (x) => { v.ack = x; }),
        h("label", null, t("rfiAssigneeSet")), this.assigneeSelect(v.rfi, (x) => { v.rfi = x; }),
        h("label", null, t("trackExts")), h("div", null, inp("trackExts", { placeholder: "pdf" }), h("div", { class: "muted small" }, t("trackExtsHelp"))),
        h("label", null, t("pattern")), h("div", null, inp("pattern", { style: "width:100%", class: "mono" }), h("div", { class: "muted small" }, t("patternHelp"))),
        h("label", null, t("testName")), h("div", null, h("input", { value: testName, style: "width:100%", oninput: (e: Event) => { testName = (e.target as HTMLInputElement).value; runTest(); } }), testOut),
        h("label", null, t("projectCode")), inp("projectCode", { placeholder: this.projectCode() }),
        h("label", null, t("trackerFile")), h("div", { class: "soft" }, this.store.fileId
          ? h("span", null, `${this.items.find((i) => i.id === this.store.folderId)?.nm ?? TRACKER_FOLDER}/tracker.json · ${this.store.versionId ?? ""} `, h("button", { class: "link", onclick: () => this.openFile(this.store.fileId!) }, t("download")))
          : t("notCreated"))),
      editable ? h("div", { class: "actions" }, h("button", { class: "primary", onclick: async () => {
        try { compilePattern(v.pattern); } catch { alert("Invalid pattern"); return; }
        await this.run(t("saving"), async () => {
          await this.store.save((tr) => ({ ...tr, settings: { ...tr.settings, pattern: v.pattern, trackExts: v.trackExts.trim(), projectCode: v.projectCode.trim() || undefined,
            siteFolder: v.siteFolder.trim() || DEFAULT_SITE_FOLDER, ackAssignee: this.parseAssignee(v.ack), rfiAssignee: this.parseAssignee(v.rfi) } }));
          this.rebuild();
          this.toast(t("saved"));
        });
      } }, t("save"))) : ""),
      this.goLivePanel(),
      this.canEdit ? this.testDataPanel() : "",
      h("div", { class: "panel" },
        h("h2", null, t("diagnostics")),
        h("div", { class: "soft", style: "margin-bottom:8px" }, `mode: ${this.host.api.mode} · project ${this.host.projectId} · ${this.host.user.name}`),
        h("button", { onclick: async () => {
          clear(diag, h("div", { class: "muted" }, t("loading")));
          const res = await this.host.api.probe();
          clear(diag, h("table", null, h("tbody", null, res.map((r) => h("tr", null,
            h("td", null, r.ok ? "✓" : "✗"), h("td", null, r.name), h("td", { class: r.ok ? "soft" : "overdue" }, r.status), h("td", { class: "date" }, `${r.ms} ms`))))));
        } }, t("runDiagnostics")),
        this.host.api.bcfTest && this.canEdit ? h("button", { style: "margin-left:8px", onclick: async () => {
          if (!confirm("BCF проба: ще създам тестова тема в проекта, ще добавя коментар и изглед и ще я затворя. Продължаване?")) return;
          clear(diag, h("div", { class: "muted" }, t("loading")));
          const res = await this.host.api.bcfTest!();
          clear(diag, h("table", null, h("tbody", null, res.map((r) => h("tr", null,
            h("td", null, r.ok ? "✓" : "✗"), h("td", null, r.name), h("td", { class: r.ok ? "soft mono" : "overdue", style: "font-size:11px;word-break:break-all" }, r.status), h("td", { class: "date" }, `${r.ms} ms`))))));
        } }, "BCF проба") : "", diag));
  }
}

void ALL_STATUSES;
new App().start();
