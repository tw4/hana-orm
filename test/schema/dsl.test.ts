/** TypeScript schema definitions (issue #29). */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compileSchema } from "../../src/schema/build.ts";
import { SchemaError } from "../../src/schema/errors.ts";
import {
  bigint,
  boolean,
  createClient,
  dateTime,
  decimal,
  enumColumn,
  env,
  hanaEnum,
  hanaSchema,
  hanaTable,
  int,
  many,
  one,
  relations,
  string,
  tablesOf,
  text,
} from "../../src/schema/dsl.ts";
import { eq } from "../../src/runtime/builder/ops.ts";
import { FakeDriver } from "../runtime/fake-driver.ts";

/** test/fixtures/blog.hana, written in TypeScript. */
export function blogSchema() {
  const Role = hanaEnum("Role", ["USER", { name: "ADMIN", map: "admin" }]);
  const User = hanaTable(
    "User",
    {
      id: int().primaryKey().autoincrement(),
      email: string().unique().db("NVarChar", 320),
      name: string().optional(),
      role: enumColumn(Role).default("USER"),
      balance: decimal(15, 2).default(0),
      visits: bigint().default(0),
      active: boolean().default(true),
      createdAt: dateTime().defaultNow().map("CREATED_AT"),
      updatedAt: dateTime().updatedAt().map("UPDATED_AT"),
    },
    { map: "USERS", doc: "A registered user" },
  );
  const Profile = hanaTable("Profile", { id: string().primaryKey().uuid(), bio: text(), userId: int().unique() });
  const Post = hanaTable(
    "Post",
    { id: int().primaryKey().autoincrement(), title: string(), published: boolean().default(false), authorId: int().optional() },
    { indexes: [{ fields: ["authorId"] }] },
  );
  const Tag = hanaTable("Tag", { name: string().primaryKey() });
  const PostTag = hanaTable("PostTag", { postId: int(), tagName: string() }, { id: { fields: ["postId", "tagName"] } });
  return {
    User,
    Post,
    schema: hanaSchema({
      datasource: { host: env("HANA_HOST"), port: env("HANA_PORT"), user: env("HANA_USER"), password: env("HANA_PASSWORD"), schema: "APP" },
      generators: { client: { output: "./generated" } },
      enums: [Role],
      tables: [User, Profile, Post, Tag, PostTag],
      relations: [
        relations(User, { posts: many(Post), profile: one(Profile, { optional: true }) }),
        relations(Profile, { user: one(User, { fields: ["userId"], references: ["id"], onDelete: "Cascade" }) }),
        relations(Post, { author: one(User, { optional: true, fields: ["authorId"], references: ["id"] }), tags: many(PostTag) }),
        relations(Tag, { posts: many(PostTag) }),
        relations(PostTag, { post: one(Post, { fields: ["postId"], references: ["id"] }), tag: one(Tag, { fields: ["tagName"], references: ["name"] }) }),
      ],
    }),
  };
}

test("the TypeScript schema and the .hana file give identical contracts and hashes", () => {
  const fromHana = compileSchema(readFileSync(new URL("../fixtures/blog.hana", import.meta.url), "utf8"));
  const { schema } = blogSchema();
  assert.equal(schema.contract.hash, fromHana.hash);
  assert.deepEqual(schema.contract, fromHana);
});

test("a TypeScript schema reports problems like a .hana file", () => {
  const A = hanaTable("A", { id: int().primaryKey(), b: int() });
  const B = hanaTable("B", { id: int().primaryKey() });
  assert.throws(
    () => hanaSchema({ tables: [A, B], relations: [relations(A, { other: one(B, { fields: ["nope"], references: ["id"] }) })] }),
    (e: unknown) => e instanceof SchemaError && /nope/.test(e.message),
  );
  assert.throws(() => hanaSchema({ tables: [A], relations: [relations(B, {})] }), /'B' is not in this schema's tables/);
  const C = hanaTable("C", { id: string().autoincrement() });
  assert.throws(() => hanaSchema({ tables: [C] }), /autoincrement\(\) is only valid on Int and BigInt/);
});

test("without a generator: typed builder tables and a client", async () => {
  const { schema } = blogSchema();
  const t = tablesOf(schema);
  const driver = new FakeDriver();
  driver.respond = (q) => (q.startsWith("SELECT") ? [{ email: "a@x", visits: "3" }] : undefined);
  const db = createClient(schema, { driver });
  const rows = await db.select({ email: t.user.email, visits: t.user.visits }).from(t.user).where(eq(t.user.role, "ADMIN"));
  assert.deepEqual(rows, [{ email: "a@x", visits: 3n }]);
  assert.deepEqual(driver.calls[0]!.params, ["admin"]);
  // the object API works too (untyped)
  driver.respond = () => [{ _count: 0 }];
  assert.equal(typeof (await db.user.count()), "number");
});
