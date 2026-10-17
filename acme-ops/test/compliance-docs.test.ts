import { describe, expect, it } from "vitest";
import { matchDoc } from "../src/workflows/compliance-docs";

const product = { id: "prod_GEMS_LS200", name: "GEMS LS-200" };
const f = (id: string, name: string) => ({ id, name, type: "file" });

describe("compliance-docs", () => {
  it("matches a file only when it names both the document type and the part", () => {
    const files = [f("1", "GEMS LS-200 RoHS declaration 2025.pdf"), f("2", "RoHS policy.pdf"), f("3", "GEMS LS-200 datasheet.pdf")];
    expect(matchDoc(files, "rohs", product)?.id).toBe("1");
    expect(matchDoc(files, "reach", product)).toBeUndefined();
    expect(matchDoc([f("4", "prod_gems_ls200 CoC.pdf")], "coc", product)?.id).toBe("4");
  });
});
