import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPhysicalFromCatalog } from "../../src/introspect/catalog.ts";
import { renderSchema, mapHanaType } from "../../src/introspect/render.ts";
import { backRelationName, camelCase, pascalCase, plural, singular, words } from "../../src/introspect/naming.ts";
import { splitBlocks } from "../../src/introspect/blocks.ts";
import { contractToPhysical } from "../../src/migrate/contract-to-physical.ts";
import { diffSchemas } from "../../src/migrate/diff.ts";
import { compileSchema } from "../../src/schema/build.ts";
import { parseSchema } from "../../src/schema/parser.ts";
import { shopCatalog } from "./catalog-fixture.ts";

const physical = () => buildPhysicalFromCatalog(shopCatalog(), { schema: "SHOP", defaultSchema: "SHOP" });

function block(source: string, name: string): string {
  return splitBlocks(source).blocks.find((b) => b.name === name)!.text;
}

test("naming", () => {
  assert.deepEqual(words("ORDER_ITEMS"), ["order", "items"]);
  assert.deepEqual(words("orderItems"), ["order", "items"]);
  assert.deepEqual(words("HTTPServerLog"), ["http", "server", "log"]);
  assert.equal(pascalCase("ORDER_ITEMS"), "OrderItems");
  assert.equal(camelCase("ORDER_ITEMS"), "orderItems");
  assert.equal(camelCase("ID"), "id");
  assert.equal(camelCase("2FA_CODE"), "_2faCode");
  assert.equal(camelCase("A$B/C"), "aBC");
  assert.equal(plural("order"), "orders");
  assert.equal(plural("Orders"), "Orders");
  assert.equal(plural("category"), "categories");
  assert.equal(plural("address"), "addresses");
});

test("back relation names for several foreign keys between two models", () => {
  for (const w of ["order", "category", "address", "box", "status"]) assert.equal(singular(plural(w)), w === "status" ? "statu" : w);
  assert.equal(backRelationName("customer", "Orders", "Customers", false), "orders");
  assert.equal(backRelationName("billingCustomer", "Orders", "Customers", false), "billingOrders");
  assert.equal(backRelationName("createdBy", "Items", "Users", false), "createdItems");
  assert.equal(backRelationName("createdByUser", "Items", "User", false), "createdItems");
  assert.equal(backRelationName("approver", "Items", "Users", false), "approverItems");
  assert.equal(backRelationName("primaryContact", "Account", "Contact", true), "primaryAccount");
  assert.equal(backRelationName("By", "Items", "Users", false), "ByItems");
});

test("several audit columns to the same table get readable names on both sides", () => {
  const fk = (col: string) => ({ name: `FK_ITEMS_${col}`, columns: [col], refTable: "USERS", refColumns: ["ID"], onDelete: "RESTRICT" as const, onUpdate: "RESTRICT" as const });
  const p = {
    tables: {
      USERS: { name: "USERS", columns: [{ name: "ID", type: "INTEGER", nullable: false }], primaryKey: { name: "PK_USERS", columns: ["ID"] }, uniques: [], indexes: [], foreignKeys: [] },
      ITEMS: {
        name: "ITEMS",
        columns: [
          { name: "ID", type: "INTEGER", nullable: false },
          { name: "CREATED_BY_ID", type: "INTEGER", nullable: false },
          { name: "UPDATED_BY", type: "INTEGER", nullable: true },
        ],
        primaryKey: { name: "PK_ITEMS", columns: ["ID"] },
        uniques: [],
        indexes: [],
        foreignKeys: [fk("CREATED_BY_ID"), fk("UPDATED_BY")],
      },
    },
  };
  const src = renderSchema(p, { defaultSchema: "S" }).source;
  assert.match(block(src, "Items"), /  createdBy +Users +@relation\("Items_createdBy", fields: \[createdById\], references: \[id\]\)/);
  assert.match(block(src, "Items"), /  updatedByUser +Users\? +@relation\("Items_updatedByUser", fields: \[updatedBy\], references: \[id\]\)/);
  assert.match(block(src, "Users"), /  createdItems +Items\[\] +@relation\("Items_createdBy"\)/);
  assert.match(block(src, "Users"), /  updatedItems +Items\[\] +@relation\("Items_updatedByUser"\)/);
  const c = compileSchema(src);
  assert.deepEqual(diffSchemas(contractToPhysical(c, { defaultSchema: "S" }), p), []);
  // a second pull keeps the names
  assert.equal(renderSchema(p, { existingSource: src, defaultSchema: "S", inScope: () => true }).source, src);
});

