import { describe, expect, it } from "vitest";
import { parseName } from "./naming";
import {
  addAck, addTransmittal, buildRegister, canIssue, emptyTracker, nextRfiId, nextTransmittalId, normalizeTracker, setMeta, setStatus,
  type SnapshotItem, type Tracker,
} from "./model";

const A = { name: "N", id: "u1" };

describe("parseName", () => {
  it("parses the Arsten pattern", () => {
    expect(parseName("1018-ST-DR-0101_R02_Фундаменти.pdf")).toMatchObject({ key: "1018-ST-DR-0101", disc: "ST", rev: 2, revLabel: "R02", title: "Фундаменти" });
  });
  it("rejects other names", () => {
    expect(parseName("FP1.pdf")).toBeNull();
  });
});

const items: SnapshotItem[] = [
  { id: "F1", nm: "02 ST", tp: "FOLDER", pid: "root" },
  { id: "A", nm: "1018-ST-DR-0101_R01_Фундаменти.pdf", tp: "FILE", pid: "F1", vid: "a1", mt: "2026-10-01" },
  { id: "B", nm: "1018-ST-DR-0101_R02_Фундаменти.pdf", tp: "FILE", pid: "F1", vid: "b1", mt: "2026-10-10" },
  { id: "C", nm: "1018-ST-DR-0101_R03.pdf", tp: "FILE", pid: "F1", vid: "c1", mt: "2026-10-20" },
  { id: "E", nm: "notes.txt", tp: "FILE", pid: "F1" },
  { id: "X", nm: "_ArstenDocs", tp: "FOLDER", pid: "root" },
  { id: "T", nm: "tracker.json", tp: "FILE", pid: "X" },
  { id: "S", nm: "ЗА СТРОИТЕЛСТВО", tp: "FOLDER", pid: "root" },
  { id: "S1", nm: "ST", tp: "FOLDER", pid: "S" },
  { id: "SC", nm: "1018-ST-DR-0101 R02.pdf", tp: "FILE", pid: "S1" },
  { id: "R", nm: "30_REINFORCEMENT PLANS", tp: "FOLDER", pid: "root" },
  { id: "P1", nm: "FP1.pdf", tp: "FILE", pid: "R", vid: "p1v3", rv: 3 },
];

describe("buildRegister", () => {
  it("groups revisions, skips tracker and site folders", () => {
    const r = buildRegister(items, emptyTracker(), new Map());
    expect(r.docs.map((d) => d.key)).toEqual(["1018-ST-DR-0101", "f:P1"]);
    expect(r.docs[0].revs.map((x) => x.revLabel)).toEqual(["R01", "R02", "R03"]);
    expect(r.docs[0].status).toBe("received");
    expect(r.unnumbered.map((u) => u.name)).toEqual(["notes.txt"]);
    expect(r.trackerFileId).toBe("T");
    expect([...r.siteFolderIds].sort()).toEqual(["S", "S1"]);
  });

  it("an issued revision supersedes all lower ones", () => {
    let t: Tracker = emptyTracker();
    t = setStatus(t, "1018-ST-DR-0101", "R01", "construction", "received", A);
    t = setStatus(t, "1018-ST-DR-0101", "R02", "construction", "received", A);
    const d = buildRegister(items, t, new Map()).docs[0];
    expect(d.revs.map((x) => x.status)).toEqual(["superseded", "construction", "received"]);
  });

  it("uses meta for kind, number, part and default status", () => {
    let t = setMeta(emptyTracker(), "f:P1", { kind: "submittal", number: "M-01", part: "Стомана" });
    const d = buildRegister(items, t, new Map()).docs.find((x) => x.key === "f:P1")!;
    expect(d).toMatchObject({ kind: "submittal", label: "M-01", disc: "Стомана", status: "submitted" });
    t = setMeta(t, "f:P1", { number: "" });
    expect(buildRegister(items, t, new Map()).docs.find((x) => x.key === "f:P1")!.label).toBe("FP1");
  });

  it("file documents: revision = Connect version; a new upload starts again as received", () => {
    let t = setStatus(emptyTracker(), "f:P1", "v3", "construction", "received", A);
    expect(buildRegister(items, t, new Map()).docs.find((d) => d.key === "f:P1")!.status).toBe("construction");
    const v4 = items.map((x) => (x.id === "P1" ? { ...x, rv: 4 } : x));
    expect(buildRegister(v4, t, new Map()).docs.find((d) => d.key === "f:P1")!.status).toBe("received");
  });
});

describe("migration from tracker.json v1", () => {
  it("maps old statuses", () => {
    const t = normalizeTracker({ status: { "f:X@v3": "For approval", "k@R01": "Issued" }, log: [{ key: "f:X", rev: "v3", from: "Draft", to: "For approval", at: "", by: "" }] });
    expect(t.schema).toBe(2);
    expect(t.status).toEqual({ "f:X@v3": "review", "k@R01": "construction" });
    expect(t.log[0]).toMatchObject({ from: "received", to: "review" });
    expect(t.rfis).toEqual([]);
    expect(t.settings.siteFolder).toBe("ЗА СТРОИТЕЛСТВО");
  });
});

describe("transmittals, acks, numbering", () => {
  it("numbers per project code", () => {
    let t = emptyTracker();
    expect(nextTransmittalId(t, "1028")).toBe("TR-1028-001");
    expect(nextRfiId(t, "1028")).toBe("RFI-1028-001");
    t = addTransmittal(t, {
      id: "TR-1028-001", date: "2026-11-05", to: "Обект", purpose: "For construction", by: "N", createdAt: "2026-11-05T10:00:00Z",
      items: [{ key: "k", rev: "R03", name: "x", fileId: "C" }],
    }, () => "received", A);
    expect(t.status["k@R03"]).toBe("construction");
    expect(nextTransmittalId(t, "1028")).toBe("TR-1028-002");
    // an issued revision is not downgraded by a later "for information" transmittal
    const t2 = addTransmittal(t, { ...t.transmittals[0], id: "TR-1028-002", purpose: "For information" }, () => "construction", A);
    expect(t2.status["k@R03"]).toBe("construction");
    expect(t2.log).toHaveLength(1);
  });
  it("one acknowledgement per person", () => {
    let t = addAck(emptyTracker(), "k", "R01", { by: "N", byId: "u1", at: "x", via: "app" });
    t = addAck(t, "k", "R01", { by: "N", byId: "u1", at: "y", via: "app" });
    expect(t.acks["k@R01"]).toHaveLength(1);
  });
  it("canIssue only for received design or approved shop drawings", () => {
    const base = buildRegister(items, emptyTracker(), new Map()).docs[0];
    expect(canIssue(base)).toBe(true);
    expect(canIssue({ ...base, status: "construction" })).toBe(false);
    expect(canIssue({ ...base, kind: "submittal", status: "C" })).toBe(false);
    expect(canIssue({ ...base, kind: "submittal", status: "B" })).toBe(true);
    expect(canIssue({ ...base, kind: "record", status: "draft" })).toBe(false);
  });
});
