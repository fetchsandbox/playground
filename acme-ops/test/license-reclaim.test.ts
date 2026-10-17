import { describe, expect, it } from "vitest";
import { classify } from "../src/workflows/license-reclaim";

const NOW = new Date("2026-10-17T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

describe("license-reclaim classification", () => {
  const policy = { inactiveDays: 90, graceDays: 14, excludeEmails: ["exec@acme.test"] };
  const user = (id: string, email: string, lastSignIn: string | null, created = daysAgo(400)) => ({ id, email, last_sign_in_at: lastSignIn, created_at: created });

  it("warns inside the grace window, reclaims after it, skips active and excluded seats", () => {
    const { warn, reclaim } = classify(
      [user("a", "active@acme.test", daysAgo(5)), user("w", "warn@acme.test", daysAgo(95)), user("r", "reclaim@acme.test", daysAgo(200)), user("x", "exec@acme.test", daysAgo(300))],
      NOW,
      policy,
    );
    expect(warn.map((s) => s.userId)).toEqual(["w"]);
    expect(reclaim.map((s) => s.userId)).toEqual(["r"]);
  });

  it("a never-used account is measured from its creation date", () => {
    const { reclaim } = classify([user("n", "new@acme.test", null, daysAgo(120))], NOW, policy);
    expect(reclaim[0]).toMatchObject({ userId: "n", neverSignedIn: true, idleDays: 120 });
    expect(classify([user("n2", "new2@acme.test", null, daysAgo(10))], NOW, policy).reclaim).toHaveLength(0);
  });
});
