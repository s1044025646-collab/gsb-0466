import { test } from "node:test";
import assert from "node:assert/strict";
import { CaseStore } from "../src/db";
import { solve } from "../src/physics";

test("幂等保存: 重复请求返回同一行", () => {
  const store = new CaseStore(":memory:");
  const r = solve(10, 10, 8, 0);
  const a = store.save(r, 64);
  const b = store.save(r, 64);
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(a.row.id, b.row.id);
  assert.equal(store.list().length, 1);
  store.close();
});

test("修改输入产生新报告", () => {
  const store = new CaseStore(":memory:");
  store.save(solve(10, 10, 8, 0), 64);
  const b = store.save(solve(10, 10, 9, 0), 64);
  assert.equal(b.created, true);
  assert.equal(store.list().length, 2);
  store.close();
});

test("不可达结果可保存, 数值失败不保存(由调用方控制)", () => {
  const store = new CaseStore(":memory:");
  const un = store.save(solve(10, 10, 11, 0), 64);
  assert.equal(un.row.status, "UNREACHABLE");
  store.close();
});

test("重启后可查询历史报告与残差", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const os = require("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cases-"));
  const file = path.join(dir, "t.db");
  let store = new CaseStore(file);
  const saved = store.save(solve(10, 10, 8, 0), 64);
  store.close();
  store = new CaseStore(file);
  const row = store.get(saved.row.id);
  assert.ok(row);
  assert.equal(row!.status, "TWO_SOLUTIONS");
  assert.ok(row!.report.candidates[0].residual.abs < 1e-9);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
