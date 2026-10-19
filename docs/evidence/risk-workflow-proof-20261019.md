## FetchSandbox re-verification — October 19, 2026

The six original blocked check IDs are now executable. These are separate receipts from the actual AgentCore HTTP entry point running locally through the production managed relay and provider twins:

| Workflow | Passed | Failed | Unmeasured | Receipt |
|---|---:|---:|---:|---|
| Duplicate-charge remediation | 23 | 0 | 0 | https://fetchsandbox.com/runs/942df07202?flow=vr_32045f5c19c54d8fa57cc7504523a437 |
| Privacy erasure | 19 | 0 | 0 | https://fetchsandbox.com/runs/93969092e3?flow=vr_1fae88cbe29d455aa062b167be9977ed |

Source: app version `639dac1`; `acme-ops/src` is byte-for-byte the same Git tree as the reviewed PR head `375ed658fe4bfc50f7051bf5941a1a6d08bc8d73`. The 20 and 16 previously executable checks are unchanged; only the six blocked entries gained actions and assertions. Verification contracts/harness and saved receipts changed, not workflow business logic.

FetchSandbox backend `b72ebb49` and published/hosted MCP `0.7.30` supply the missing capabilities: body-selected HubSpot contact purge, stored WorkOS membership roles, a dispute linked to an actual test charge, a targeted dispute-read outage, and qualified independent operator changes between application actions. Stored provider replies and independent provider-state assertions were read back separately from the app's status. Both workflows also performed actual local process restarts with the same durable state. Disposable MCP keys were revoked and revocation confirmed.

Local source checks: TypeScript passed; 96/96 tests passed. New fatal-code predicates reject missing/wrong codes and an applied refund instead of the required failed action. These are expanded contracts, not a same-contract before/after proof of the original blocked receipts.

Limits: deterministic twin evidence, no fresh Claude cloud-session acceptance and no deployment of these two apps to AWS. The receipts do not certify every production scenario. Two unrelated `charge_then_notify` backend regression tests still fail and reproduce on the pre-change backend. An earlier relay setup attempt and earlier assertion-authoring attempts remain recorded as unsuccessful/inconclusive; they are not combined into these passing receipts.
