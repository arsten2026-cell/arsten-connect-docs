import { type DocRow, type Register, type Rfi, type SnapshotItem, type Tracker, type Transmittal } from "./model";

/** Words that mark test data: ZZ_TEST, TEST, ТЕСТ as a separate word in a name, number, folder or note. */
export const TEST_RE = /(^|[^0-9A-Za-zА-Яа-я])(ZZ[_ -]?TEST|TEST|ТЕСТ)([^0-9A-Za-zА-Яа-я]|$)/i;
export const isTestText = (...s: (string | undefined)[]) => s.some((x) => !!x && TEST_RE.test(x));

export const isTestDoc = (d: DocRow) => isTestText(d.label, d.key, d.title, d.current.name, d.current.folderPath, ...d.revs.map((r) => r.folderPath));

export interface TestData {
  keys: Set<string>; // document keys
  transmittals: Transmittal[];
  rfis: Rfi[];
}

/** Test documents (by name/folder), transmittals whose items are all test documents (or marked TEST), RFIs likewise. */
export function findTestData(t: Tracker, reg: Register): TestData {
  const keys = new Set(reg.docs.filter(isTestDoc).map((d) => d.key));
  const testItem = (i: { key: string; label?: string; name: string; title?: string }) => keys.has(i.key) || isTestText(i.label, i.key, i.name, i.title);
  const transmittals = t.transmittals.filter((x) => isTestText(x.note, x.to, x.attn) || (x.items.length > 0 && x.items.every(testItem)));
  for (const x of transmittals) for (const i of x.items) if (testItem(i)) keys.add(i.key);
  const rfis = t.rfis.filter((r) => isTestText(r.title, r.question, r.location) || (r.docs.length > 0 && r.docs.every((k) => keys.has(k))));
  return { keys, transmittals, rfis };
}

/** Removes the chosen test data from the tracker: transmittals, RFIs and everything stored for the test documents. */
export function removeTestData(t: Tracker, keys: Set<string>, trIds: Set<string>, rfiIds: Set<string>): Tracker {
  const keyOf = (id: string) => id.slice(0, id.lastIndexOf("@"));
  const dropRev = <T>(rec: Record<string, T>) => Object.fromEntries(Object.entries(rec).filter(([id]) => !keys.has(keyOf(id))));
  const dropKey = <T>(rec: Record<string, T>) => Object.fromEntries(Object.entries(rec).filter(([k]) => !keys.has(k)));
  return {
    ...t,
    status: dropRev(t.status),
    acks: dropRev(t.acks),
    meta: dropKey(t.meta),
    site: dropKey(t.site),
    log: t.log.filter((l) => !keys.has(l.key) && !(l.transmittal && trIds.has(l.transmittal))),
    transmittals: t.transmittals.filter((x) => !trIds.has(x.id)),
    rfis: t.rfis.filter((r) => !rfiIds.has(r.id)),
    packages: t.packages.map((p) => ({ ...p, items: p.items.filter((id) => !keys.has(keyOf(id))) })).filter((p) => p.items.length),
  };
}

export type CheckLevel = "ok" | "warn" | "error" | "info";
export interface Check { level: CheckLevel; text: string; hint?: string }

export interface CheckInput {
  tracker: Tracker;
  reg: Register;
  items: SnapshotItem[];
  trackerExists: boolean;
  canEdit: boolean;
  groupIds: Set<string>;
  userIds: Set<string>;
  projectCode: string;
  siteFolderExists: boolean;
}

/** "Проверка преди старт": settings and data a real project needs. Texts are Bulgarian (the working language). */
export function goLiveChecks(x: CheckInput): Check[] {
  const s = x.tracker.settings;
  const out: Check[] = [];
  const site = s.siteFolder || "ЗА СТРОИТЕЛСТВО";
  out.push(x.canEdit ? { level: "ok", text: "Можете да издавате и променяте документи." } : { level: "error", text: "Нямате права за промени (нужна е група 00_ADMIN, 02 или 02.1)." });
  if (isTestText(site)) out.push({ level: "error", text: `Папката за обекта е тестова: „${site}“.`, hint: "Сменете я на „ЗА СТРОИТЕЛСТВО“ по-долу и запишете." });
  else out.push(x.siteFolderExists ? { level: "ok", text: `Папка за обекта: „${site}“.` } : { level: "info", text: `Папка за обекта: „${site}“ – ще бъде създадена при първото издаване.` });
  const who = (a: Tracker["settings"]["ackAssignee"], label: string, hint: string): Check => {
    if (!a) return { level: "warn", text: `${label}: не е зададено.`, hint };
    const exists = a.type === "GROUP" ? x.groupIds.has(a.id) : x.userIds.has(a.id);
    if (!exists) return { level: "error", text: `${label}: „${a.name}“ вече не е в проекта.`, hint };
    if (a.type === "USER") return { level: "warn", text: `${label}: един човек (${a.name}).`, hint: "По-добре група – задачата стига до всички в нея." };
    return { level: "ok", text: `${label}: ${a.name}.` };
  };
  out.push(who(s.ackAssignee, "Потвърждение на получаване", "Изберете групата на обекта, напр. 02.GENERAL CONTRACTOR."));
  out.push(who(s.rfiAssignee, "Въпроси и работни чертежи", "Изберете 4.1-STRUCTURAL DESIGNER или 04.DESIGNERS."));
  out.push(s.projectCode ? { level: "ok", text: `Код на проекта: ${s.projectCode} (номерата са TR-${s.projectCode}-…).` }
    : { level: "info", text: `Код на проекта: ${x.projectCode} (от имената на файловете).`, hint: "Задайте го изрично, ако имената на файловете са различни." });
  const design = x.reg.docs.filter((d) => d.kind === "design");
  out.push(design.length ? { level: "ok", text: `Проектни документи в регистъра: ${design.length}.` } : { level: "warn", text: "Още няма проектни документи в регистъра.", hint: "Качете получените файлове (Регистър → Качи получени файлове)." });
  if (x.reg.unnumbered.length) out.push({ level: "info", text: `${x.reg.unnumbered.length} файла не са PDF/следени типове или не отговарят на шаблона.` });
  const noCopy = x.reg.docs.filter((d) => d.status === "construction" && !x.tracker.site[d.key]);
  if (noCopy.length) out.push({ level: "warn", text: `${noCopy.length} документа са „За изпълнение“ без копие в папката за обекта: ${noCopy.slice(0, 5).map((d) => d.label).join(", ")}${noCopy.length > 5 ? "…" : ""}.`, hint: "Издайте ги отново, за да се създаде подпечатаното копие." });
  const stale = Object.entries(x.tracker.site).filter(([, c]) => !x.items.some((i) => i.id === c.fileId && !i.del));
  if (stale.length) out.push({ level: "warn", text: `${stale.length} копия за обекта липсват в Connect (изтрити или преместени).` });
  out.push(x.tracker.expected.length ? { level: "ok", text: `Очакван списък: ${x.tracker.expected.length} документа.` } : { level: "info", text: "Няма зареден очакван списък на чертежите.", hint: "Регистър → Очакван списък → Зареди (по желание)." });
  out.push(x.tracker.transmittals.some((t) => t.purpose === "For construction") ? { level: "ok", text: "Има издадени документи за изпълнение." }
    : { level: "info", text: "Още нищо не е издадено за изпълнение.", hint: "За проект в ход: Регистър → Начален комплект." });
  if (!x.trackerExists) out.push({ level: "info", text: "Файлът с данни (tracker.json) ще бъде създаден при първия запис." });
  return out;
}

