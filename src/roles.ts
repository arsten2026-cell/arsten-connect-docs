import type { ConnectApi, GroupRef } from "./api";

/**
 * Roles of the current user, from the project's Connect groups. Same group mapping as shared/arsten-access.js (the
 * other Arsten / MULTIPLAN panels). A person in several groups has ALL their roles (union), as in the shared module:
 *   admin (project admin or 00_ADMIN) · gc (GENERAL CONTRACTOR, EXECUTION PROJECT MANAGER) · designer (DESIGNERS,
 *   STRUCTURAL DESIGNER) · client · subcontractor · fabricator · viewer
 * Documents is for admin, GC and designers only (same as the "Документи" tile in the combined panel):
 *   admin + gc may do everything; designers read, answer RFIs and decide shop drawings; everyone else: no access.
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
/** Display order only (same as ROLE_ORDER in shared/arsten-access.js); rights come from the union. */
const ORDER: Role[] = ["admin", "gc", "client", "subcontractor", "designer", "fabricator", "viewer", "none"];
/** Roles that may open Документи. */
export const DOC_ROLES: Role[] = ["admin", "gc", "designer"];

export const groupKey = (name: string) =>
  String(name ?? "").normalize("NFC").replace(/\s+/g, " ").trim().toUpperCase().replace(/^\d+(?:[.,]\d+)*\s*[.)\-_:]?\s*/, "").trim();

export interface Access {
  /** all roles of the user, in display order; empty = no role */
  roles: Role[];
  /** the first role that matters here (for display): a doc role if the user has one, else the first role, else "none" */
  role: Role;
  groups: string[];
  error?: string;
}

export function resolveRoles(isProjectAdmin: boolean, myGroups: GroupRef[]): Role[] {
  const set = new Set<Role>();
  if (isProjectAdmin) set.add("admin");
  for (const g of myGroups) {
    const r = GROUP_ROLES[groupKey(g.name)];
    if (r) set.add(r);
  }
  return ORDER.filter((r) => set.has(r));
}

export function makeAccess(roles: Role[], groups: string[], error?: string): Access {
  const role = roles.find((r) => DOC_ROLES.includes(r)) ?? roles[0] ?? "none";
  return { roles, role, groups, error };
}

export async function loadAccess(api: ConnectApi, userId?: string, isProjectAdmin = false): Promise<Access> {
  if (api.mode === "mock") return makeAccess(["admin"], ["00_ADMIN"]);
  try {
    const groups = await api.groups();
    const mine: GroupRef[] = [];
    for (const g of groups) {
      if (!GROUP_ROLES[groupKey(g.name)]) continue; // only groups that can give a role
      try { if (userId && (await api.groupMembers(g.id)).includes(userId)) mine.push(g); } catch { /* skip */ }
    }
    return makeAccess(resolveRoles(isProjectAdmin, mine), mine.map((g) => g.name));
  } catch (e: any) {
    return makeAccess(isProjectAdmin ? ["admin"] : [], [], e?.message ?? String(e));
  }
}

const any = (a: Access, ...rs: Role[]) => a.roles.some((r) => rs.includes(r));
export const can = {
  view: (a: Access) => any(a, ...DOC_ROLES),
  edit: (a: Access) => any(a, "admin", "gc"),
  answer: (a: Access) => any(a, "admin", "gc", "designer"),
  decide: (a: Access) => any(a, "admin", "designer"),
};
