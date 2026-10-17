import { z } from "zod";
import type { PlannedAction, WorkflowDef } from "../kit/types";
import { Approvers, ChannelId, Email, messageId, out, plain } from "./shared";

// IT org · it-security team.
// Trigger: a customer security review lands (via sales or the trust inbox).
// Answers come ONLY from the approved library; anything new goes to Security.

const Input = z.object({
  customer: z.object({ name: z.string().min(1).max(200), email: Email }),
  questions: z
    .array(z.object({ id: z.string().min(1).max(40), text: z.string().min(5).max(2000) }))
    .min(1)
    .max(300)
    .refine((q) => new Set(q.map((x) => x.id)).size === q.length, "duplicate question ids"),
  /** Notion database holding approved Q&A (Question title + Answer text). */
  libraryDatabaseId: z.string().min(1).max(100),
  securityChannel: ChannelId,
  securityWorkspace: z.string().min(1).default("acme-security"),
  approvers: Approvers,
});
type Input = z.infer<typeof Input>;

interface LibraryEntry {
  question: string;
  answer: string;
}

const STOP = new Set("a an and are as at be by do does for from has have how in is it of on or the to we what when where which who with you your".split(" "));
const tokens = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));

/** Jaccard overlap of content words. Deterministic; a model never invents an answer. */
export function similarity(a: string, b: string): number {
  const x = tokens(a);
  const y = tokens(b);
  if (!x.size || !y.size) return 0;
  let inter = 0;
  for (const w of x) if (y.has(w)) inter++;
  return inter / (x.size + y.size - inter);
}

export const MATCH_THRESHOLD = 0.5;

export function matchQuestions(questions: { id: string; text: string }[], library: LibraryEntry[]) {
  return questions.map((q) => {
    let best: { entry: LibraryEntry; score: number } | undefined;
    for (const entry of library) {
      const score = similarity(q.text, entry.question);
      if (!best || score > best.score) best = { entry, score };
    }
    return best && best.score >= MATCH_THRESHOLD
      ? { id: q.id, text: q.text, answer: best.entry.answer, source: best.entry.question, score: Math.round(best.score * 100) / 100 }
      : { id: q.id, text: q.text, answer: null, source: null, score: Math.round((best?.score ?? 0) * 100) / 100 };
  });
}

/** Plain text of a Notion property (title / rich_text), whatever its name. */
function propText(p: any): string {
  const parts = p?.title ?? p?.rich_text ?? [];
  return Array.isArray(parts) ? parts.map((t: any) => t?.plain_text ?? t?.text?.content ?? "").join("").trim() : "";
}

export function libraryFromPages(pages: any[]): LibraryEntry[] {
  const out: LibraryEntry[] = [];
  for (const page of pages) {
    const props = page?.properties ?? {};
    const q = propText(props.Question ?? props.Name ?? Object.values(props).find((v: any) => v?.title));
    const a = propText(props.Answer);
    if (q && a) out.push({ question: q, answer: a });
  }
  return out;
}

type Matched = ReturnType<typeof matchQuestions>[number];

