import { describe, expect, it } from "vitest";
import { can, makeAccess, resolveRoles } from "./roles";

const g = (...names: string[]) => names.map((name, i) => ({ id: "g" + i, name }));
const acc = (admin: boolean, ...names: string[]) => makeAccess(resolveRoles(admin, g(...names)), names);

describe("roles (union, same groups as shared/arsten-access.js)", () => {
  it("client, subcontractor, viewer and fabricator have no access", () => {
    for (const n of ["01.CLIENT", "03.SUBCONTRACTORS", "05.VIEWERS", "06.FABRICATOR"]) expect(can.view(acc(false, n))).toBe(false);
    expect(can.view(acc(false))).toBe(false);
  });
  it("admin, GC and designers open it", () => {
    expect(can.edit(acc(true))).toBe(true);
    expect(can.edit(acc(false, "02.1-EXECUTION PROJECT MANAGER"))).toBe(true);
    const d = acc(false, "4.1-STRUCTURAL DESIGNER");
    expect([can.view(d), can.edit(d), can.answer(d), can.decide(d)]).toEqual([true, false, true, true]);
  });
  it("a person in several groups gets all their rights", () => {
    const cd = acc(false, "01.CLIENT", "04.DESIGNERS");
    expect(cd.roles).toEqual(["client", "designer"]);
    expect(cd.role).toBe("designer");
    expect(can.decide(cd)).toBe(true);
    const sd = acc(false, "03.SUBCONTRACTORS", "04.DESIGNERS");
    expect(can.view(sd)).toBe(true);
    const gd = acc(false, "02.GENERAL CONTRACTOR", "04.DESIGNERS");
    expect([can.edit(gd), can.decide(gd)]).toEqual([true, true]);
  });
});
