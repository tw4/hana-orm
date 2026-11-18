import { test } from "node:test";
import assert from "node:assert/strict";
import { CATALOG_SQL, buildPhysicalFromCatalog, catalogType, introspect } from "../../src/introspect/catalog.ts";
import { makeTableFilter, parsePatternList } from "../../src/introspect/filter.ts";
import { FakeDriver } from "../migrate/fixtures.ts";
import { shopCatalog } from "./catalog-fixture.ts";

test("catalogType", () => {
  assert.equal(catalogType("NVARCHAR", 255, null), "NVARCHAR(255)");
  assert.equal(catalogType("DECIMAL", 15, 2), "DECIMAL(15,2)");
  assert.equal(catalogType("DECIMAL", 34, null), "DECIMAL");
  assert.equal(catalogType("SHORTTEXT", 20, null), "NVARCHAR(20)");
  assert.equal(catalogType("TIMESTAMP", 27, 7), "TIMESTAMP");
  assert.equal(catalogType("VARBINARY", 16, null), "VARBINARY(16)");
});

test("buildPhysicalFromCatalog: columns, keys, uniques, indexes, foreign keys, views", () => {
  const p = buildPhysicalFromCatalog(shopCatalog(), { schema: "SHOP", defaultSchema: "SHOP" });
  assert.deepEqual(Object.keys(p.tables).sort(), ["AUDIT_LOG", "CUSTOMERS", "ORDERS", "ORDER_ITEMS"], "housekeeping tables are skipped");
  const c = p.tables["CUSTOMERS"]!;
  assert.equal(c.schema, undefined);
  assert.equal(c.comment, "People who order");
  assert.deepEqual(c.columns[0], { name: "ID", type: "INTEGER", nullable: false, identity: true });
  assert.deepEqual(c.columns[3], { name: "IS_ACTIVE", type: "BOOLEAN", nullable: false, default: "TRUE" });
  assert.deepEqual(c.columns[4]!.default, "CURRENT_UTCTIMESTAMP");
  assert.deepEqual(c.primaryKey, { name: "PK_CUSTOMERS", columns: ["ID"] });
  assert.deepEqual(c.uniques, [{ name: "UQ_CUSTOMERS_EMAIL", columns: ["EMAIL"] }]);
  const o = p.tables["ORDERS"]!;
  assert.deepEqual(o.columns.find((x) => x.name === "TOTAL"), { name: "TOTAL", type: "DECIMAL(15,2)", nullable: false, default: "0" });
  assert.deepEqual(o.columns.find((x) => x.name === "STATUS")!.default, "'open'");
  assert.deepEqual(o.indexes, [
    { name: "IX_ORDERS_CUSTOMER_ID", columns: ["CUSTOMER_ID"] },
    { name: "ORDERS_BY_STATUS", columns: ["STATUS", "ORDERED_ON"] },
  ]);
  assert.deepEqual(o.foreignKeys.find((f) => f.name === "FK_ORDERS_BILLING"), {
    name: "FK_ORDERS_BILLING",
    columns: ["BILLING_CUSTOMER_ID"],
    refTable: "CUSTOMERS",
    refColumns: ["ID"],
    onDelete: "SET NULL",
    onUpdate: "RESTRICT",
  });
  assert.deepEqual(p.tables["ORDER_ITEMS"]!.primaryKey, { name: "ORDER_ITEMS_PK", columns: ["ORDER_ID", "LINE_NO"] });
  assert.equal(p.tables["AUDIT_LOG"]!.primaryKey, null);
  assert.deepEqual(p.views!["ACTIVE_CUSTOMERS"]!.columns.map((x) => x.type), ["INTEGER", "NVARCHAR(255)"]);
});

test("tables outside the default schema are keyed with their schema", () => {
  const p = buildPhysicalFromCatalog(shopCatalog(), { schema: "SHOP", defaultSchema: "APP" });
  assert.ok(p.tables["SHOP.ORDERS"]);
  assert.equal(p.tables["SHOP.ORDERS"]!.schema, "SHOP");
  assert.equal(p.tables["SHOP.ORDERS"]!.foreignKeys[0]!.refSchema, "SHOP");
});

test("table filters: --tables and --exclude with wildcards, case-insensitive", () => {
  const f = makeTableFilter(parsePatternList("order*, customers"), parsePatternList("*_ITEMS"))!;
  const p = buildPhysicalFromCatalog(shopCatalog(), { schema: "SHOP", defaultSchema: "SHOP", filter: f });
  assert.deepEqual(Object.keys(p.tables).sort(), ["CUSTOMERS", "ORDERS"]);
  assert.equal(makeTableFilter([], []), undefined);
});

test("introspect binds the schema as a parameter and restricts to onlyTables", async () => {
  const d = new FakeDriver();
  const rows = shopCatalog();
  const seen: [string, readonly unknown[]][] = [];
  d.onQuery = (sql, params) => {
    seen.push([sql, params]);
    if (sql.includes("CURRENT_SCHEMA AS S")) return [{ S: "SHOP" }];
    if (sql === CATALOG_SQL.tables) return rows.tables as never;
    if (sql === CATALOG_SQL.columns) return rows.columns as never;
    if (sql === CATALOG_SQL.constraints) return rows.constraints as never;
    if (sql === CATALOG_SQL.foreignKeys) return rows.foreignKeys as never;
    if (sql === CATALOG_SQL.indexes) return rows.indexes as never;
    return [];
  };
  const p = await introspect(d, { onlyTables: new Set(["ORDERS"]) });
  assert.deepEqual(Object.keys(p.tables), ["ORDERS"]);
  assert.ok(seen.slice(1).every(([sql, params]) => params[0] === "SHOP" && sql.includes("SCHEMA_NAME = ?")));
  assert.equal(seen.length, 7, "one query per catalog view (with full-text indexes), no views without --views");
});
