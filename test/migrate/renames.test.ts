import { test } from "node:test";
import assert from "node:assert/strict";
import { contractToPhysical } from "../../src/migrate/contract-to-physical.ts";
import { diffSchemas } from "../../src/migrate/diff.ts";
import { findRenameCandidates, renamesFromContracts, withRenames } from "../../src/migrate/renames.ts";
import { planBetween } from "../../src/migrate/commands.ts";
import { col, contract, model } from "./fixtures.ts";

const v1 = contract([model("User", [col("id", "Int", { id: true, map: "ID" }), col("email", "String", { map: "MAIL" })], { map: "USERS" })]);
const v2 = contract([model("User", [col("id", "Int", { id: true, map: "ID" }), col("email", "String", { map: "EMAIL" })], { map: "APP_USERS", pkName: "PK_USERS" })]);

test("same model/field name with a changed @@map/@map is a rename", () => {
  const r = renamesFromContracts(v1, v2);
  assert.deepEqual(r, { tables: { USERS: "APP_USERS" }, columns: { APP_USERS: { MAIL: "EMAIL" } } });
  const ops = diffSchemas(contractToPhysical(v1), contractToPhysical(v2), { renames: r });
  assert.deepEqual(ops.map((o) => o.sql[0]), ['RENAME TABLE "USERS" TO "APP_USERS"', 'RENAME COLUMN "APP_USERS"."MAIL" TO "EMAIL"']);
});

test("planBetween applies contract renames", async () => {
  const ops = await planBetween(v1, v2, undefined);
  assert.deepEqual(ops.map((o) => o.kind), ["renameTable", "renameColumn"]);
});

test("model renamed in the schema but mapped to the same table keeps field renames", () => {
  const a = contract([model("User", [col("id", "Int", { id: true }), col("mail", "String", { map: "MAIL" })], { map: "USERS" })]);
  const b = contract([model("Member", [col("id", "Int", { id: true }), col("mail", "String", { map: "EMAIL" })], { map: "USERS" })]);
  assert.deepEqual(renamesFromContracts(a, b), { tables: {}, columns: { USERS: { MAIL: "EMAIL" } } });
});

test("moving a table to another schema is not a rename", () => {
  const a = contract([model("User", [col("id", "Int", { id: true })], { map: "USERS" })]);
  const b = contract([model("User", [col("id", "Int", { id: true })], { map: "USERS", schema: "OTHER" })]);
  assert.deepEqual(renamesFromContracts(a, b).tables, {});
});

test("candidate renames: table with identical columns, column with the same type", () => {
  const a = contract([
    model("A", [col("id", "Int", { id: true }), col("x", "String")], { map: "OLD_T" }),
    model("B", [col("id", "Int", { id: true }), col("oldName", "Int", { optional: true })]),
  ]);
  const b = contract([
    model("C", [col("id", "Int", { id: true }), col("x", "String")], { map: "NEW_T", pkName: "PK_OLD_T" }),
    model("B", [col("id", "Int", { id: true }), col("newName", "Int", { optional: true })]),
  ]);
  const from = contractToPhysical(a);
  const to = contractToPhysical(b);
  const r = renamesFromContracts(a, b);
  const c = findRenameCandidates(from, to, r);
  assert.deepEqual(c, { tables: [{ from: "OLD_T", to: "NEW_T" }], columns: [{ table: "B", from: "oldName", to: "newName" }] });
  const ops = diffSchemas(from, to, { renames: withRenames(r, c) });
  assert.deepEqual(ops.map((o) => o.kind), ["renameTable", "renameColumn"]);
});

test("planBetween asks for candidates and falls back to drop + add when declined", async () => {
  const a = contract([model("B", [col("id", "Int", { id: true }), col("oldName", "Int", { optional: true })])]);
  const b = contract([model("B", [col("id", "Int", { id: true }), col("newName", "Int", { optional: true })])]);
  let asked = 0;
  const declined = await planBetween(a, b, undefined, async () => {
    asked++;
    return { tables: [], columns: [] };
  });
  assert.equal(asked, 1);
  assert.deepEqual(declined.map((o) => o.kind), ["addColumn", "dropColumn"]);
  const accepted = await planBetween(a, b, undefined, async (c) => c);
  assert.deepEqual(accepted.map((o) => o.kind), ["renameColumn"]);
});

test("ambiguous column candidates are not suggested", () => {
  const a = contract([model("B", [col("id", "Int", { id: true }), col("a1", "Int"), col("a2", "Int")])]);
  const b = contract([model("B", [col("id", "Int", { id: true }), col("b1", "Int"), col("b2", "Int")])]);
  assert.deepEqual(findRenameCandidates(contractToPhysical(a), contractToPhysical(b), { tables: {}, columns: {} }).columns, []);
});
