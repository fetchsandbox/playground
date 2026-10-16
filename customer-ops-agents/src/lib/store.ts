import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

/**
 * Minimal key/value store with the one primitive that makes the whole
 * workflow race-safe: an atomic conditional write. Idempotent side effects,
 * leases, run checkpoints (fenced by owner), approval decisions and survey
 * rate limits are all `put`/`update`/`delete` with a `Condition`.
 *
 * Single-table layout: partition key `pk` (string), TTL attribute `ttl`
 * (epoch seconds). Runs that are still open carry `open = "1"` and an
 * `updatedAt`, indexed by the sparse GSI `open-index` so `sweep` can find them.
 */
export type Scalar = string | number | boolean | null;
export interface Item {
  pk: string;
  ttl?: number;
  expiresAt?: number;
  [attr: string]: unknown;
}

export type Clause =
  | { op: "notExists" }
  | { op: "exists" }
  | { op: "eq"; attr: string; value: Scalar }
  | { op: "in"; attr: string; values: Scalar[] }
  | { op: "lt" | "gt"; attr: string; value: number }
  /** Attribute (or the whole item) absent, or a number below `value` — e.g. a stale lease. */
  | { op: "missingOrLt"; attr: string; value: number };

/** One clause, or several ANDed together. */
export type Condition = Clause | Clause[];

export const when = {
  notExists: (): Clause => ({ op: "notExists" }),
  exists: (): Clause => ({ op: "exists" }),
  /** Absent, or present with `expiresAt` < now (a stale claim). */
  notExistsOrExpired: (now: number): Clause => ({ op: "missingOrLt", attr: "expiresAt", value: now }),
  eq: (attrs: Record<string, Scalar>): Clause[] => Object.entries(attrs).map(([attr, value]) => ({ op: "eq", attr, value })),
  in: (attr: string, values: Scalar[]): Clause => ({ op: "in", attr, values }),
  lt: (attr: string, value: number): Clause => ({ op: "lt", attr, value }),
  gt: (attr: string, value: number): Clause => ({ op: "gt", attr, value }),
  missingOrLt: (attr: string, value: number): Clause => ({ op: "missingOrLt", attr, value }),
};

export interface KvStore {
  get(pk: string): Promise<Item | undefined>;
  /** Returns false (does not throw) when the condition fails. */
  put(item: Item, cond?: Condition): Promise<boolean>;
  /** SET `set` and REMOVE `remove`. Without a condition, the item must already exist. */
  update(pk: string, set: Record<string, unknown>, cond?: Condition, remove?: string[]): Promise<boolean>;
  /** Atomically append to a list attribute of an existing item. */
  append(pk: string, attr: string, values: unknown[]): Promise<boolean>;
  delete(pk: string, cond?: Condition): Promise<boolean>;
  /** Open runs (sparse index), least recently updated first. */
  listOpen(limit: number): Promise<Item[]>;
}

const clauses = (c: Condition | undefined): Clause[] => (c === undefined ? [] : Array.isArray(c) ? c : [c]);

// ---------------------------------------------------------------------------
// DynamoDB implementation
// ---------------------------------------------------------------------------

class ExprBuilder {
  names: Record<string, string> = {};
  values: Record<string, unknown> = {};
  private n = 0;
  name(attr: string) {
    const k = `#n${this.n++}`;
    this.names[k] = attr;
    return k;
  }
  value(v: unknown) {
    const k = `:v${this.n++}`;
    this.values[k] = v;
    return k;
  }
  condition(c: Condition | undefined): string | undefined {
    const parts = clauses(c).map((cl) => {
      switch (cl.op) {
        case "notExists":
          return "attribute_not_exists(pk)";
        case "exists":
          return "attribute_exists(pk)";
        case "eq":
          return `${this.name(cl.attr)} = ${this.value(cl.value)}`;
        case "in":
          return `${this.name(cl.attr)} IN (${cl.values.map((v) => this.value(v)).join(", ")})`;
        case "lt":
          return `${this.name(cl.attr)} < ${this.value(cl.value)}`;
        case "gt":
          return `${this.name(cl.attr)} > ${this.value(cl.value)}`;
        case "missingOrLt": {
          const a = this.name(cl.attr);
          return `(attribute_not_exists(${a}) OR ${a} < ${this.value(cl.value)})`;
        }
      }
    });
    return parts.length ? parts.join(" AND ") : undefined;
  }
  attrs() {
    return {
      ...(Object.keys(this.names).length ? { ExpressionAttributeNames: this.names } : {}),
      ...(Object.keys(this.values).length ? { ExpressionAttributeValues: this.values } : {}),
    };
  }
}

async function conditional(op: () => Promise<unknown>): Promise<boolean> {
  try {
    await op();
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return false;
    throw err;
  }
}

export class DynamoStore implements KvStore {
  private readonly doc: DynamoDBDocumentClient;
  constructor(
    private readonly table: string,
    client = new DynamoDBClient({}),
  ) {
    this.doc = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
  }

