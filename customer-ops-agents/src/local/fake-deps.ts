import { configFromEnv, type Deps } from "../deps";
import type { Llm } from "../lib/llm";
import { silentLogger } from "../lib/log";
import { MemoryStore } from "../lib/store";
import { FakeBilling, FakeChat, FakeCrm, FakeMail, Faults } from "../providers/fakes";
import { ScriptedLlm } from "./scripted-llm";

export interface FakeWorld {
  deps: Deps;
  store: MemoryStore;
  crm: FakeCrm;
  billing: FakeBilling;
  mail: FakeMail;
  chat: FakeChat;
  faults: Faults;
}

/** A complete, shared fake world. Concurrent runs that share one world race for real. */
export function fakeWorld(overrides: { llm?: Llm; approverUserIds?: string[] } = {}): FakeWorld {
  const faults = new Faults();
  const store = new MemoryStore();
  const crm = new FakeCrm(faults);
  const billing = new FakeBilling(faults);
  const mail = new FakeMail(faults);
  const chat = new FakeChat();
  const config = { ...configFromEnv({}), approverUserIds: overrides.approverUserIds ?? [] };
  const deps: Deps = { store, llm: overrides.llm ?? new ScriptedLlm(), crm, billing, mail, chat, config, log: silentLogger, now: Date.now };
  return { deps, store, crm, billing, mail, chat, faults };
}
