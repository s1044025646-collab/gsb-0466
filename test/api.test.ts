import { test } from "node:test";
import assert from "node:assert/strict";
import { CaseStore } from "../src/db";
import { startServer } from "../src/server";

test("store: idempotent create and frozen report", () => {
  const store = new CaseStore(":memory:");
  const a = store.createCase({ v: 10, g: 10, x: 8, h: 0 });
  const b = store.createCase({ v: 10, g: 10, x: 8, h: 0 });
  assert.equal(a.reused, false);
  assert.equal(b.reused, true);
  assert.equal(a.stored.id, b.stored.id);
  // changing input creates a new report
  const c = store.createCase({ v: 10, g: 10, x: 9, h: 0 });
  assert.notEqual(c.stored.id, a.stored.id);
  // failed case does not corrupt history
  const before = store.listCases().length;
  const bad = store.createCase({ v: -1, g: 10, x: 1, h: 0 });
  assert.equal(bad.stored.status, "numeric_error");
  assert.equal(store.listCases().length, before + 1);
  const good = store.getCase(a.stored.id);
  assert.equal(good?.status, "two_solutions");
  assert.equal(good?.report.candidates.length, 2);
  store.close();
});

test("api: create, query, compare, export, errors", async () => {
  const store = new CaseStore(":memory:");
  const { server, port } = await startServer(store, 0);
  const base = `http://127.0.0.1:${port}`;
  try {
    // create
    let res = await fetch(`${base}/api/cases`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ v: 10, g: 10, x: 8, h: 0 }),
    });
    assert.equal(res.status, 201);
    const created = (await res.json()) as { id: number; status: string };
    assert.equal(created.status, "two_solutions");

    // idempotent re-create
    res = await fetch(`${base}/api/cases`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ v: 10, g: 10, x: 8, h: 0 }),
    });
    assert.equal(res.status, 200);
    const again = (await res.json()) as { id: number; reused: boolean };
    assert.equal(again.id, created.id);
    assert.equal(again.reused, true);

    // get
    res = await fetch(`${base}/api/cases/${created.id}`);
    assert.equal(res.status, 200);

    // position
    res = await fetch(`${base}/api/cases/${created.id}/position?angle=26.56505117707799`);
    assert.equal(res.status, 200);
    const pos = (await res.json()) as { missY: number };
    assert.ok(Math.abs(pos.missY) < 1e-6);

    // discriminant
    res = await fetch(`${base}/api/cases/${created.id}/discriminant`);
    assert.equal(res.status, 200);
    const disc = (await res.json()) as { discriminant: number };
    assert.ok(disc.discriminant > 0);

    // compare
    res = await fetch(`${base}/api/cases/${created.id}/compare`);
    assert.equal(res.status, 200);
    const cmp = (await res.json()) as { candidates: unknown[]; delta: { angleDeg: number } };
    assert.equal(cmp.candidates.length, 2);
    assert.ok(cmp.delta.angleDeg > 0);

    // export csv
    res = await fetch(`${base}/api/cases/${created.id}/export?format=csv`);
    assert.equal(res.status, 200);
    const csv = await res.text();
    assert.ok(csv.startsWith("candidate,angle_deg,t,x,y,vx,vy,energy"));

    // invalid input -> 422 numeric error or 400
    res = await fetch(`${base}/api/cases`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ v: -1, g: 10, x: 1, h: 0 }),
    });
    assert.equal(res.status, 422);
    const err = (await res.json()) as { error: { code: string } };
    assert.equal(err.error.code, "NUMERIC_ERROR");

    res = await fetch(`${base}/api/cases`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    assert.equal(res.status, 400);

    // not found
    res = await fetch(`${base}/api/cases/9999`);
    assert.equal(res.status, 404);

    // unreachable is a valid stored result
    res = await fetch(`${base}/api/cases`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ v: 10, g: 10, x: 11, h: 0 }),
    });
    assert.equal(res.status, 201);
    const un = (await res.json()) as { status: string };
    assert.equal(un.status, "unreachable");
  } finally {
    server.close();
    store.close();
  }
});
