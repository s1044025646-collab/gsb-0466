import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../src/server";
import { CaseStore } from "../src/db";
import type { AddressInfo } from "node:net";

let base = "";
let server: ReturnType<typeof createServer>;

before(async () => {
  server = createServer(new CaseStore(":memory:"));
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address() as AddressInfo;
  base = `http://localhost:${addr.port}`;
});

after(() => server.close());

async function post(path: string, body: unknown) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test("API 创建工况并幂等", async () => {
  const a = await post("/api/cases", { v: 10, g: 10, x: 8, h: 0 });
  assert.equal(a.status, 201);
  assert.equal(a.body.status, "TWO_SOLUTIONS");
  const b = await post("/api/cases", { v: 10, g: 10, x: 8, h: 0 });
  assert.equal(b.status, 200);
  assert.equal(b.body.id, a.body.id);
  assert.equal(b.body.created, false);
});

test("API 非法输入返回错误码", async () => {
  const r = await post("/api/cases", { v: -1, g: 10, x: 8, h: 0 });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, "INVALID_V");
  const r2 = await post("/api/cases", { v: 10, g: 10, h: 0 });
  assert.equal(r2.body.error.code, "MISSING_PARAM");
});

test("API 查询/判别式/比较/导出", async () => {
  const created = await post("/api/cases", { v: 10, g: 10, x: 8, h: 0 });
  const id = created.body.id;
  const got = await (await fetch(`${base}/api/cases/${id}`)).json();
  assert.equal(got.report.candidates.length, 2);
  const disc = await (await fetch(`${base}/api/cases/${id}/discriminant`)).json();
  assert.ok(disc.discriminant.rawD > 0);
  const cmp = await (await fetch(`${base}/api/cases/${id}/compare`)).json();
  assert.ok(cmp.diff.time > 0);
  const csv = await (await fetch(`${base}/api/cases/${id}/export`)).text();
  assert.ok(csv.startsWith("candidate,theta_deg"));
  assert.ok(csv.split("\n").length > 100);
});

test("API 单解工况比较返回 409", async () => {
  const created = await post("/api/cases", { v: 10, g: 10, x: 10, h: 0 });
  const res = await fetch(`${base}/api/cases/${created.body.id}/compare`);
  assert.equal(res.status, 409);
});

test("API 正向位置查询", async () => {
  const r = await post("/api/position", { v: 10, g: 10, thetaDeg: 45, t: Math.SQRT2 });
  assert.equal(r.status, 200);
  assert.ok(Math.abs(r.body.x - 10) < 1e-9);
});

test("API 列表与不存在的工况", async () => {
  const list = await (await fetch(`${base}/api/cases`)).json();
  assert.ok(Array.isArray(list.cases));
  const res = await fetch(`${base}/api/cases/99999`);
  assert.equal(res.status, 404);
});
