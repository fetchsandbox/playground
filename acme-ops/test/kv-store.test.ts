import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore, MemoryStore } from "../src/kit/store";
import { kvStoreConformance } from "./conformance/kv-store";

kvStoreConformance("MemoryStore", async () => new MemoryStore());
kvStoreConformance("FileStore", async () => new FileStore(join(mkdtempSync(join(tmpdir(), "kv-")), "state.json")));
