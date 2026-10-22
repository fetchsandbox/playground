import { describe, expect, it } from "vitest";
import { endpointsFromEnv } from "../src/providers";

// Production auth follows each vendor's documented scheme wherever the base URL points;
// only the relay runner's explicit bearer opt-in changes it.
describe("provider auth follows vendor specs", () => {
  it("applies vendor schemes even with a non-default base URL", () => {
    const e = endpointsFromEnv({ PAGERDUTY_API_KEY: "k", PAGERDUTY_BASE_URL: "https://api.pagerduty.com/", MODERN_TREASURY_API_KEY: "mk", MODERN_TREASURY_ORGANIZATION_ID: "org", PLAID_CLIENT_ID: "c", PLAID_SECRET: "s" } as any);
    expect(e.pagerduty?.authorization).toBe("Token token=k");
    expect(e.moderntreasury?.authorization).toBe(`Basic ${Buffer.from("org:mk").toString("base64")}`);
    expect(e.plaid?.authorization).toBe("");
  });
  it("refuses a vendor configured without its required identifiers", () => {
    expect(() => endpointsFromEnv({ MODERN_TREASURY_API_KEY: "mk" } as any)).toThrow(/MODERN_TREASURY_ORGANIZATION_ID/);
    expect(() => endpointsFromEnv({ TWILIO_API_KEY: "t" } as any)).toThrow(/TWILIO_ACCOUNT_SID/);
  });
  it("uses a bearer token only when the twin runner opts in", () => {
    const e = endpointsFromEnv({ PAGERDUTY_API_KEY: "k", PAGERDUTY_BASE_URL: "https://twin.example", PAGERDUTY_AUTH_SCHEME: "bearer" } as any);
    expect(e.pagerduty?.authorization).toBeUndefined();
  });
});
