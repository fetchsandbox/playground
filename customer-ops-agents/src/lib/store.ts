import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

/**
 * Minimal key/value store with the one primitive that makes the whole
 * workflow race-safe: an atomic conditional write. Everything else —
 * idempotent side effects, leases, approval decisions, survey rate limits —
 * is built on `put`/`update`/`delete` with a `Condition`.
 *
 * Single-table layout: partition key `pk` (string), TTL attribute `ttl`
 * (epoch seconds) so DynamoDB garbage-collects old records.
 */
export type Scalar = string | number | boolean | null;
export interface Item {
  pk: string;
  ttl?: number;
  expiresAt?: number;
  [attr: string]: unknown;
}

export type Condition =
  | { kind: "notExists" }
  /** Absent, or present with `expiresAt` < now (a stale lease/claim). */
  | { kind: "notExistsOrExpired"; now: number }
  /** Present and every listed attribute equals the given value. */
  | { kind: "equals"; attrs: Record<string, Scalar> };

export interface KvStore {
  get(pk: string): Promise<Item | undefined>;
  /** Returns false (does not throw) when the condition fails. */
  put(item: Item, cond?: Condition): Promise<boolean>;
  update(pk: string, set: Record<string, unknown>, cond?: Condition): Promise<boolean>;
  delete(pk: string, cond?: Condition): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// DynamoDB implementation
// ---------------------------------------------------------------------------

function toExpression(cond: Condition | undefined) {
  if (!cond) return {};
  switch (cond.kind) {
    case "notExists":
      return { ConditionExpression: "attribute_not_exists(pk)" };
    case "notExistsOrExpired":
      return {
        ConditionExpression: "attribute_not_exists(pk) OR expiresAt < :now",
        ExpressionAttributeValues: { ":now": cond.now },
      };
    case "equals": {
      const names: Record<string, string> = {};
      const values: Record<string, unknown> = {};
      const parts = Object.entries(cond.attrs).map(([k, v], i) => {
        names[`#c${i}`] = k;
        values[`:c${i}`] = v;
        return `#c${i} = :c${i}`;
      });
      return {
        ConditionExpression: parts.join(" AND "),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      };
    }
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
    return conditional(() => this.doc.send(new PutCommand({ TableName: this.table, Item: item, ...toExpression(cond) })));
  }

  update(pk: string, set: Record<string, unknown>, cond?: Condition) {
    const c = toExpression(cond);
    const names: Record<string, string> = { ...c.ExpressionAttributeNames };
    const values: Record<string, unknown> = { ...c.ExpressionAttributeValues };
    const sets = Object.entries(set).map(([k, v], i) => {
      names[`#s${i}`] = k;
      values[`:s${i}`] = v;
      return `#s${i} = :s${i}`;
    });
    // Updates without an explicit condition must not create phantom items.
    const condition = c.ConditionExpression ?? "attribute_exists(pk)";
    return conditional(() =>
      this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { pk },
          UpdateExpression: `SET ${sets.join(", ")}`,
          ConditionExpression: condition,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        }),
      ),
    );
  }

  delete(pk: string, cond?: Condition) {
    return conditional(() => this.doc.send(new DeleteCommand({ TableName: this.table, Key: { pk }, ...toExpression(cond) })));
  }
}

// ---------------------------------------------------------------------------
// In-memory implementation (tests + local runs). Each operation yields to the
// event loop first so concurrent callers genuinely interleave, then checks and
// writes synchronously — the same atomicity DynamoDB gives per item.
// ---------------------------------------------------------------------------

function holds(existing: Item | undefined, cond: Condition | undefined): boolean {
  if (!cond) return true;
  switch (cond.kind) {
    case "notExists":
      return !existing;
    case "notExistsOrExpired":
      return !existing || (typeof existing.expiresAt === "number" && existing.expiresAt < cond.now);
    case "equals":
      return !!existing && Object.entries(cond.attrs).every(([k, v]) => existing[k] === v);
  }
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

  async update(pk: string, set: Record<string, unknown>, cond?: Condition) {
    await this.tick();
    const existing = this.items.get(pk);
    if (!existing || !holds(existing, cond)) return false;
    this.items.set(pk, { ...existing, ...structuredClone(set) });
    return true;
  }

  async delete(pk: string, cond?: Condition) {
    await this.tick();
    if (!holds(this.items.get(pk), cond)) return false;
    return this.items.delete(pk);
  }
}

export const ttlFromNow = (seconds: number, now = Date.now()) => Math.floor(now / 1000) + seconds;
