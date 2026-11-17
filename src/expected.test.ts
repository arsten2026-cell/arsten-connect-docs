import { describe, expect, it } from "vitest";
import { matchExpected, mergeExpected, normNumber, parseDate, parseExpected } from "./expected";
import { findTestData, goLiveChecks, removeTestData } from "./golive";
import { buildRegister, emptyTracker, setStatus, type SnapshotItem, type Tracker } from "./model";

describe("expected drawing list", () => {
  it("normalises numbers and strips the revision", () => {
    expect(normNumber("1028-ST-DR-0101_R02")).toBe(normNumber("1028 ST DR 0101"));
    expect(normNumber("1028-ST-DR-0101 rev 3")).toBe("1028STDR0101");
    expect(normNumber("DR01")).toBe("DR01");
  });
  it("parses dates", () => {
    expect(parseDate("05.12.2026")).toBe("2026-12-05");
    expect(parseDate("5/1/27")).toBe("2027-01-05");
    expect(parseDate("2026-12-05")).toBe("2026-12-05");
    expect(parseDate("утре")).toBeUndefined();
  });
  it("reads an Excel paste with a header in any column order", () => {
    const r = parseExpected("Част\tНомер\tНаименование\tСрок\nК\t1028-ST-DR-0101\tФундаменти\t01.12.2026\nК\t1028-ST-DR-0102\tКолони\t\n\t\t\t\nК\t1028-ST-DR-0101\tдубликат\t");
    expect(r.header).toBe(true);
    expect(r.rows).toEqual([
      { number: "1028-ST-DR-0101", title: "Фундаменти", part: "К", planned: "2026-12-01" },
      { number: "1028-ST-DR-0102", title: "Колони", part: "К" },
    ]);
    expect(r.skipped).toBe(1);
  });
  it("reads CSV without a header (number, title, part, date)", () => {
    const r = parseExpected('A-01;"План; партер";АР;10.01.2027\r\nA-02;Разрез;АР;');
    expect(r.rows.map((x) => [x.number, x.title, x.planned])).toEqual([["A-01", "План; партер", "2027-01-10"], ["A-02", "Разрез", undefined]]);
  });
  it("merges by number", () => {
    expect(mergeExpected([{ number: "A-01", title: "x" }, { number: "A-02" }], [{ number: "a 01", planned: "2027-01-01" }]))
      .toEqual([{ number: "a 01", title: "x", planned: "2027-01-01" }, { number: "A-02" }]);
  });
  it("matches to the register and gives each row a state", () => {
    const items: SnapshotItem[] = [
      { id: "F", nm: "К", tp: "FOLDER", pid: "root" },
      { id: "A", nm: "1028-ST-DR-0101_R02_Фундаменти.pdf", tp: "FILE", pid: "F" },
      { id: "B", nm: "1028-ST-DR-0102_R01.pdf", tp: "FILE", pid: "F" },
      { id: "C", nm: "1028-ST-DR-0199_R01.pdf", tp: "FILE", pid: "F" },
    ];
    const docs = buildRegister(items, setStatus(emptyTracker(), "1028-ST-DR-0101", "R02", "construction", "received", { name: "N" }), new Map()).docs;
    const { rows, extra } = matchExpected(
      [{ number: "1028-ST-DR-0101" }, { number: "1028-ST-DR-0102" }, { number: "1028-ST-DR-0103", planned: "2026-11-01" }, { number: "1028-ST-DR-0104", planned: "2027-01-01" }],
      docs, (d) => d.status === "construction", "2026-11-17");
    expect(rows.map((r) => r.state)).toEqual(["onsite", "received", "late", "missing"]);
    expect(extra.map((d) => d.key)).toEqual(["1028-ST-DR-0199"]);
  });
});

describe("go-live check and test data", () => {
  const items: SnapshotItem[] = [
    { id: "T", nm: "ZZ_TEST_Документи", tp: "FOLDER", pid: "root" },
    { id: "t1", nm: "ZZ-TEST FP101.pdf", tp: "FILE", pid: "T", rv: 1 },
    { id: "R", nm: "03_DESIGN", tp: "FOLDER", pid: "root" },
    { id: "r1", nm: "1028-ST-DR-0101_R01.pdf", tp: "FILE", pid: "R" },
    { id: "r2", nm: "1028-ST-DR-9001_R02_ТЕСТ кофраж.pdf", tp: "FILE", pid: "R" },
  ];
  const base = (): Tracker => {
    let t = emptyTracker();
    t = setStatus(t, "f:t1", "v1", "construction", "received", { name: "N" });
    t = setStatus(t, "1028-ST-DR-0101", "R01", "review", "received", { name: "N" });
    t.site["f:t1"] = { fileId: "x", rev: "v1", folderId: "S", name: "FP101 v1.pdf", at: "" };
    t.transmittals = [
      { id: "TR-1028-001", date: "", to: "Обект", purpose: "For construction", by: "N", createdAt: "", items: [{ key: "f:t1", rev: "v1", name: "ZZ-TEST FP101.pdf", fileId: "t1" }] },
      { id: "TR-1028-002", date: "", to: "Обект", purpose: "For construction", by: "N", createdAt: "", items: [{ key: "1028-ST-DR-0101", rev: "R01", name: "1028-ST-DR-0101_R01.pdf", fileId: "r1" }] },
    ];
    t.rfis = [{ id: "RFI-1028-001", title: "ТЕСТ: отвор", question: "?", docs: [], askedBy: "N", askedAt: "", state: "open" }];
    t.acks["f:t1@v1"] = [{ by: "N", at: "", via: "app" }];
    t.settings.siteFolder = "ZZ_TEST_Документи/ЗА СТРОИТЕЛСТВО";
    return t;
  };
  it("finds test documents, transmittals and RFIs, not real ones", () => {
    const t = base();
    const d = findTestData(t, buildRegister(items, t, new Map()));
    expect([...d.keys].sort()).toEqual(["1028-ST-DR-9001", "f:t1"]);
    expect(d.transmittals.map((x) => x.id)).toEqual(["TR-1028-001"]);
    expect(d.rfis.map((x) => x.id)).toEqual(["RFI-1028-001"]);
  });
  it("removes only the chosen test data", () => {
    const t = removeTestData(base(), new Set(["f:t1"]), new Set(["TR-1028-001"]), new Set(["RFI-1028-001"]));
    expect(Object.keys(t.status)).toEqual(["1028-ST-DR-0101@R01"]);
    expect(t.site).toEqual({});
    expect(t.acks).toEqual({});
    expect(t.transmittals.map((x) => x.id)).toEqual(["TR-1028-002"]);
    expect(t.rfis).toEqual([]);
    expect(t.log.every((l) => l.key !== "f:t1")).toBe(true);
  });
  it("flags a test site folder and missing assignees", () => {
    const t = base();
    const c = goLiveChecks({ tracker: t, reg: buildRegister(items, t, new Map()), items, trackerExists: true, canEdit: true, groupIds: new Set(), userIds: new Set(), projectCode: "1028", siteFolderExists: true });
    expect(c.find((x) => x.text.includes("тестова"))?.level).toBe("error");
    expect(c.filter((x) => x.text.includes("не е зададено"))).toHaveLength(2);
    expect(c.find((x) => x.text.includes("без копие"))).toBeUndefined();
  });
});
