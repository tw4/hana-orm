import { test } from "node:test";
import assert from "node:assert/strict";
import {
  catalogDefaultToSql,
  classifyTypeChange,
  contractDefaultToSql,
  nativeTypeToDdl,
  normalizeType,
} from "../../src/migrate/types.ts";
import { contractToPhysical, referentialActionToSql } from "../../src/migrate/contract-to-physical.ts";
import { col, contract, enumCol, model } from "./fixtures.ts";

test("normalizeType", () => {
  assert.equal(normalizeType("nvarchar( 255 )"), "NVARCHAR(255)");
  assert.equal(normalizeType("DECIMAL(15)"), "DECIMAL(15,0)");
  assert.equal(normalizeType("decimal(15, 2)"), "DECIMAL(15,2)");
  assert.equal(normalizeType("DECIMAL"), "DECIMAL");
  assert.equal(normalizeType("int"), "INTEGER");
  assert.equal(normalizeType("ShortText(20)"), "NVARCHAR(20)");
  assert.equal(normalizeType("FLOAT(53)"), "DOUBLE");
});

test("native types map to DDL", () => {
  assert.equal(nativeTypeToDdl("NVarChar", [255]), "NVARCHAR(255)");
  assert.equal(nativeTypeToDdl("Decimal", [15, 2]), "DECIMAL(15,2)");
  assert.equal(nativeTypeToDdl("SecondDate", []), "SECONDDATE");
  assert.equal(nativeTypeToDdl("TinyInt", []), "TINYINT");
  assert.equal(nativeTypeToDdl("VarBinary", [16]), "VARBINARY(16)");
  assert.equal(nativeTypeToDdl("NClob", []), "NCLOB");
});

test("classifyTypeChange", () => {
  assert.equal(classifyTypeChange("NVARCHAR(10)", "nvarchar(10)"), "same");
  assert.equal(classifyTypeChange("VARCHAR(10)", "NVARCHAR(10)"), "widening");
  assert.equal(classifyTypeChange("NVARCHAR(10)", "VARCHAR(10)"), "narrowing");
  assert.equal(classifyTypeChange("TINYINT", "INTEGER"), "widening");
  assert.equal(classifyTypeChange("INTEGER", "DECIMAL(12,2)"), "widening");
  assert.equal(classifyTypeChange("INTEGER", "DECIMAL(8,2)"), "narrowing");
  assert.equal(classifyTypeChange("DECIMAL(10,2)", "DECIMAL"), "widening");
  assert.equal(classifyTypeChange("TIMESTAMP", "DATE"), "narrowing");
  assert.equal(classifyTypeChange("DATE", "TIMESTAMP"), "widening");
  assert.equal(classifyTypeChange("BOOLEAN", "INTEGER"), "incompatible");
});

test("contract defaults to SQL", () => {
  assert.equal(contractDefaultToSql({ kind: "autoincrement" }, "INTEGER"), undefined);
  assert.equal(contractDefaultToSql({ kind: "uuid" }, "NVARCHAR(36)"), undefined);
  assert.equal(contractDefaultToSql({ kind: "now" }, "TIMESTAMP"), "CURRENT_UTCTIMESTAMP");
  assert.equal(contractDefaultToSql({ kind: "value", value: "it's" }, "NVARCHAR(10)"), "'it''s'");
  assert.equal(contractDefaultToSql({ kind: "value", value: 1.5 }, "DOUBLE"), "1.5");
  assert.equal(contractDefaultToSql({ kind: "value", value: "10.50" }, "DECIMAL(10,2)"), "10.5");
  assert.equal(contractDefaultToSql({ kind: "value", value: true }, "BOOLEAN"), "TRUE");
  assert.equal(contractDefaultToSql({ kind: "dbgenerated", sql: " CURRENT_DATE " }, "DATE"), "CURRENT_DATE");
  const e = { name: "Role", dbName: "Role", values: [{ name: "ADMIN", dbName: "admin" }] };
  assert.equal(contractDefaultToSql({ kind: "value", value: "ADMIN" }, "NVARCHAR(255)", e), "'admin'");
});

test("catalog defaults normalize like contract defaults", () => {
  assert.equal(catalogDefaultToSql("abc", "NVARCHAR(10)"), "'abc'");
  assert.equal(catalogDefaultToSql("0.0", "DECIMAL(10,2)"), "0");
  assert.equal(catalogDefaultToSql("1", "BOOLEAN"), "TRUE");
  assert.equal(catalogDefaultToSql("current_utctimestamp", "TIMESTAMP"), "CURRENT_UTCTIMESTAMP");
  assert.equal(catalogDefaultToSql(null, "INTEGER"), undefined);
  assert.equal(catalogDefaultToSql("-1", "BIGINT"), "-1");
});

test("contractToPhysical: default types, enums, nullability, defaults", () => {
  const c = contract(
    [
      model("Thing", [
        col("id", "String", { id: true, default: { kind: "uuid" } }),
        col("n", "Int"),
        col("big", "BigInt", { optional: true }),
        col("f", "Float"),
        col("d", "Decimal"),
        col("b", "Boolean"),
        col("t", "DateTime", { updatedAt: true }),
        col("bytes", "Bytes"),
        col("j", "Json"),
        enumCol("role", "Role", { default: { kind: "value", value: "USER" } }),
      ]),
    ],
    [{ name: "Role", dbName: "Role", values: [{ name: "USER", dbName: "user" }] }],
  );
  const t = contractToPhysical(c).tables["Thing"]!;
  assert.deepEqual(
    t.columns.map((x) => [x.name, x.type, x.nullable, x.default ?? null]),
    [
      ["id", "NVARCHAR(5000)", false, null],
      ["n", "INTEGER", false, null],
      ["big", "BIGINT", true, null],
      ["f", "DOUBLE", false, null],
      ["d", "DECIMAL(38,10)", false, null],
      ["b", "BOOLEAN", false, null],
      ["t", "TIMESTAMP", false, null],
      ["bytes", "BLOB", false, null],
      ["j", "NCLOB", false, null],
      ["role", "NVARCHAR(255)", false, "'user'"],
    ],
  );
  assert.deepEqual(t.primaryKey, { name: "PK_Thing", columns: ["id"] });
});

test("referential actions map to HANA", () => {
  assert.equal(referentialActionToSql("Cascade"), "CASCADE");
  assert.equal(referentialActionToSql("NoAction"), "RESTRICT");
  assert.equal(referentialActionToSql(undefined), "RESTRICT");
  assert.equal(referentialActionToSql("SetNull"), "SET NULL");
});
