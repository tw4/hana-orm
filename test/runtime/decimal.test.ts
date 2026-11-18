/** Decimal modes: "string" (default), "number", "decimal.js" (issue #16). */

import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeValue, encodeValue } from "../../src/runtime/codec.ts";
import { createClientClass } from "../../src/runtime/client.ts";
import { generateClient } from "../../src/generator/client.ts";
import { compileSchema } from "../../src/schema/build.ts";
import type { ColumnFieldDef } from "../../src/schema/contract.ts";
import { contract } from "../generated/constraints/index.ts";
import { HanaClient as NumberClient } from "../generated/decimal-number/index.ts";
import { FakeDriver } from "./fake-driver.ts";

const credit = contract.models.Member!.fields.find((f) => f.name === "credit") as ColumnFieldDef;

/** Stand-in for decimal.js: keeps the text, has toFixed() like decimal.js. */
class FakeDecimal {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
  toFixed(): string {
    return this.text;
  }
}

test("decodeValue returns Decimal values per mode", () => {
  assert.equal(decodeValue(contract, credit, "12345678901234.25"), "12345678901234.25", "string by default keeps every digit");
  assert.equal(decodeValue(contract, credit, "12.50", { decimal: "string" }), "12.50");
  assert.equal(decodeValue(contract, credit, "12.50", { decimal: "number" }), 12.5);
  const d = decodeValue(contract, credit, "12.50", { decimal: "decimal.js", Decimal: FakeDecimal });
  assert.ok(d instanceof FakeDecimal);
  assert.equal((d as FakeDecimal).text, "12.50");
  assert.throws(() => decodeValue(contract, credit, "1", { decimal: "decimal.js" }), /needs the Decimal class/);
  assert.equal(decodeValue(contract, credit, null, { decimal: "number" }), null);
});

test("encodeValue accepts strings, numbers and decimal.js-like objects without exponent notation", () => {
  assert.equal(encodeValue(contract, credit, "12.50"), "12.50");
  assert.equal(encodeValue(contract, credit, 12.5), "12.5");
  assert.equal(encodeValue(contract, credit, new FakeDecimal("100000000000000000000000.5")), "100000000000000000000000.5");
  assert.throws(() => encodeValue(contract, credit, "1e5"), /expects a decimal/);
});

test("the generator types Decimal fields per mode and bakes the mode into the client class", () => {
  const c = compileSchema('model T {\n  id Int @id\n  amount Decimal\n}\n');
  const str = generateClient(c);
  assert.match(str, /amount: \$r\.Decimal;/);
  assert.match(str, /\$r\.createClientClass\(contract\) as unknown/);
  assert.doesNotMatch(str, /decimal\.js/);

  const num = generateClient(c, { decimal: "number" });
  assert.match(num, /amount: number;/);
  assert.match(num, /amount\?: number \| string \| \$r\.Filter<number \| string>;/);
  assert.match(num, /\$r\.createClientClass\(contract, \{ decimal: "number" \}\)/);

  const dj = generateClient(c, { decimal: "decimal.js" });
  assert.match(dj, /^import \{ Decimal as \$Decimal \} from "decimal\.js";$/m);
  assert.match(dj, /amount: \$Decimal;/);
  assert.match(dj, /\$r\.createClientClass\(contract, \{ decimal: "decimal\.js", Decimal: \$Decimal \}\)/);

  assert.throws(() => generateClient(c, { decimal: "float" as never }), /Unknown decimal mode 'float'/);
  // the mode of one generation does not leak into the next
  assert.match(generateClient(c), /amount: \$r\.Decimal;/);
});

test("a number-mode client returns numbers from reads and aggregates", async () => {
  const driver = new FakeDriver();
  driver.respond = (sql) => {
    if (sql.includes("SUM(")) return [{ "_sum.credit": "30.75" }];
    if (sql.startsWith("SELECT")) return [{ id: 1, email: "a@example.com", name: null, team: "t", seat: 1, credit: "10.25" }];
    return undefined;
  };
  const db = new NumberClient({ driver });
  const [m] = await db.member.findMany();
  assert.equal(m!.credit, 10.25);
  const agg = await db.member.aggregate({ _sum: { credit: true } });
  assert.equal(agg._sum.credit, 30.75);
  await db.member.create({ data: { email: "b@example.com", team: "t", seat: 2, credit: 5.5 } });
  const insert = driver.calls.find((c) => c.sql.startsWith("INSERT"))!;
  assert.ok(insert.params.includes("5.5"), "numbers are sent as decimal text");
});

test("a decimal.js-mode client returns Decimal instances", async () => {
  const Client = createClientClass(contract, { decimal: "decimal.js", Decimal: FakeDecimal });
  const driver = new FakeDriver();
  driver.respond = (sql) => (sql.startsWith("SELECT") ? [{ id: 1, email: "a", name: null, team: "t", seat: 1, credit: "0.10" }] : undefined);
  const db = new Client({ driver }) as unknown as { member: { findMany(): Promise<{ credit: unknown }[]> } };
  const [m] = await db.member.findMany();
  assert.ok(m!.credit instanceof FakeDecimal);
  assert.equal((m!.credit as FakeDecimal).text, "0.10");
  assert.throws(() => createClientClass(contract, { decimal: "decimal.js" }), /needs the Decimal class/);
});
