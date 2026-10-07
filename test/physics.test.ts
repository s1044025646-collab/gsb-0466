import { test } from "node:test";
import assert from "node:assert/strict";
import { solve, forwardQuery, DEFAULT_TOLERANCES } from "../src/physics";

const TOL_ANGLE = 1e-9;

test("known case: v=10 g=10 target (8,0) gives two solutions", () => {
  const r = solve({ v: 10, g: 10, x: 8, h: 0 });
  assert.equal(r.status, "two_solutions");
  assert.equal(r.candidates.length, 2);
  // sorted ascending by angle
  assert.ok(r.candidates[0].angleDeg < r.candidates[1].angleDeg);
  assert.ok(Math.abs(r.candidates[0].u - 0.5) < 1e-12);
  assert.ok(Math.abs(r.candidates[1].u - 2) < 1e-12);
  assert.ok(Math.abs(r.candidates[0].angleDeg - 26.56505118) < 1e-6);
  assert.ok(Math.abs(r.candidates[1].angleDeg - 63.43494882) < 1e-6);
  for (const c of r.candidates) {
    assert.ok(c.flightTime > 0);
    assert.ok(c.residualNorm < 1e-9);
  }
});

test("known case: target (10,0) is the 45-degree tangent solution", () => {
  const r = solve({ v: 10, g: 10, x: 10, h: 0 });
  assert.equal(r.status, "one_solution");
  assert.equal(r.candidates.length, 1);
  assert.ok(Math.abs(r.candidates[0].angleDeg - 45) < 1e-9);
  assert.ok(Math.abs(r.candidates[0].flightTime - Math.SQRT2) < 1e-12);
});

test("known case: target (11,0) is unreachable", () => {
  const r = solve({ v: 10, g: 10, x: 11, h: 0 });
  assert.equal(r.status, "unreachable");
  assert.equal(r.candidates.length, 0);
  assert.ok(r.discriminant < 0);
});

test("target above launch point", () => {
  const r = solve({ v: 10, g: 10, x: 6, h: 2 });
  assert.equal(r.status, "two_solutions");
  for (const c of r.candidates) {
    assert.ok(Math.abs(c.arrivalY - 2) < 1e-9);
    assert.ok(c.residualNorm < 1e-9);
  }
});

test("target below launch point (no ground clamping)", () => {
  const r = solve({ v: 10, g: 10, x: 6, h: -3 });
  assert.equal(r.status, "two_solutions");
  for (const c of r.candidates) {
    assert.ok(Math.abs(c.arrivalY - -3) < 1e-9);
    assert.ok(c.residualNorm < 1e-9);
  }
});

test("near-flat shot: h close to -A keeps the near-zero root accurate", () => {
  // A = g x^2 / (2 v^2) = 10*64/200 = 3.2; h = -A + eps
  const eps = 1e-10;
  const r = solve({ v: 10, g: 10, x: 8, h: -3.2 + eps });
  assert.equal(r.status, "two_solutions");
  const small = r.candidates[0];
  assert.ok(Math.abs(small.u) < 1e-4, `expected near-zero root, got ${small.u}`);
  // residual must still verify against the true equations of motion
  for (const c of r.candidates) assert.ok(c.residualNorm < 1e-6);
});

test("small positive x", () => {
  const r = solve({ v: 5, g: 9.81, x: 1e-3, h: 0 });
  assert.equal(r.status, "two_solutions");
  for (const c of r.candidates) assert.ok(c.residualNorm < 1e-9);
});

test("discriminant boundary: tiny negative within tolerance treated as tangent", () => {
  // x = 10 is exactly D=0 for v=10,g=10,h=0. Nudge x slightly above range.
  const rExact = solve({ v: 10, g: 10, x: 10, h: 0 });
  assert.equal(rExact.status, "one_solution");
  // slightly beyond range but within float tolerance of D=0
  const rTiny = solve({ v: 10, g: 10, x: 10 * (1 + 1e-15), h: 0 });
  assert.equal(rTiny.status, "one_solution");
  // clearly beyond range stays unreachable (not clamped to boundary)
  const rFar = solve({ v: 10, g: 10, x: 10.0001, h: 0 });
  assert.equal(rFar.status, "unreachable");
});

