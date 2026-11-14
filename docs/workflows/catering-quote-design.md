# Catering quote to booking: business design

Companion to the generated [catering-quote guide](catering-quote.md). This page
explains *why* the workflow behaves as it does, the industry practice it
follows, and what the FetchSandbox receipt does and does not prove.

## The business need

A restaurant owner (the running example is a pizza shop) gets catering
requests from email, text messages, ad lead forms and the website. Today they
are answered by hand, late, at inconsistent prices, and accepted jobs are
re-typed into a calendar and an invoicing tool. The owner wants:

1. a correct quote, fast, at a **fixed price per head** for a menu package;
2. room to **negotiate** by email (and later text), within limits they set;
3. to **approve every quote** before the customer sees it;
4. once the customer accepts: the job **on their calendar**, an **invoice**
   sent, a **confirmation with follow-up instructions**, and a **reminder the
   day before**, each exactly once.

Email is implemented first; SMS negotiation is the planned next increment (see
[limits](#limits-and-next-increments)).

## Industry pattern this follows

Catering platforms (Toast Catering & Events, CaterZen, Caterease, HoneyBook
style CRMs) and caterers' own contract guidance converge on one flow:
**lead → priced proposal from the headcount → date held for a limited time →
acceptance → booking on the calendar / event order → invoice or deposit →
final-headcount deadline → day-before reminder and day-of contact**. Common
terms are a date "hold" of a few days, a final guaranteed headcount roughly
3–7 days before the event, and payment tied to that deadline so counts are
accurate. Sources are listed at the end.

How this workflow maps onto it, with the numbers chosen (all in
`POLICY`, version `catering-2026-11`, in
[the source](../../acme-ops/src/workflows/catering-quote.ts)):

| Stage | Rule in code |
|---|---|
| Price | Package per head: Classic $18.00, Premium $26.00. Delivery $35 flat; pickup free. |
| Negotiation | A requested price ≥ list → list. Down to the **15 % floor** → accepted as asked. Below → **countered at the floor**. At most **3 revisions**; a 4th goes to the owner. |
| Eligibility | **10–150 guests** (fewer: declined; more: the owner calls them). **48 h** minimum notice, **180 days** maximum. The kitchen calendar must be free from 90 min before to 30 min after the event. |
| Approval | The owner approves **every** quote and every decline. Nothing reaches the customer before that. |
| Hold | A quote can be accepted for **7 days**, but never later than **48 h before the event**. Only the **latest sent revision** can be accepted. |
| Acceptance | Relayed by the inbox adapter (`inbox:customer-reply`) or recorded by the owner; anyone else is refused (HTTP 403). |
| Booking | Google Calendar event on the owner's catering calendar with popup reminders **1 day** and **2 hours** before. |
| Payment | One Stripe invoice (`send_invoice`), due **72 h before** the event (or 24 h after issue if later), sent by Stripe. |
| Confirmation | Event details, invoice amount/due date/link, **final headcount by 72 h before** (reply or call), the team **calls ~2 h before**, owner's phone. |
| Reminder | Email **24 h before**, re-reading the calendar event and invoice (skipped if either was cancelled; says whether the invoice is still open). |
| Not automatic | Large parties, too many rounds, an inquiry that is already booked, or an unreadable calendar/billing system: the owner gets an email; the customer gets nothing automatic. |

A deposit-then-balance split (25–50 % deposit to lock the date is common) is
deliberately **not** implemented yet: the owner asked for one invoice. It is
the natural next change and would add a second invoice timed to the final
headcount.

## Flow

```
request (email / text / ad / web) ──► intake adapter ──► start {inquiryId, revision}
   │
   ├─ parallel, read-only: HubSpot contact · Calendar free/busy · Stripe customer + inquiry state
   ├─ quote desk (code): price, negotiate, eligibility → quote | decline | manual
   │
   quote ─► owner approves ─► Gmail sends quote ─► Stripe customer marked "<quote>|sent"
                                    │
              customer replies "yes" (signal) / counter-offer (new revision) / no reply (expires)
                                    │
                         acceptance re-checks "latest sent revision" ─► "<quote>|accepted"
                                    │
       Calendar event (+reminders) · Stripe invoice (finalize + send) · HubSpot customer
                                    │
                        confirmation email ─► reminder email at event − 24 h
   decline ─► owner approves ─► polite decline email
   manual  ─► owner notified; nothing to the customer
```

## Correctness choices worth knowing

- **Never send an email twice.** Gmail's `messages.send` has no idempotency
  key. The runtime sends once (no automatic HTTP retry), and an ambiguous
  outcome (timeout, lost response, 5xx) is resolved by finding the message by
  its deterministic `Message-ID` (`rfc822msgid:` search + read-back). If the
  mailbox can't be searched either, the step is marked `gmail:send_uncertain`
  and is **not** resent until a lookup can decide.
- **Only the newest quote is live.** The inquiry's state lives on the Stripe
  customer (`metadata.catering_<hash>` = `<quoteId>|sent` / `|accepted`). Sending
  a revision supersedes older ones; accepting re-reads that state, so a stale
  "yes" to an old price books nothing, and once booked a later counter-offer
  goes to the owner instead of becoming a second quote.
- **An early "yes" is ignored.** An acceptance recorded before the owner sent
  the quote is not treated as acceptance of a quote the customer never saw.
- **Invoices aren't duplicated by retries.** Before creating an invoice the
  step looks for this quote's invoice (`metadata.catering_quote`) and continues
  it (adds lines, finalizes, sends) rather than creating another.
- **A failed step can be resumed without losing what follows.** The kit's new
  `dependsOn` keeps dependent steps waiting while a prerequisite is failed (so
  `resume` can still complete the chain) and skips them at once when it can
  never happen (a rejection), so a declined quote doesn't sit waiting for a
  reminder timer.
- **Models write words; code decides.** Prices, eligibility, recipients and
  gates are code. An LLM (when configured) only drafts the quote/decline wording
  from fixed facts; the customer's notes are passed as untrusted facts.

## Verification

Evidence from the FetchSandbox run is in the [generated guide](catering-quote.md#fetchsandbox-verification)
and [verification record](../evidence/catering-quote-verification.md).

## Limits and next increments

- **SMS negotiation** (Twilio): planned next. The Twilio twin is available in
  FetchSandbox, so the same contract style applies.
- **Inbox intake adapter** (parsing a reply into a new revision or an
  acceptance) is outside this runtime and not proven here.
- **HubSpot deals**: the order is tracked on the contact (lifecycle
  opportunity → customer) and on the Stripe customer. A deal pipeline was not
  used because the HubSpot twin only qualifies a fixed deal-create profile and
  has no deal update or search (`PATCH /crm/v3/objects/deals/{id}` → 404,
  observed 2026-11-14).
- **Deposit/balance split, taxes, menus beyond two packages, staff
  scheduling** are not modelled.
- Twin evidence is not live delivery: it does not prove Gmail OAuth consent,
  real inbox delivery, Stripe's invoice email, or a deployed AgentCore runtime.

## Sources (industry practice, read 2026-11-14)

- [HoneyBook: catering contract template](https://www.honeybook.com/blog/catering-contract-template) — deposits at booking, final headcount and payment milestones.
- [Katalyst: how to price catering orders and contracts](https://www.katalystos.com/blog/how-to-price-catering-orders-and-contracts) — build every quote from the headcount; final-count deadline protects against no-shows.
- [AppMaster: catering inquiry-to-booking workflow](https://appmaster.io/blog/catering-inquiry-to-booking-workflow) — tentative holds with a stated hold period.
- [Toast Catering & Events overview](https://intercom.help/toast-central/en/articles/9308101-get-started-with-toast-catering-events) — lead form → estimate → deposit → invoice; calendar view incl. Google Calendar.
- [Promise Legal: catering contracts for small businesses](https://blog.promise.legal/startup-central/catering-contracts-startups-small-businesses-guide/) — written change process after the final-count deadline.
- [ZeroCater: corporate event catering checklist](https://zerocater.com/blog/corporate-event-catering-checklist/) — headcount confirmation timing.
