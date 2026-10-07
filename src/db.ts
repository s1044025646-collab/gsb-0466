import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ALGO_VERSION, SolveResult, Tolerances, DEFAULT_TOLERANCES } from "./physics";

export interface CaseRow {
  id: number;
  inputHash: string;
  createdAt: string;
  v: number;
  g: number;
  x: number;
  h: number;
  samples: number;
  absTol: number;
  relTol: number;
  algoVersion: string;
  status: string;
  report: SolveResult;
}

export function inputHash(v: number, g: number, x: number, h: number, samples: number, tol: Tolerances): string {
  const canonical = JSON.stringify({ v, g, x, h, samples, absTol: tol.absTol, relTol: tol.relTol, algo: ALGO_VERSION });
  return createHash("sha256").update(canonical).digest("hex");
}

export class CaseStore {
  private db: DatabaseSync;

  constructor(dbPath?: string) {
    const file = dbPath ?? path.join(process.cwd(), "data", "cases.db");
    if (file !== ":memory:") {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    }
    this.db = new DatabaseSync(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        input_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        v REAL NOT NULL,
        g REAL NOT NULL,
        x REAL NOT NULL,
        h REAL NOT NULL,
        samples INTEGER NOT NULL,
        abs_tol REAL NOT NULL,
        rel_tol REAL NOT NULL,
        algo_version TEXT NOT NULL,
        status TEXT NOT NULL,
        report TEXT NOT NULL
      );
    `);
  }

  /** 幂等保存：同一输入哈希只保留一份报告。仅保存成功求解（含不可达）。 */
  save(result: SolveResult, samples: number): { row: CaseRow; created: boolean } {
    const tol = result.tolerances ?? DEFAULT_TOLERANCES;
    const hash = inputHash(result.input.v, result.input.g, result.input.x, result.input.h, samples, tol);
    const existing = this.db.prepare("SELECT * FROM cases WHERE input_hash = ?").get(hash) as any;
    if (existing) {
      return { row: this.toRow(existing), created: false };
    }
    this.db.prepare(
      `INSERT INTO cases (input_hash, created_at, v, g, x, h, samples, abs_tol, rel_tol, algo_version, status, report)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      hash,
      new Date().toISOString(),
      result.input.v,
      result.input.g,
      result.input.x,
      result.input.h,
      samples,
      tol.absTol,
      tol.relTol,
      result.algoVersion,
      result.status,
      JSON.stringify(result)
    );
    const row = this.db.prepare("SELECT * FROM cases WHERE input_hash = ?").get(hash) as any;
    return { row: this.toRow(row), created: true };
  }

  get(id: number): CaseRow | null {
    const row = this.db.prepare("SELECT * FROM cases WHERE id = ?").get(id) as any;
    return row ? this.toRow(row) : null;
  }

  list(limit = 50): Omit<CaseRow, "report">[] {
    const rows = this.db.prepare("SELECT * FROM cases ORDER BY id DESC LIMIT ?").all(limit) as any[];
    return rows.map((r) => {
      const { report, ...rest } = this.toRow(r);
      return rest;
    });
  }

  private toRow(r: any): CaseRow {
    return {
      id: r.id,
      inputHash: r.input_hash,
      createdAt: r.created_at,
      v: r.v,
      g: r.g,
      x: r.x,
      h: r.h,
      samples: r.samples,
      absTol: r.abs_tol,
      relTol: r.rel_tol,
      algoVersion: r.algo_version,
      status: r.status,
      report: JSON.parse(r.report),
    };
  }

  close(): void {
    this.db.close();
  }
}
