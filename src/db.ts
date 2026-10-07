import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ALGO_VERSION,
  CaseInput,
  CaseStatus,
  DEFAULT_TOLERANCES,
  LIMITS,
  SolveResult,
  Tolerances,
  solve,
} from "./physics";

export interface StoredCase {
  id: number;
  hash: string;
  status: CaseStatus;
  createdAt: string;
  report: SolveResult;
}

export class CaseStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hash TEXT NOT NULL UNIQUE,
        v REAL NOT NULL,
        g REAL NOT NULL,
        x REAL NOT NULL,
        h REAL NOT NULL,
        tol_abs REAL NOT NULL,
        tol_rel REAL NOT NULL,
        sample_count INTEGER NOT NULL,
        algo_version TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        report TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  static hashOf(
    inp: CaseInput,
    tol: Tolerances,
    sampleCount: number
  ): string {
    const payload = JSON.stringify({
      v: inp.v,
      g: inp.g,
      x: inp.x,
      h: inp.h,
      tolAbs: tol.abs,
      tolRel: tol.rel,
      sampleCount,
      algo: ALGO_VERSION,
    });
    return createHash("sha256").update(payload).digest("hex");
  }

  /**
   * Idempotent: identical (input, tolerances, sampleCount, algoVersion)
   * returns the existing frozen report.
   */
  createCase(
    inp: CaseInput,
    tol: Tolerances = DEFAULT_TOLERANCES,
    sampleCount: number = LIMITS.samplesDefault
  ): { stored: StoredCase; reused: boolean } {
    const hash = CaseStore.hashOf(inp, tol, sampleCount);
    const existing = this.db
      .prepare("SELECT * FROM cases WHERE hash = ?")
      .get(hash) as Record<string, unknown> | undefined;
    if (existing) {
      return { stored: rowToCase(existing), reused: true };
    }
    const result = solve(inp, tol, sampleCount);
    // Freeze the full report (all candidates) atomically; failures store
    // no partial candidate list because reports are a single JSON blob.
    const info = this.db
      .prepare(
        `INSERT INTO cases
         (hash, v, g, x, h, tol_abs, tol_rel, sample_count, algo_version, status, created_at, report)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        hash,
        inp.v,
        inp.g,
        inp.x,
        inp.h,
        tol.abs,
        tol.rel,
        sampleCount,
        ALGO_VERSION,
        result.status,
        new Date().toISOString(),
        JSON.stringify(result)
      );
    const row = this.db
      .prepare("SELECT * FROM cases WHERE id = ?")
      .get(Number(info.lastInsertRowid)) as Record<string, unknown>;
    return { stored: rowToCase(row), reused: false };
  }

  getCase(id: number): StoredCase | null {
    const row = this.db.prepare("SELECT * FROM cases WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToCase(row) : null;
  }

  listCases(): StoredCase[] {
    const rows = this.db
      .prepare("SELECT * FROM cases ORDER BY id")
      .all() as Record<string, unknown>[];
    return rows.map(rowToCase);
  }
}

function rowToCase(row: Record<string, unknown>): StoredCase {
  return {
    id: Number(row.id),
    hash: String(row.hash),
    status: String(row.status) as CaseStatus,
    createdAt: String(row.created_at),
    report: JSON.parse(String(row.report)) as SolveResult,
  };
}
