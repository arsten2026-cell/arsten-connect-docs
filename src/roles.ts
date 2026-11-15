import type { ConnectApi, GroupRef } from "./api";

/**
 * Role of the current user, from the project's Connect groups. Same mapping as shared/arsten-access.js (the other
 * Arsten / MULTIPLAN panels), so a person has the same role everywhere:
 *   admin (project admin or 00_ADMIN) · gc (GENERAL CONTRACTOR, EXECUTION PROJECT MANAGER) · designer (DESIGNERS,
 *   STRUCTURAL DESIGNER) · client · subcontractor · fabricator · viewer · none
 * Documents: admin + gc may do everything; designers answer RFIs and decide shop drawings; others read only.
 */
export type Role = "admin" | "gc" | "designer" | "client" | "subcontractor" | "fabricator" | "viewer" | "none";

export const GROUP_ROLES: Record<string, Role> = {
  "ADMIN": "admin",
  "GENERAL CONTRACTOR": "gc",
  "EXECUTION PROJECT MANAGER": "gc",
  "CLIENT": "client",
  "SUBCONTRACTORS": "subcontractor",
  "DESIGNERS": "designer",
  "STRUCTURAL DESIGNER": "designer",
  "VIEWERS": "viewer",
  "FABRICATOR": "fabricator",
};
const ORDER: Role[] = ["admin", "gc", "designer", "client", "subcontractor", "fabricator", "viewer", "none"];

export const groupKey = (name: string) =>
  String(name ?? "").normalize("NFC").replace(/\s+/g, " ").trim().toUpperCase().replace(/^\d+(?:[.,]\d+)*\s*[.)\-_:]?\s*/, "").trim();

export interface Access { role: Role; groups: string[]; error?: string }

export function resolveRole(isProjectAdmin: boolean, myGroups: GroupRef[]): Role {
  let best: Role = "none";
  for (const g of myGroups) {
    const r = GROUP_ROLES[groupKey(g.name)];
    if (r && ORDER.indexOf(r) < ORDER.indexOf(best)) best = r;
  }
  return isProjectAdmin ? "admin" : best;
}

export async function loadAccess(api: ConnectApi, userId?: string, isProjectAdmin = false): Promise<Access> {
  if (api.mode === "mock") return { role: "admin", groups: ["00_ADMIN"] };
  try {
    const groups = await api.groups();
    const mine: GroupRef[] = [];
    for (const g of groups) {
      if (!GROUP_ROLES[groupKey(g.name)]) continue; // only groups that can give a role
      try { if (userId && (await api.groupMembers(g.id)).includes(userId)) mine.push(g); } catch { /* skip */ }
    }
    return { role: resolveRole(isProjectAdmin, mine), groups: mine.map((g) => g.name) };
  } catch (e: any) {
    return { role: isProjectAdmin ? "admin" : "none", groups: [], error: e?.message ?? String(e) };
  }
}

export const can = {
  edit: (r: Role) => r === "admin" || r === "gc",
  answer: (r: Role) => r === "admin" || r === "gc" || r === "designer",
  decide: (r: Role) => r === "admin" || r === "designer",
  view: (r: Role) => r !== "none",
};
