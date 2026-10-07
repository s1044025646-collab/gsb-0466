import { test } from "node:test";
import assert from "node:assert/strict";
import { solve, positionAt, InputError, LIMITS } from "../src/physics";

const TOL = 1e-9;

function throwsCode(fn: () => void, code: string) {
  assert.throws(fn, (err: any) => err instanceof InputError && err.code === code);
}

test("已知案例 v=10 g=10 (8,0) 双解", () => {
  const r = solve(10, 10, 8, 0);
  assert.equal(r.status, "TWO_SOLUTIONS");
  assert.equal(r.candidates.length, 2);
  assert.ok(Math.abs(r.candidates[0].u - 0.5) < TOL);
  assert.ok(Math.abs(r.candidates[1].u - 2) < TOL);
  assert.ok(Math.abs(r.candidates[0].thetaDeg - 26.56505118) < 1e-6);
  assert.ok(Math.abs(r.candidates[1].thetaDeg - 63.43494882) < 1e-6);
  assert.ok(r.candidates[0].thetaDeg < r.candidates[1].thetaDeg);
  for (const c of r.candidates) {
    assert.ok(c.residual.abs < 1e-9);
    assert.ok(c.time > 0);
  }
});

test("已知案例 (10,0) 四十五度单解, 时间 sqrt(2)", () => {
  const r = solve(10, 10, 10, 0);
  assert.equal(r.status, "ONE_SOLUTION");
  assert.equal(r.candidates.length, 1);
  assert.ok(Math.abs(r.candidates[0].thetaDeg - 45) < 1e-9);
  assert.ok(Math.abs(r.candidates[0].time - Math.SQRT2) < 1e-9);
});

test("已知案例 (11,0) 不可达", () => {
  const r = solve(10, 10, 11, 0);
  assert.equal(r.status, "UNREACHABLE");
  assert.equal(r.candidates.length, 0);
  assert.ok(r.discriminant.rawD < 0);
});

test("高于起点的目标", () => {
  const r = solve(10, 10, 5, 3);
  assert.equal(r.status, "TWO_SOLUTIONS");
  for (const c of r.candidates) assert.ok(c.residual.abs < 1e-8);
});

test("低于起点的目标(无地面截停)", () => {
  const r = solve(10, 10, 8, -5);
  assert.equal(r.status, "TWO_SOLUTIONS");
  for (const c of r.candidates) {
    assert.ok(c.residual.abs < 1e-8);
    assert.ok(c.hit.y < 0);
  }
});

test("近平射: h 接近 -A, 一个根接近零且稳定", () => {
  const v = 10, g = 10, x = 8;
  const A = (g * x * x) / (2 * v * v);
  const h = -A * (1 - 1e-10);
  const r = solve(v, g, x, h);
  assert.equal(r.status, "TWO_SOLUTIONS");
  const small = r.candidates[0];
  assert.ok(Math.abs(small.u) < 1e-4, `小根应接近零, 实际 ${small.u}`);
  assert.ok(small.residual.abs < 1e-8);
});

test("小正横距可解", () => {
  const r = solve(10, 10, 1e-3, 0);
  assert.ok(r.status === "TWO_SOLUTIONS" || r.status === "ONE_SOLUTION");
  for (const c of r.candidates) assert.ok(c.residual.abs < 1e-9);
});

test("判别式边界: 微小负值在容差内按零处理", () => {
  const v = 10, g = 10;
  const xMax = (v * v) / g;
  const r0 = solve(v, g, xMax, 0);
  assert.equal(r0.status, "ONE_SOLUTION");
  const A = (g * xMax * xMax) / (2 * v * v);
  const scale = xMax * xMax + 4 * Math.abs(A) * (Math.abs(A) + 1);
  const dh = (1e-13 * scale) / (4 * A);
  const r1 = solve(v, g, xMax, dh);
  assert.equal(r1.status, "ONE_SOLUTION");
  assert.ok(r1.discriminant.rawD < 0);
  const r2 = solve(v, g, xMax, 0.5);
  assert.equal(r2.status, "UNREACHABLE");
});

