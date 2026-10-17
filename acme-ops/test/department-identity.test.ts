import { describe, it, expect } from "vitest";
import { GmailClient } from "../src/providers/google";
import { SlackClient } from "../src/providers/slack";
import type { ProviderHttp } from "../src/kit/http";

describe("department presentation", () => {
  it("keeps department From/Reply-To and creates a draft without sending", async () => {
    const calls: any[] = [];
    const http = { request: async (...args: any[]) => { calls.push(args); return {body: {id:"draft-1"}}; } } as unknown as ProviderHttp;
    const client = new GmailClient(http, "me", "Acme Operations <operations@fetchsandbox.com>", "operations@fetchsandbox.com");
    await client.createDraft({to:"reviewer@example.test", subject:"Demo", body:"Review this draft", messageId:"<demo@example.test>"});
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toBe("/gmail/v1/users/me/drafts");
    const mime = Buffer.from(calls[0][2].json.message.raw,"base64url").toString();
    expect(mime).toContain("From: Acme Operations <operations@fetchsandbox.com>\r\n");
    expect(mime).toContain("Reply-To: operations@fetchsandbox.com\r\n");
  });
  it("labels Slack output by department and preserves payload", async () => {
    const calls: any[] = [];
    const http = { request: async (...args: any[]) => { calls.push(args); return {body: {ok:true, ts:"1"}}; } } as unknown as ProviderHttp;
    await new SlackClient(http,"Finance").postMessage("C_DEMO","Approval pending");
    expect(calls[0][2].json.text).toBe("*Acme Finance*\nApproval pending");
    expect(calls[0][2].json.channel).toBe("C_DEMO");
  });
});