test("candidate dedupe: repeated root collapses to one", () => {
  const r = solve({ v: 10, g: 10, x: 10, h: 0 });
  assert.equal(r.candidates.length, 1);
});

test("sample count changes sampling only, not angles/times/status", () => {
  const a = solve({ v: 10, g: 10, x: 8, h: 0 }, DEFAULT_TOLERANCES, 8);
  const b = solve({ v: 10, g: 10, x: 8, h: 0 }, DEFAULT_TOLERANCES, 256);
  assert.equal(a.status, b.status);
  assert.equal(a.candidates.length, b.candidates.length);
  for (let i = 0; i < a.candidates.length; i++) {
    assert.equal(a.candidates[i].angleDeg, b.candidates[i].angleDeg);
    assert.equal(a.candidates[i].flightTime, b.candidates[i].flightTime);
    assert.equal(a.candidates[i].samples.length, 8);
    assert.equal(b.candidates[i].samples.length, 256);
    // endpoints included
    const s = b.candidates[i].samples;
    assert.equal(s[0].t, 0);
    assert.ok(Math.abs(s[s.length - 1].t - b.candidates[i].flightTime) < 1e-15);
  }
});

test("energy per unit mass is conserved along samples (independent check)", () => {
  const r = solve({ v: 12, g: 9.81, x: 7, h: -2 }, DEFAULT_TOLERANCES, 200);
  assert.equal(r.status, "two_solutions");
  for (const c of r.candidates) {
    const e0 = (12 * 12) / 2;
    for (const s of c.samples) {
      const e = (s.vx * s.vx + s.vy * s.vy) / 2 + 9.81 * s.y;
      assert.ok(Math.abs(e - e0) < 1e-8);
    }
    assert.ok(c.energyMaxAbsError < 1e-8);
  }
});

test("apex is clamped to flight interval (endpoint cases)", () => {
  // downward throw reaching target while still descending past vertex? use
  // shallow fast shot: vertex time beyond arrival -> apex at arrival endpoint
  const r = solve({ v: 100, g: 10, x: 5, h: 4.9 });
  assert.equal(r.status, "two_solutions");
  const flat = r.candidates[0]; // nearly flat, still rising at arrival
  assert.ok(flat.apex.source === "endpoint");
  assert.ok(Math.abs(flat.apex.t - flat.flightTime) < 1e-15);
  // steep lob reaches its interior vertex
  const steep = r.candidates[1];
  assert.ok(steep.apex.source === "interior");
  // apex is the max y over the samples for the interior case
  const maxSampleY = Math.max(...steep.samples.map((s) => s.y));
  assert.ok(steep.apex.y >= maxSampleY - 1e-6);
});

test("invalid inputs produce numeric_error, never NaN in report", () => {
  for (const inp of [
    { v: 0, g: 10, x: 1, h: 0 },
    { v: -1, g: 10, x: 1, h: 0 },
    { v: 10, g: 0, x: 1, h: 0 },
    { v: 10, g: 10, x: 0, h: 0 },
    { v: 10, g: 10, x: -1, h: 0 },
    { v: NaN, g: 10, x: 1, h: 0 },
    { v: 10, g: 10, x: 1, h: Infinity },
    { v: 1e9, g: 10, x: 1, h: 0 },
  ]) {
    const r = solve(inp);
    assert.equal(r.status, "numeric_error", JSON.stringify(inp));
    assert.equal(r.candidates.length, 0);
    assert.ok(!JSON.stringify(r).includes("NaN"));
    assert.ok(!JSON.stringify(r).includes("Infinity"));
  }
});

test("forward query at a solution angle hits the target", () => {
  const r = solve({ v: 10, g: 10, x: 8, h: 0 });
  const angle = r.candidates[0].angleDeg;
  const q = forwardQuery({ v: 10, g: 10, x: 8, h: 0 }, angle);
  assert.ok(q.ok);
  if (q.ok) {
    assert.ok(Math.abs(q.missY) < 1e-9);
    assert.ok(q.arrivalTimeAtTargetX > 0);
  }
  const bad = forwardQuery({ v: 10, g: 10, x: 8, h: 0 }, 90);
  assert.ok(!bad.ok);
});
