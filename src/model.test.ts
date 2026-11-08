import { describe, expect, it } from "vitest";
import { parseName } from "./naming";
import { addTransmittal, buildRegister, emptyTracker, nextTransmittalId, setStatus, type SnapshotItem, type Tracker } from "./model";

describe("parseName", () => {
  it("parses the Arsten pattern", () => {
    const p = parseName("1018-ST-DR-0101_R02_Фундаменти.pdf")!;
    expect(p).toMatchObject({ key: "1018-ST-DR-0101", disc: "ST", type: "DR", num: "0101", rev: 2, revLabel: "R02", title: "Фундаменти", ext: "pdf" });
  });
  it("is case-insensitive and works without title", () => {
    expect(parseName("1018-st-dr-0101_r3.dwg")).toMatchObject({ key: "1018-ST-DR-0101", rev: 3, revLabel: "R03", title: "" });
  });
  it("rejects other names", () => {
    expect(parseName("model_v5.ifc")).toBeNull();
    expect(parseName("1018-ST-0101_R02.pdf")).toBeNull();
  });
});

const items: SnapshotItem[] = [
  { id: "F1", nm: "02 ST", tp: "FOLDER", pid: "root" },
  { id: "A", nm: "1018-ST-DR-0101_R01_Фундаменти.pdf", tp: "FILE", pid: "F1", vid: "a1", mt: "2026-10-01" },
  { id: "B", nm: "1018-ST-DR-0101_R02_Фундаменти.pdf", tp: "FILE", pid: "F1", vid: "b1", mt: "2026-10-10" },
  { id: "C", nm: "1018-ST-DR-0101_R03.pdf", tp: "FILE", pid: "F1", vid: "c1", mt: "2026-10-20" },
  { id: "D", nm: "1018-AR-DR-0001_R01.pdf", tp: "FILE", pid: "F1", vid: "d1" },
  { id: "E", nm: "notes.txt", tp: "FILE", pid: "F1" },
  { id: "X", nm: "_ArstenDocs", tp: "FOLDER", pid: "root" },
  { id: "T", nm: "tracker.json", tp: "FILE", pid: "X" },
  { id: "Z", nm: "1018-ST-DR-0999_R01.pdf", tp: "FILE", pid: "F1", del: true },
];

describe("buildRegister", () => {
  it("groups revisions, ignores tracker folder and deleted files", () => {
    const r = buildRegister(items, emptyTracker(), new Map());
    expect(r.docs.map((d) => d.key)).toEqual(["1018-AR-DR-0001", "1018-ST-DR-0101"]);
    const st = r.docs[1];
    expect(st.revs.map((x) => x.revLabel)).toEqual(["R01", "R02", "R03"]);
    expect(st.current.fileId).toBe("C");
    expect(st.title).toBe("Фундаменти");
    expect(st.status).toBe("Draft");
    expect(r.unnumbered.map((u) => u.name)).toEqual(["notes.txt"]);
    expect(r.trackerFolderId).toBe("X");
    expect(r.trackerFileId).toBe("T");
    expect(st.current.folderPath).toBe("02 ST");
  });

  it("supersedes revisions below an issued one", () => {
    let t: Tracker = emptyTracker();
    t = setStatus(t, "1018-ST-DR-0101", "R01", "Issued", "Draft", { name: "N" });
    t = setStatus(t, "1018-ST-DR-0101", "R02", "Issued", "Draft", { name: "N" });
    const d = buildRegister(items, t, new Map()).docs[1];
    expect(d.revs.map((x) => x.status)).toEqual(["Superseded", "Issued", "Draft"]);
    expect(t.log).toHaveLength(2);
  });
});

describe("file documents (no numbering, revisions = Connect versions)", () => {
  const files: SnapshotItem[] = [
    { id: "R", nm: "30_REINFORCEMENT PLANS", tp: "FOLDER", pid: "root" },
    { id: "P1", nm: "FP1.pdf", tp: "FILE", pid: "R", vid: "p1v3", rv: 3 },
    { id: "P2", nm: "model.ifc", tp: "FILE", pid: "R", rv: 2 },
    { id: "P3", nm: "1018-ST-DR-0101_R01.pdf", tp: "FILE", pid: "R", rv: 1 },
  ];
  it("tracks PDFs that don't match the pattern", () => {
    let t = emptyTracker();
    const r = buildRegister(files, t, new Map());
    const f = r.docs.find((d) => d.kind === "file")!;
    expect(f).toMatchObject({ key: "f:P1", label: "FP1", disc: "30_REINFORCEMENT PLANS", type: "PDF", status: "Draft" });
    expect(f.current.revLabel).toBe("v3");
    expect(r.docs[0].kind).toBe("numbered");
    expect(r.unnumbered.map((u) => u.name)).toEqual(["model.ifc"]);
    t = setStatus(t, "f:P1", "v3", "Issued", "Draft", { name: "N" });
    expect(buildRegister(files, t, new Map()).docs.find((d) => d.kind === "file")!.status).toBe("Issued");
    // a new upload (v4) starts as Draft again
    const v4 = files.map((x) => (x.id === "P1" ? { ...x, rv: 4 } : x));
    expect(buildRegister(v4, t, new Map()).docs.find((d) => d.kind === "file")!.status).toBe("Draft");
  });
  it("can be switched off", () => {
    const t = { ...emptyTracker(), settings: { pattern: emptyTracker().settings.pattern, trackExts: "" } };
    expect(buildRegister(files, t, new Map()).docs.every((d) => d.kind === "numbered")).toBe(true);
  });
});

describe("transmittals", () => {
  it("numbers sequentially per project code and sets statuses", () => {
    let t = emptyTracker();
    expect(nextTransmittalId(t, "1018")).toBe("TR-1018-001");
    t = addTransmittal(t, {
      id: "TR-1018-001", date: "2026-11-05", to: "Client", purpose: "For approval", by: "N", createdAt: "2026-11-05T10:00:00Z",
      items: [{ key: "1018-ST-DR-0101", rev: "R03", name: "x", fileId: "C" }],
    }, () => "Draft", { name: "N" });
    expect(t.status["1018-ST-DR-0101@R03"]).toBe("For approval");
    expect(t.log[0]).toMatchObject({ transmittal: "TR-1018-001", from: "Draft", to: "For approval" });
    expect(nextTransmittalId(t, "1018")).toBe("TR-1018-002");
    // an Issued revision is not downgraded by a later "for approval" transmittal
    const t2 = addTransmittal(t, { ...t.transmittals[0], id: "TR-1018-002" }, () => "Issued", { name: "N" });
    expect(t2.log).toHaveLength(1);
  });
});