test("候选去重: 重根只保留一个", () => {
  const r = solve(10, 10, 10, 0);
  assert.equal(r.candidates.length, 1);
});

test("采样数变化不影响角度与时间", () => {
  const a = solve(10, 10, 8, 0, 8);
  const b = solve(10, 10, 8, 0, 256);
  assert.equal(a.candidates.length, b.candidates.length);
  for (let i = 0; i < a.candidates.length; i++) {
    assert.equal(a.candidates[i].thetaDeg, b.candidates[i].thetaDeg);
    assert.equal(a.candidates[i].time, b.candidates[i].time);
    assert.equal(a.candidates[i].samples.length, 8);
    assert.equal(b.candidates[i].samples.length, 256);
    assert.equal(a.candidates[i].samples[0].t, 0);
    assert.ok(Math.abs(a.candidates[i].samples[7].t - a.candidates[i].time) < 1e-15);
  }
});

test("能量沿途守恒(单位质量)", () => {
  const r = solve(10, 10, 8, -3);
  for (const c of r.candidates) {
    assert.ok(c.energy.maxAbsError < 1e-9, `能量误差 ${c.energy.maxAbsError}`);
  }
});

test("最高点: 向下抛时最高点在起点", () => {
  const r = solve(10, 10, 8, -9);
  const downCand = r.candidates.find((c) => c.v0.vy < 0);
  assert.ok(downCand, "应存在向下抛的候选");
  assert.equal(downCand!.apex.source, "start");
  assert.equal(downCand!.apex.t, 0);
  assert.equal(downCand!.apex.y, 0);
});

test("最高点: 目标仍在上升段时最高点在终点", () => {
  const r = solve(10, 10, 0.5, 4);
  const c = r.candidates.find((k) => k.vEnd.vy > 0);
  assert.ok(c, "应存在到达时仍上升的候选");
  assert.equal(c!.apex.source, "end");
  assert.ok(Math.abs(c!.apex.t - c!.time) < 1e-15);
});

test("最高点: 普通情况在途中", () => {
  const r = solve(10, 10, 8, 0);
  assert.equal(r.candidates[1].apex.source, "interior");
  assert.ok(r.candidates[1].apex.y > 0);
});

test("正向查询 positionAt", () => {
  const p = positionAt(10, 10, 45, Math.SQRT2);
  assert.ok(Math.abs(p.x - 10) < 1e-9);
  assert.ok(Math.abs(p.y) < 1e-9);
  throwsCode(() => positionAt(10, 10, 90, 1), "INVALID_THETA");
  throwsCode(() => positionAt(10, 10, 45, -1), "INVALID_T");
});

test("非法输入报错", () => {
  throwsCode(() => solve(0, 10, 1, 0), "INVALID_V");
  throwsCode(() => solve(10, -1, 1, 0), "INVALID_G");
  throwsCode(() => solve(10, 10, 0, 0), "INVALID_X");
  throwsCode(() => solve(10, 10, -1, 0), "INVALID_X");
  throwsCode(() => solve(NaN, 10, 1, 0), "NAN_INPUT");
  throwsCode(() => solve(Infinity, 10, 1, 0), "NON_FINITE");
  throwsCode(() => solve(1e9, 10, 1, 0), "OUT_OF_RANGE");
  throwsCode(() => solve(10, 10, 1, 0, 1), "INVALID_SAMPLES");
});

test("报告中不含 NaN 或 Infinity", () => {
  for (const [x, h] of [[8, 0], [10, 0], [11, 0], [5, 3], [8, -5]] as const) {
    const text = JSON.stringify(solve(10, 10, x, h));
    assert.ok(!text.includes("NaN") && !text.includes("Infinity"), `x=${x} h=${h}`);
  }
});