test("HANA types map to schema types and @db attributes", () => {
  assert.deepEqual(mapHanaType("NVARCHAR(5000)"), { scalar: "String", raw: "NVARCHAR(5000)" });
  assert.equal(mapHanaType("NVARCHAR(255)").native, "db.NVarChar(255)");
  assert.equal(mapHanaType("DECIMAL(38,10)").native, undefined);
  assert.equal(mapHanaType("DECIMAL(15,2)").native, "db.Decimal(15, 2)");
  assert.equal(mapHanaType("TINYINT").native, "db.TinyInt");
  assert.equal(mapHanaType("BIGINT").scalar, "BigInt");
  assert.equal(mapHanaType("REAL").native, "db.Real");
  assert.equal(mapHanaType("CLOB").native, "db.Clob");
  assert.equal(mapHanaType("BINARY(8)").native, "db.Binary(8)");
  assert.equal(mapHanaType("ST_POINT").scalar, undefined);
});

test("fresh pull: models, relations, keys, defaults and views", () => {
  const r = renderSchema(physical(), { defaultSchema: "SHOP" });
  const src = r.source;
  assert.ok(src.startsWith('datasource db {\n  provider = "hana"\n}\n\n'));
  assert.deepEqual(r.added, ["AuditLog", "Customers", "Orders", "OrderItems", "ActiveCustomers"]);
  assert.match(src, /\/\/ This table has no primary key; the client treats it as read-only.\nmodel AuditLog \{/);
  assert.match(block(src, "Customers"), /^\/\/\/ People who order\nmodel Customers \{/);
  assert.match(src, /  id +Int +@id @default\(autoincrement\(\)\) @map\("ID"\)\n/);
  assert.match(src, /  email +String +@unique @map\("EMAIL"\) @db\.NVarChar\(255\)/);
  assert.match(src, /  isActive +Boolean +@default\(true\) @map\("IS_ACTIVE"\)/);
  assert.match(src, /  createdAt +DateTime +@default\(now\(\)\) @map\("CREATED_AT"\)/);
  assert.match(src, /  location +Unsupported\("ST_GEOMETRY"\)\? @map\("LOCATION"\)/);
  assert.match(src, /  total +Decimal +@default\(0\) @map\("TOTAL"\) @db\.Decimal\(15, 2\)/);
  assert.match(src, /  status +String +@default\("open"\) @map\("STATUS"\) @db\.NVarChar\(20\)/);
  // two FKs between the same pair → named relations on both sides
  assert.match(src, /billingCustomer +Customers\? +@relation\("Orders_billingCustomer", fields: \[billingCustomerId\], references: \[id\], onDelete: SetNull, map: "FK_ORDERS_BILLING"\)/);
  assert.match(src, /customer +Customers +@relation\("Orders_customer", fields: \[customerId\], references: \[id\], onDelete: Cascade, map: "FK_ORDERS_CUSTOMER"\)/);
  assert.match(src, /billingOrders +Orders\[\] +@relation\("Orders_billingCustomer"\)/);
  assert.match(src, /  orders +Orders\[\] +@relation\("Orders_customer"\)/);
  // single FK → unnamed relation; default FK name is not repeated
  assert.match(src, /  order +Orders +@relation\(fields: \[orderId\], references: \[id\]\)\n/);
  assert.match(src, /  orderItems +OrderItems\[\]\n/);
  assert.match(src, /@@id\(\[orderId, lineNo\], map: "ORDER_ITEMS_PK"\)/);
  assert.match(src, /@@index\(\[customerId\]\)\n/);
  assert.match(src, /@@index\(\[status, orderedOn\], map: "ORDERS_BY_STATUS"\)/);
  assert.ok(!/_SYS_/.test(src), "system constraint names are not emitted");
  assert.match(src, /view ActiveCustomers \{\n  id +Int +@map\("ID"\)/);
  assert.deepEqual(r.warnings.length, 1);
  assert.doesNotThrow(() => parseSchema(src));
});

test("round trip: pulled schema compiles and plans no changes, unsupported columns included", () => {
  const p = physical();
  delete p.views;
  const src = renderSchema(p, { defaultSchema: "SHOP" }).source;
  const contract = compileSchema(src);
  const ops = diffSchemas(p, contractToPhysical(contract, { defaultSchema: "SHOP" }));
  // Unsupported(...) columns are kept in the contract (ignoredColumns), so nothing is dropped.
  assert.deepEqual(ops.map((o) => o.description), []);
});

test("one-to-one relations become optional single back fields", () => {
  const p = physical();
  p.tables["PROFILES"] = {
    name: "PROFILES",
    columns: [{ name: "CUSTOMER_ID", type: "INTEGER", nullable: false }, { name: "BIO", type: "NCLOB", nullable: true }],
    primaryKey: { name: "PK_PROFILES", columns: ["CUSTOMER_ID"] },
    uniques: [],
    indexes: [],
    foreignKeys: [{ name: "FK_PROFILES_CUSTOMER_ID", columns: ["CUSTOMER_ID"], refTable: "CUSTOMERS", refColumns: ["ID"], onDelete: "CASCADE", onUpdate: "RESTRICT" }],
  };
  const src = renderSchema(p, { defaultSchema: "SHOP" }).source;
  assert.match(block(src, "Customers"), /  profiles +Profiles\?\n/);
  assert.match(block(src, "Profiles"), /  customer +Customers +@relation\(fields: \[customerId\], references: \[id\], onDelete: Cascade\)/);
});

test("self relations are named", () => {
  const p = {
    tables: {
      CATEGORIES: {
        name: "CATEGORIES",
        columns: [{ name: "ID", type: "INTEGER", nullable: false }, { name: "PARENT_ID", type: "INTEGER", nullable: true }],
        primaryKey: { name: "PK_CATEGORIES", columns: ["ID"] },
        uniques: [],
        indexes: [],
        foreignKeys: [{ name: "FK_CATEGORIES_PARENT_ID", columns: ["PARENT_ID"], refTable: "CATEGORIES", refColumns: ["ID"], onDelete: "RESTRICT" as const, onUpdate: "RESTRICT" as const }],
      },
    },
  };
  const src = renderSchema(p, { defaultSchema: "S" }).source;
  assert.match(src, /parent +Categories\? +@relation\("Categories_parent", fields: \[parentId\], references: \[id\]\)/);
  assert.match(src, /parentCategories +Categories\[\] +@relation\("Categories_parent"\)/);
  assert.doesNotThrow(() => compileSchema(src));
});

const EXISTING = `// Shop schema, maintained by hand.

datasource db {
  provider = "hana"
  url      = env("DATABASE_URL")   // keep this comment
}

generator client {
  provider = "hana-orm-client"
  output   = "./generated"
}

enum OrderStatus {
  OPEN    @map("open")
  CLOSED  @map("closed")
}

/// A shop customer.
model Client {
  id       Int      @id @default(autoincrement()) @map("ID")
  /// Login e-mail.
  mail     String   @unique @map("EMAIL") @db.NVarChar(255)
  purchases Orders[] @relation("Orders_customer")
  billed    Orders[] @relation("Orders_billingCustomer")
  createdAt DateTime @default(now()) @map("CREATED_AT")

  @@map("CUSTOMERS")
}

model Orders {
  id                BigInt      @id @map("ID")
  customerId        Int         @map("CUSTOMER_ID")
  billingCustomerId Int?        @map("BILLING_CUSTOMER_ID")
  status            OrderStatus @default(OPEN) @map("STATUS") @db.NVarChar(20)
  buyer             Client      @relation("Orders_customer", fields: [customerId], references: [id], onDelete: Cascade, map: "FK_ORDERS_CUSTOMER")
  payer             Client?     @relation("Orders_billingCustomer", fields: [billingCustomerId], references: [id], onDelete: SetNull, map: "FK_ORDERS_BILLING")
  updatedAt         DateTime    @updatedAt @map("UPDATED_AT")
  token             String      @default(uuid()) @map("TOKEN")

  @@map("ORDERS")
}

model Planned {
  id Int @id
  @@map("PLANNED_TABLE")
}
`;

test("re-pull keeps config blocks, enums, custom names, relation names and docs", () => {
  const p = physical();
  p.tables["ORDERS"]!.columns.push({ name: "UPDATED_AT", type: "TIMESTAMP", nullable: false }, { name: "TOKEN", type: "NVARCHAR(5000)", nullable: false });
  const r = renderSchema(p, { existingSource: EXISTING, defaultSchema: "SHOP", inScope: () => true });
  const src = r.source;
  assert.ok(src.startsWith("// Shop schema, maintained by hand.\n\ndatasource db {\n  provider = \"hana\"\n  url      = env(\"DATABASE_URL\")   // keep this comment\n}\n\ngenerator client {"));
  assert.match(src, /enum OrderStatus \{\n  OPEN    @map\("open"\)/);
  const client = block(src, "Client");
  // `///` is the table comment: the database's comment wins over the old doc
  assert.match(client, /^\/\/\/ People who order\nmodel Client \{/);
  assert.match(client, /  \/\/\/ Login e-mail\.\n  mail +String +@unique @map\("EMAIL"\) @db\.NVarChar\(255\)/);
  assert.match(client, /  purchases +Orders\[\] +@relation\("Orders_customer"\)/);
  assert.match(client, /  billed +Orders\[\] +@relation\("Orders_billingCustomer"\)/);
  assert.match(client, /  displayName +String\? +@map\("DISPLAY_NAME"\)/, "new columns are added");
  const orders = block(src, "Orders");
  assert.match(orders, /  status +OrderStatus +@default\(OPEN\) @map\("STATUS"\) @db\.NVarChar\(20\)/);
  assert.match(orders, /  buyer +Client +@relation\("Orders_customer", fields: \[customerId\]/);
  assert.match(orders, /  payer +Client\? +@relation\("Orders_billingCustomer", fields: \[billingCustomerId\]/);
  assert.match(orders, /  updatedAt +DateTime +@updatedAt @map\("UPDATED_AT"\)/);
  assert.match(orders, /  token +String +@default\(uuid\(\)\) @map\("TOKEN"\)/);
  assert.ok(src.includes("model Planned {\n  id Int @id\n  @@map(\"PLANNED_TABLE\")\n}"), "unknown models are kept verbatim");
  assert.match(r.warnings.join("\n"), /Model 'Planned' maps to 'PLANNED_TABLE', which was not found/);
  assert.deepEqual(r.updated, ["Client", "Orders"]);
  assert.ok(!r.added.includes("Customers"));
  assert.doesNotThrow(() => parseSchema(src));

  // pulling again is stable
  const again = renderSchema(p, { existingSource: src, defaultSchema: "SHOP" }).source;
  assert.equal(again, src);
});

test("re-pull is stable for unnamed relations with a custom FK name (map: is not a relation name)", () => {
  const p = physical();
  p.tables["ORDER_ITEMS"]!.foreignKeys[0]!.name = "FK_ITEMS_ORDER";
  const first = renderSchema(p, { defaultSchema: "SHOP" }).source;
  assert.match(first, /order +Orders +@relation\(fields: \[orderId\], references: \[id\], map: "FK_ITEMS_ORDER"\)/);
  assert.equal(renderSchema(p, { existingSource: first, defaultSchema: "SHOP" }).source, first);
});

test("models outside a filtered pull are kept unchanged", () => {
  const p = buildPhysicalFromCatalog(shopCatalog(), { schema: "SHOP", defaultSchema: "SHOP", filter: (n) => n === "AUDIT_LOG" });
  const r = renderSchema(p, { existingSource: EXISTING, defaultSchema: "SHOP", inScope: (k) => k === "AUDIT_LOG" });
  assert.ok(r.source.includes(block(EXISTING, "Client")));
  assert.ok(r.source.includes(block(EXISTING, "Orders")));
  assert.deepEqual(r.added, ["AuditLog"]);
  assert.equal(r.warnings.filter((w) => w.includes("not found")).length, 0);
});

test("tables from another schema get @@schema and a prefixed name on collision", () => {
  const p = buildPhysicalFromCatalog(shopCatalog(), { schema: "SHOP", defaultSchema: "APP", filter: (n) => n === "AUDIT_LOG" });
  const existing = 'datasource db {\n  provider = "hana"\n}\n\nmodel AuditLog {\n  id Int @id\n  @@map("AUDIT_LOG")\n}\n';
  const src = renderSchema(p, { existingSource: existing, defaultSchema: "APP" }).source;
  assert.match(src, /model ShopAuditLog \{[\s\S]*@@map\("AUDIT_LOG"\)\n  @@schema\("SHOP"\)\n\}/);
});

test("splitBlocks keeps leading comments and ignores braces in strings and comments", () => {
  const s = splitBlocks('// header\n\n// about db\ndatasource db {\n  url = "a{b}"  // }\n}\nmodel A {\n  id Int @id\n}\n');
  assert.equal(s.preamble, "// header");
  assert.deepEqual(s.blocks.map((b) => [b.keyword, b.name]), [["datasource", "db"], ["model", "A"]]);
  assert.equal(s.blocks[0]!.text, '// about db\ndatasource db {\n  url = "a{b}"  // }\n}');
});
