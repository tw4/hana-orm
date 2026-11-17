import type { Driver, Queryable } from "../../src/runtime/driver.ts";

export interface Call {
  sql: string;
  params: unknown[];
  tx: boolean;
}

/** Records every statement; `respond` returns rows (query) or a count (execute). */
export class FakeDriver implements Driver {
  calls: Call[] = [];
  transactions = 0;
  rolledBack = 0;
  respond: (sql: string, params: unknown[]) => unknown = () => [];

  private q(tx: boolean): Queryable {
    return {
      query: async <T>(sql: string, params: readonly unknown[] = []) => {
        this.calls.push({ sql, params: [...params], tx });
        const r = this.respond(sql, [...params]);
        return (Array.isArray(r) ? r : []) as T[];
      },
      execute: async (sql: string, params: readonly unknown[] = []) => {
        this.calls.push({ sql, params: [...params], tx });
        const r = this.respond(sql, [...params]);
        return typeof r === "number" ? r : 1;
      },
      executeBatch: async (sql: string, rows: readonly (readonly unknown[])[]) => {
        for (const p of rows) this.calls.push({ sql, params: [...p], tx });
        return rows.length;
      },
    };
  }
  query<T>(sql: string, params?: readonly unknown[]) {
    return this.q(false).query<T>(sql, params);
  }
  execute(sql: string, params?: readonly unknown[]) {
    return this.q(false).execute(sql, params);
  }
  executeBatch(sql: string, rows: readonly (readonly unknown[])[]) {
    return this.q(false).executeBatch(sql, rows);
  }
  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    this.transactions++;
    try {
      return await fn(this.q(true));
    } catch (e) {
      this.rolledBack++;
      throw e;
    }
  }
  async close() {}
}
