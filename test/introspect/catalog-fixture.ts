/** Synthetic catalog rows (shape of SYS.* views) for introspection tests. */

import type { CatalogRows } from "../../src/introspect/catalog.ts";

type Col = [table: string, column: string, type: string, length: number | null, scale: number | null, nullable: boolean, dflt?: string | null, generation?: string | null];

function columns(list: Col[]): CatalogRows["columns"] {
  const pos = new Map<string, number>();
  return list.map(([t, c, type, length, scale, nullable, dflt, gen]) => {
    const p = (pos.get(t) ?? 0) + 1;
    pos.set(t, p);
    return { TABLE_NAME: t, COLUMN_NAME: c, POSITION: p, DATA_TYPE_NAME: type, LENGTH: length, SCALE: scale, IS_NULLABLE: nullable ? "TRUE" : "FALSE", DEFAULT_VALUE: dflt ?? null, GENERATION_TYPE: gen ?? null };
  });
}

export function shopCatalog(): CatalogRows {
  return {
    tables: [{ TABLE_NAME: "CUSTOMERS", COMMENTS: "People who order" }, { TABLE_NAME: "ORDERS" }, { TABLE_NAME: "ORDER_ITEMS" }, { TABLE_NAME: "AUDIT_LOG" }, { TABLE_NAME: "_HANA_ORM_MIGRATIONS" }],
    columns: columns([
      ["CUSTOMERS", "ID", "INTEGER", 10, 0, false, null, "BY DEFAULT AS IDENTITY"],
      ["CUSTOMERS", "EMAIL", "NVARCHAR", 255, null, false],
      ["CUSTOMERS", "DISPLAY_NAME", "NVARCHAR", 5000, null, true],
      ["CUSTOMERS", "IS_ACTIVE", "BOOLEAN", 1, null, false, "TRUE"],
      ["CUSTOMERS", "CREATED_AT", "TIMESTAMP", 27, 7, false, "CURRENT_UTCTIMESTAMP"],
      ["CUSTOMERS", "LOCATION", "ST_GEOMETRY", null, null, true],
      ["ORDERS", "ID", "BIGINT", 19, 0, false],
      ["ORDERS", "CUSTOMER_ID", "INTEGER", 10, 0, false],
      ["ORDERS", "BILLING_CUSTOMER_ID", "INTEGER", 10, 0, true],
      ["ORDERS", "TOTAL", "DECIMAL", 15, 2, false, "0.0"],
      ["ORDERS", "STATUS", "NVARCHAR", 20, null, false, "open"],
      ["ORDERS", "NOTE", "NCLOB", 2147483647, null, true],
      ["ORDERS", "ORDERED_ON", "DATE", 10, null, true],
      ["ORDER_ITEMS", "ORDER_ID", "BIGINT", 19, 0, false],
      ["ORDER_ITEMS", "LINE_NO", "SMALLINT", 5, 0, false],
      ["ORDER_ITEMS", "QTY", "INTEGER", 10, 0, false, "1"],
      ["ORDER_ITEMS", "PRICE", "DECIMAL", 38, 10, false],
      ["AUDIT_LOG", "AT", "SECONDDATE", 20, null, false],
      ["AUDIT_LOG", "PAYLOAD", "VARBINARY", 16, null, true],
      ["_HANA_ORM_MIGRATIONS", "ID", "NVARCHAR", 255, null, false],
    ]),
    constraints: [
      { TABLE_NAME: "CUSTOMERS", CONSTRAINT_NAME: "PK_CUSTOMERS", COLUMN_NAME: "ID", POSITION: 1, IS_PRIMARY_KEY: "TRUE", IS_UNIQUE_KEY: "TRUE" },
      { TABLE_NAME: "CUSTOMERS", CONSTRAINT_NAME: "UQ_CUSTOMERS_EMAIL", COLUMN_NAME: "EMAIL", POSITION: 1, IS_PRIMARY_KEY: "FALSE", IS_UNIQUE_KEY: "TRUE" },
      { TABLE_NAME: "ORDERS", CONSTRAINT_NAME: "_SYS_TREE_CS_#1_#0_#P0", COLUMN_NAME: "ID", POSITION: 1, IS_PRIMARY_KEY: "TRUE", IS_UNIQUE_KEY: "TRUE" },
      { TABLE_NAME: "ORDER_ITEMS", CONSTRAINT_NAME: "ORDER_ITEMS_PK", COLUMN_NAME: "LINE_NO", POSITION: 2, IS_PRIMARY_KEY: "TRUE", IS_UNIQUE_KEY: "TRUE" },
      { TABLE_NAME: "ORDER_ITEMS", CONSTRAINT_NAME: "ORDER_ITEMS_PK", COLUMN_NAME: "ORDER_ID", POSITION: 1, IS_PRIMARY_KEY: "TRUE", IS_UNIQUE_KEY: "TRUE" },
    ],
    foreignKeys: [
      { TABLE_NAME: "ORDERS", CONSTRAINT_NAME: "FK_ORDERS_CUSTOMER", COLUMN_NAME: "CUSTOMER_ID", POSITION: 1, REFERENCED_SCHEMA_NAME: "SHOP", REFERENCED_TABLE_NAME: "CUSTOMERS", REFERENCED_COLUMN_NAME: "ID", DELETE_RULE: "CASCADE", UPDATE_RULE: "RESTRICT" },
      { TABLE_NAME: "ORDERS", CONSTRAINT_NAME: "FK_ORDERS_BILLING", COLUMN_NAME: "BILLING_CUSTOMER_ID", POSITION: 1, REFERENCED_SCHEMA_NAME: "SHOP", REFERENCED_TABLE_NAME: "CUSTOMERS", REFERENCED_COLUMN_NAME: "ID", DELETE_RULE: "SET NULL", UPDATE_RULE: "RESTRICT" },
      { TABLE_NAME: "ORDER_ITEMS", CONSTRAINT_NAME: "FK_ORDER_ITEMS_ORDER_ID", COLUMN_NAME: "ORDER_ID", POSITION: 1, REFERENCED_SCHEMA_NAME: "SHOP", REFERENCED_TABLE_NAME: "ORDERS", REFERENCED_COLUMN_NAME: "ID", DELETE_RULE: "RESTRICT", UPDATE_RULE: "RESTRICT" },
    ],
    indexes: [
      { TABLE_NAME: "ORDERS", INDEX_NAME: "IX_ORDERS_CUSTOMER_ID", COLUMN_NAME: "CUSTOMER_ID", POSITION: 1 },
      { TABLE_NAME: "ORDERS", INDEX_NAME: "ORDERS_BY_STATUS", COLUMN_NAME: "ORDERED_ON", POSITION: 2 },
      { TABLE_NAME: "ORDERS", INDEX_NAME: "ORDERS_BY_STATUS", COLUMN_NAME: "STATUS", POSITION: 1 },
    ],
    views: [{ VIEW_NAME: "ACTIVE_CUSTOMERS" }],
    viewColumns: [
      { VIEW_NAME: "ACTIVE_CUSTOMERS", COLUMN_NAME: "ID", POSITION: 1, DATA_TYPE_NAME: "INTEGER", LENGTH: 10, SCALE: 0, IS_NULLABLE: "FALSE" },
      { VIEW_NAME: "ACTIVE_CUSTOMERS", COLUMN_NAME: "EMAIL", POSITION: 2, DATA_TYPE_NAME: "NVARCHAR", LENGTH: 255, SCALE: null, IS_NULLABLE: "TRUE" },
    ],
  };
}