  async get(pk: string) {
    // Strongly consistent: a lease/claim check must never read a stale replica.
    const out = await this.doc.send(new GetCommand({ TableName: this.table, Key: { pk }, ConsistentRead: true }));
    return out.Item as Item | undefined;
  }

  put(item: Item, cond?: Condition) {
    const b = new ExprBuilder();
    const ConditionExpression = b.condition(cond);
    return conditional(() => this.doc.send(new PutCommand({ TableName: this.table, Item: item, ConditionExpression, ...b.attrs() })));
  }

  update(pk: string, set: Record<string, unknown>, cond?: Condition, remove: string[] = []) {
    const b = new ExprBuilder();
    const sets = Object.entries(set).map(([k, v]) => `${b.name(k)} = ${b.value(v)}`);
    const rems = remove.map((k) => b.name(k));
    const expr = [sets.length ? `SET ${sets.join(", ")}` : "", rems.length ? `REMOVE ${rems.join(", ")}` : ""].filter(Boolean).join(" ");
    const ConditionExpression = b.condition(clauses(cond).length ? cond : when.exists());
    return conditional(() =>
      this.doc.send(new UpdateCommand({ TableName: this.table, Key: { pk }, UpdateExpression: expr, ConditionExpression, ...b.attrs() })),
    );
  }

  append(pk: string, attr: string, values: unknown[]) {
    const b = new ExprBuilder();
    const a = b.name(attr);
    const expr = `SET ${a} = list_append(if_not_exists(${a}, ${b.value([])}), ${b.value(values)})`;
    return conditional(() =>
      this.doc.send(new UpdateCommand({ TableName: this.table, Key: { pk }, UpdateExpression: expr, ConditionExpression: b.condition(when.exists()), ...b.attrs() })),
    );
  }

  delete(pk: string, cond?: Condition) {
    const b = new ExprBuilder();
    const ConditionExpression = b.condition(cond);
    return conditional(() => this.doc.send(new DeleteCommand({ TableName: this.table, Key: { pk }, ConditionExpression, ...b.attrs() })));
  }

  async listOpen(limit: number) {
    const out = await this.doc.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: "open-index",
        KeyConditionExpression: "#o = :one",
        ExpressionAttributeNames: { "#o": "open" },
        ExpressionAttributeValues: { ":one": "1" },
        ScanIndexForward: true,
        Limit: limit,
      }),
    );
    return (out.Items ?? []) as Item[];
  }
}

// ---------------------------------------------------------------------------
// In-memory implementation (tests + local runs). Each operation yields to the
// event loop first so concurrent callers genuinely interleave, then checks and
// writes synchronously — the same atomicity DynamoDB gives per item.
// ---------------------------------------------------------------------------

function holds(existing: Item | undefined, cond: Condition | undefined): boolean {
  return clauses(cond).every((cl) => {
    const v = existing?.[cl.op === "notExists" || cl.op === "exists" ? "pk" : cl.attr];
    switch (cl.op) {
      case "notExists":
        return !existing;
      case "exists":
        return !!existing;
      case "eq":
        return !!existing && v === cl.value;
      case "in":
        return !!existing && cl.values.includes(v as Scalar);
      case "lt":
        return typeof v === "number" && v < cl.value;
      case "gt":
        return typeof v === "number" && v > cl.value;
      case "missingOrLt":
        return v === undefined || (typeof v === "number" && v < cl.value);
    }
  });
}

export class MemoryStore implements KvStore {
  readonly items = new Map<string, Item>();
  private tick = () => new Promise<void>((r) => setImmediate(r));

  async get(pk: string) {
    await this.tick();
    const it = this.items.get(pk);
    return it && structuredClone(it);
  }

  async put(item: Item, cond?: Condition) {
    await this.tick();
    if (!holds(this.items.get(item.pk), cond)) return false;
    this.items.set(item.pk, structuredClone(item));
    return true;
  }

  async update(pk: string, set: Record<string, unknown>, cond?: Condition, remove: string[] = []) {
    await this.tick();
    const existing = this.items.get(pk);
    if (!existing || !holds(existing, cond)) return false;
    const next: Item = { ...existing, ...structuredClone(set) };
    for (const k of remove) delete next[k];
    this.items.set(pk, next);
    return true;
  }

  async append(pk: string, attr: string, values: unknown[]) {
    await this.tick();
    const existing = this.items.get(pk);
    if (!existing) return false;
    existing[attr] = [...((existing[attr] as unknown[]) ?? []), ...structuredClone(values)];
    return true;
  }

  async delete(pk: string, cond?: Condition) {
    await this.tick();
    if (!holds(this.items.get(pk), cond)) return false;
    return this.items.delete(pk);
  }

  async listOpen(limit: number) {
    await this.tick();
    return [...this.items.values()]
      .filter((i) => i.open === "1")
      .sort((a, b) => Number(a.updatedAt ?? 0) - Number(b.updatedAt ?? 0))
      .slice(0, limit)
      .map((i) => structuredClone(i));
  }
}

export const ttlFromNow = (seconds: number, now = Date.now()) => Math.floor(now / 1000) + seconds;
