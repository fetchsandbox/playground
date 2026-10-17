import { describe, expect, it } from "vitest";
import { PRIVILEGED, sodViolations } from "../src/workflows/access-jml";
import { classify } from "../src/workflows/license-reclaim";
import { libraryFromPages, matchQuestions, similarity } from "../src/workflows/security-questionnaire";
import { holdReasons } from "../src/workflows/supplier-ncr";

const NOW = new Date("2026-10-17T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

describe("access-jml policy", () => {
  it("flags segregation-of-duties conflicts and privileged roles", () => {
    expect(sodViolations(["member", "finance-admin", "it-admin"])).toEqual(["finance-admin+it-admin"]);
    expect(sodViolations(["member", "finance-admin"])).toEqual([]);
    expect(PRIVILEGED.has("billing-admin")).toBe(true);
    expect(PRIVILEGED.has("engineer")).toBe(false);
  });
});

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

describe("security-questionnaire matching", () => {
  const library = libraryFromPages([
    { properties: { Question: { title: [{ plain_text: "Is customer data encrypted at rest and in transit?" }] }, Answer: { rich_text: [{ plain_text: "Yes: AES-256 at rest, TLS 1.2+ in transit." }] } } },
    { properties: { Question: { title: [{ plain_text: "Do you have a SOC 2 Type II report?" }] }, Answer: { rich_text: [{ plain_text: "Yes, available under NDA." }] } } },
    { properties: { Name: { title: [{ plain_text: "Draft with no answer" }] } } },
  ]);

  it("reads only pages that carry both a question and an answer", () => {
    expect(library).toHaveLength(2);
  });

  it("answers close paraphrases with the approved text and leaves the rest unanswered", () => {
    const [enc, soc, pen] = matchQuestions(
      [
        { id: "Q1", text: "Do you encrypt customer data at rest and in transit?" },
        { id: "Q2", text: "Can you share your SOC 2 Type II report?" },
        { id: "Q3", text: "When was your last external penetration test?" },
      ],
      library,
    );
    expect(enc).toMatchObject({ answer: "Yes: AES-256 at rest, TLS 1.2+ in transit." });
    expect(soc!.answer).toBe("Yes, available under NDA.");
    expect(pen).toMatchObject({ answer: null });
    expect(similarity("", "anything")).toBe(0);
  });
});

describe("supplier-ncr hold policy", () => {
  it("proposes a hold for critical defects, high reject rates or repeat suppliers", () => {
    expect(holdReasons({ severity: "major", qtyInspected: 200, qtyRejected: 2 }, 0)).toEqual([]);
    expect(holdReasons({ severity: "critical", qtyInspected: 200, qtyRejected: 2 }, 0)).toEqual(["critical defect"]);
    expect(holdReasons({ severity: "minor", qtyInspected: 100, qtyRejected: 10 }, 0)).toEqual(["reject rate 10%"]);
    expect(holdReasons({ severity: "minor", qtyInspected: 100, qtyRejected: 1 }, 2)).toEqual(["2 open CAPAs"]);
  });
});
