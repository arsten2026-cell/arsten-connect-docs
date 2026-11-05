/**
 * Arsten document numbering: 1018-ST-DR-0101_R02.pdf
 *   project - discipline - type - number _R revision
 * The pattern can be overridden per project (Settings tab); it must define the named groups
 * proj, disc, type, num, rev.
 */
export const DEFAULT_PATTERN =
  "^(?<proj>\\d{3,5})-(?<disc>[A-Z]{2,4})-(?<type>[A-Z]{2,3})-(?<num>\\d{2,5})_R(?<rev>\\d{1,3})";

export interface ParsedName {
  key: string; // 1018-ST-DR-0101
  proj: string;
  disc: string;
  type: string;
  num: string;
  rev: number; // 2
  revLabel: string; // R02
  title: string; // text after the revision, if any ("Foundation plan")
  ext: string; // pdf
}

export function compilePattern(pattern: string): RegExp {
  return new RegExp(pattern, "i");
}

export function revLabel(rev: number): string {
  return "R" + String(rev).padStart(2, "0");
}

export function parseName(fileName: string, re: RegExp = compilePattern(DEFAULT_PATTERN)): ParsedName | null {
  const m = re.exec(fileName);
  const g = m?.groups;
  if (!m || !g || g.proj == null || g.disc == null || g.type == null || g.num == null || g.rev == null) return null;
  const dot = fileName.lastIndexOf(".");
  const ext = dot > 0 ? fileName.slice(dot + 1).toLowerCase() : "";
  const rest = (dot > 0 ? fileName.slice(0, dot) : fileName).slice(m[0].length);
  const title = rest.replace(/^[\s_\-–.]+/, "").replace(/_/g, " ").trim();
  const proj = g.proj, disc = g.disc.toUpperCase(), type = g.type.toUpperCase(), num = g.num;
  const rev = parseInt(g.rev, 10);
  return {
    key: `${proj}-${disc}-${type}-${num}`,
    proj, disc, type, num, rev,
    revLabel: revLabel(rev),
    title, ext,
  };
}

/** Discipline codes used at Arsten, for labels. Unknown codes are shown as-is. */
export const DISCIPLINES: Record<string, { bg: string; en: string }> = {
  AR: { bg: "Архитектура", en: "Architecture" },
  ST: { bg: "Конструкции", en: "Structural" },
  MEP: { bg: "ОВиК / ВиК / Ел.", en: "MEP" },
  EL: { bg: "Електро", en: "Electrical" },
  HV: { bg: "ОВиК", en: "HVAC" },
  WS: { bg: "ВиК", en: "Water & sewage" },
  FS: { bg: "Пожарна безопасност", en: "Fire safety" },
  GD: { bg: "Геодезия", en: "Geodesy" },
  PB: { bg: "ПБЗ", en: "Health & safety" },
  EE: { bg: "Енергийна ефективност", en: "Energy efficiency" },
};

export const DOC_TYPES: Record<string, { bg: string; en: string }> = {
  DR: { bg: "Чертеж", en: "Drawing" },
  EX: { bg: "Обяснителна записка", en: "Explanatory note" },
  CA: { bg: "Изчислителна записка", en: "Calculation" },
  SP: { bg: "Спецификация", en: "Specification" },
  BQ: { bg: "КСС", en: "Bill of quantities" },
  RP: { bg: "Доклад", en: "Report" },
  M3: { bg: "3D модел", en: "3D model" },
};
