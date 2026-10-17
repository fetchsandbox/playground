import { describe, expect, it } from "vitest";
import { libraryFromPages, matchQuestions, similarity } from "../src/workflows/security-questionnaire";

const NOW = new Date("2026-10-17T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

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