export const securityQuestionnaire: WorkflowDef<Input> = {
  id: "security-questionnaire",
  title: "Security questionnaire responder",
  org: "IT",
  team: "it-security",
  description:
    "Answer a customer security questionnaire from the approved Notion library, route every unanswered question to Security in Asana and Slack, and draft the response to the customer once Security approves.",
  input: Input,
  agents: [
    {
      name: "answer-library",
      needs: ["notion"],
      async run({ input, providers }) {
        const pages = await providers.notion!.queryDatabase(input.libraryDatabaseId);
        const library = libraryFromPages(pages);
        return { summary: `${library.length} approved answers (${pages.length} pages)`, data: { library } };
      },
    },
    {
      name: "customer-context",
      needs: ["hubspot"],
      async run({ input, providers }) {
        const c = await providers.hubspot!.findByEmail(input.customer.email);
        return { summary: c ? `HubSpot ${c.id} (${c.properties.lifecyclestage ?? "no stage"})` : "not in HubSpot", data: { contactId: c?.id, lifecycle: c?.properties.lifecyclestage ?? undefined } };
      },
    },
  ],

  compose: {
    name: "answer-matcher",
    async run({ input }, results) {
      const library = out<{ library: LibraryEntry[] }>(results, "answer-library")?.library;
      // No library read = nothing is answerable; never fall back to free-form answers.
      const matched = matchQuestions(input.questions, library ?? []);
      return { summary: `${matched.filter((m) => m.answer).length}/${matched.length} answered from the library`, data: { matched, libraryRead: !!library } };
    },
  },

  plan({ input }, results) {
    const m = out<{ matched: Matched[]; libraryRead: boolean }>(results, "answer-matcher");
    if (!m) return [];
    const answered = m.matched.filter((x) => x.answer);
    const open = m.matched.filter((x) => !x.answer);
    const actions: PlannedAction<Input>[] = [];
    if (open.length) {
      actions.push({
        id: "asana.security_review",
        kind: "asana.security_review",
        provider: "asana",
        agent: "answer-matcher",
        gate: "auto",
        summary: { customer: input.customer.name, unanswered: open.length },
        async execute({ providers }) {
          const t = await providers.asana!.createTask({
            name: `Security review: ${plain(input.customer.name, 100)} — ${open.length} question(s) need an approved answer`,
            notes: [m.libraryRead ? "" : "The answer library could not be read; every question is listed.", ...open.map((q) => `[ ] ${q.id}: ${plain(q.text, 400)}`)].filter(Boolean).join("\n"),
            workspace: input.securityWorkspace,
          });
          return { ref: t.gid };
        },
        async reconcile({ providers }, r) {
          const t = await providers.asana!.getTask(r.ref);
          return t.name?.includes("Security review") ? { status: "match" } : { status: "drift", detail: "task renamed" };
        },
      });
    }
    actions.push({
      id: "slack.post_summary",
      kind: "slack.post_summary",
      provider: "slack",
      agent: "answer-matcher",
      gate: "auto",
      summary: { channel: input.securityChannel, answered: answered.length, open: open.length },
      async execute({ providers }) {
        const text = `*Security questionnaire* from ${plain(input.customer.name, 100)}: ${answered.length}/${m.matched.length} answered from the approved library${m.libraryRead ? "" : " (library unreadable)"}; ${open.length} need Security.`;
        const msg = await providers.slack!.postMessage(input.securityChannel, text);
        return { ref: msg.ts };
      },
    });
    actions.push({
      id: "gmail.draft_response",
      kind: "gmail.draft_response",
      provider: "gmail",
      agent: "answer-matcher",
      gate: "approval",
      summary: { to: input.customer.email, answered: answered.length, pending: open.length, sent: false },
      async execute({ providers, runId }) {
        const body = [
          `Hello ${plain(input.customer.name, 100)} team,`,
          "",
          "Please find ACME's answers to your security questionnaire below.",
          "",
          ...m.matched.map((q) => `${q.id}. ${q.text}\n   ${q.answer ?? "Answer to follow from our security team."}`),
          "",
          "ACME Security",
        ].join("\n");
        const d = await providers.gmail!.createDraft({ to: input.customer.email, subject: "ACME security questionnaire responses", body, messageId: messageId(runId, "secq") });
        return { ref: d.id };
      },
    });
    return actions;
  },

  output(_ctx, results) {
    const m = out<{ matched: Matched[]; libraryRead: boolean }>(results, "answer-matcher");
    return {
      libraryRead: m?.libraryRead ?? false,
      questions: m?.matched.length ?? 0,
      answered: m?.matched.filter((x) => x.answer).length ?? 0,
      unanswered: m?.matched.filter((x) => !x.answer).length ?? 0,
      matches: m?.matched ?? [],
    };
  },

  catalog: [
    { kind: "asana.security_review", provider: "asana", gate: "auto", description: "Open a Security task listing every question without an approved answer" },
    { kind: "slack.post_summary", provider: "slack", gate: "auto", description: "Post coverage of the questionnaire to Security" },
    { kind: "gmail.draft_response", provider: "gmail", gate: "approval", description: "Draft (not send) the answered questionnaire to the customer" },
  ],
};
