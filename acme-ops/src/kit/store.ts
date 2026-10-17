import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

/**
 * The only persistence primitive the engine needs: conditional writes.
 *   create  → put-if-absent (run creation, side-effect claims)
 *   replace → compare-and-swap on `version` (every run checkpoint)
 * Run state never lives in the container, so any AgentCore session can pick a
 * run up where another one left off.
 */
export interface Item {
  pk: string;
  version?: number;
  [attr: string]: unknown;
}

export interface KvStore {
  get(pk: string): Promise<Item | undefined>;
  /** False when an item with this pk already exists. */
  create(item: Item): Promise<boolean>;
  /** Writes `item` (version+1) only if the stored version is still `item.version`. */
  replace(item: Item): Promise<boolean>;
  delete(pk: string): Promise<void>;
  /** Items whose pk starts with `prefix`. Used by verifier/admin reads only. */
  list(prefix: string): Promise<Item[]>;
}

const clone = <T>(v: T): T => structuredClone(v);

export class MemoryStore implements KvStore {
  protected items = new Map<string, Item>();

  async get(pk: string) {
    const it = this.items.get(pk);
    return it ? clone(it) : undefined;
  }
  async create(item: Item) {
    if (this.items.has(item.pk)) return false;
    this.items.set(item.pk, clone({ ...item, version: 1 }));
    this.persist();
    return true;
  }
  async replace(item: Item) {
    const cur = this.items.get(item.pk);
    if (!cur || cur.version !== item.version) return false;
    this.items.set(item.pk, clone({ ...item, version: (item.version ?? 0) + 1 }));
    this.persist();
    return true;
  }
  async delete(pk: string) {
    this.items.delete(pk);
    this.persist();
  }
  async list(prefix: string) {
    return [...this.items.values()].filter((i) => i.pk.startsWith(prefix)).map(clone);
  }
  protected persist() {}
}

/**
 * MemoryStore written through to a JSON file. For local runs and relay proofs
 * where the process may be restarted and must come back with its runs.
 */
export class FileStore extends MemoryStore {
  constructor(private readonly path: string) {
    super();
    if (existsSync(path)) for (const it of JSON.parse(readFileSync(path, "utf8")) as Item[]) this.items.set(it.pk, it);
  }
  protected override persist() {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.items.values()]));
    renameSync(tmp, this.path);
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

/** DynamoDB single table: partition key `pk`, TTL attribute `ttl`. */
export class DynamoStore implements KvStore {
  private readonly doc: DynamoDBDocumentClient;
  constructor(
    private readonly table: string,
    client = new DynamoDBClient({}),
  ) {
    this.doc = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
  }
  async get(pk: string) {
    const out = await this.doc.send(new GetCommand({ TableName: this.table, Key: { pk }, ConsistentRead: true }));
    return out.Item as Item | undefined;
  }
  create(item: Item) {
    return conditional(() =>
      this.doc.send(new PutCommand({ TableName: this.table, Item: { ...item, version: 1 }, ConditionExpression: "attribute_not_exists(pk)" })),
    );
  }
  replace(item: Item) {
    return conditional(() =>
      this.doc.send(
        new PutCommand({
          TableName: this.table,
          Item: { ...item, version: (item.version ?? 0) + 1 },
          ConditionExpression: "#v = :v",
          ExpressionAttributeNames: { "#v": "version" },
          ExpressionAttributeValues: { ":v": item.version },
        }),
      ),
    );
  }
  async delete(pk: string) {
    await this.doc.send(new DeleteCommand({ TableName: this.table, Key: { pk } }));
  }
  async list(prefix: string) {
    const items: Item[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const out = await this.doc.send(
        new ScanCommand({
          TableName: this.table,
          FilterExpression: "begins_with(pk, :p)",
          ExpressionAttributeValues: { ":p": prefix },
          ExclusiveStartKey: start,
        }),
      );
      items.push(...((out.Items ?? []) as Item[]));
      start = out.LastEvaluatedKey;
    } while (start);
    return items;
  }
}
