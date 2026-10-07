import * as path from "node:path";
import { CaseStore } from "./db";
import { DEFAULT_TOLERANCES, LIMITS, forwardQuery } from "./physics";
import { startServer } from "./server";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = process.env.PROJECTILE_DB ?? path.join(DATA_DIR, "projectile.db");

function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function print(obj: unknown): void {
  console.log(JSON.stringify(obj, null, 2));
}

function summary(store: CaseStore, id: number): void {
  const c = store.getCase(id);
  if (!c) {
    console.error(`case ${id} not found`);
    process.exitCode = 1;
    return;
  }
  print({ id: c.id, status: c.status, createdAt: c.createdAt, report: c.report });
}

const HELP = `projectile-solver CLI

Usage:
  node dist/cli.js solve --v 10 --g 10 --x 8 --h 0 [--samples 64] [--tolAbs 1e-12] [--tolRel 1e-12]
  node dist/cli.js list
  node dist/cli.js show <id>
  node dist/cli.js position <id> --angle 45 [--samples 32]
  node dist/cli.js discriminant <id>
  node dist/cli.js compare <id>
  node dist/cli.js export <id> [--format csv|json]
  node dist/cli.js serve [--port 0]        # port 0 = auto free port (default)
  node dist/cli.js demo

Data directory: ./data (override with PROJECTILE_DB env var)
`;

export async function main(argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  const cmd = positional[0];

  if (!cmd || cmd === "help" || flags.help) {
    console.log(HELP);
    return;
  }

  const store = new CaseStore(DB_PATH);
  try {
    switch (cmd) {
      case "solve": {
        const v = Number(flags.v);
        const g = Number(flags.g);
        const x = Number(flags.x);
        const h = Number(flags.h);
        const samples = flags.samples ? Number(flags.samples) : LIMITS.samplesDefault;
        const tol = {
          abs: flags.tolAbs ? Number(flags.tolAbs) : DEFAULT_TOLERANCES.abs,
          rel: flags.tolRel ? Number(flags.tolRel) : DEFAULT_TOLERANCES.rel,
        };
        const { stored, reused } = store.createCase({ v, g, x, h }, tol, samples);
        print({ id: stored.id, reused, status: stored.status, report: stored.report });
        if (stored.status === "numeric_error") process.exitCode = 2;
        break;
      }
      case "list": {
        print(
          store.listCases().map((c) => ({
            id: c.id,
            status: c.status,
            createdAt: c.createdAt,
            input: c.report.input,
          }))
        );
        break;
      }
      case "show": {
        summary(store, Number(positional[1]));
        break;
      }
      case "position": {
        const c = store.getCase(Number(positional[1]));
        if (!c) throw new Error("case not found");
        const angle = Number(flags.angle);
        const samples = flags.samples ? Number(flags.samples) : LIMITS.samplesDefault;
        print(forwardQuery(c.report.input, angle, samples));
        break;
      }
      case "discriminant": {
        const c = store.getCase(Number(positional[1]));
        if (!c) throw new Error("case not found");
        const r = c.report;
        print({
          id: c.id,
          status: c.status,
          equation: "A*u^2 - x*u + (A+h) = 0, u = tan(theta)",
          A: r.A,
          discriminant: r.discriminant,
          discriminantRaw: r.discriminantRaw,
          discriminantScale: r.discriminantScale,
          tolerances: r.tolerances,
          note: r.discriminantNote,
        });
        break;
      }
      case "compare": {
        const c = store.getCase(Number(positional[1]));
        if (!c) throw new Error("case not found");
        const cands = c.report.candidates;
        if (cands.length < 2) throw new Error(`case has ${cands.length} candidate(s)`);
        print({
          id: c.id,
          candidates: cands.map((k) => ({
            index: k.index,
            angleDeg: k.angleDeg,
            flightTime: k.flightTime,
            apex: k.apex,
            residualNorm: k.residualNorm,
            energyMaxAbsError: k.energyMaxAbsError,
          })),
          delta: {
            angleDeg: cands[1].angleDeg - cands[0].angleDeg,
            flightTime: cands[1].flightTime - cands[0].flightTime,
            apexY: cands[1].apex.y - cands[0].apex.y,
          },
        });
        break;
      }
      case "export": {
        const c = store.getCase(Number(positional[1]));
        if (!c) throw new Error("case not found");
        if (flags.format === "csv") {
          console.log("candidate,angle_deg,t,x,y,vx,vy,energy");
          for (const k of c.report.candidates) {
            for (const s of k.samples) {
              console.log([k.index, k.angleDeg, s.t, s.x, s.y, s.vx, s.vy, s.energy].join(","));
            }
          }
        } else {
          print({ id: c.id, status: c.status, candidates: c.report.candidates });
        }
        break;
      }
      case "serve": {
        const port = flags.port ? Number(flags.port) : 0;
        const { port: actual } = await startServer(store, port);
        console.log(`API listening on http://127.0.0.1:${actual} (db: ${DB_PATH})`);
        return; // keep process alive; do not close store
      }
      case "demo": {
        const cases = [
          { v: 10, g: 10, x: 8, h: 0 },
          { v: 10, g: 10, x: 10, h: 0 },
          { v: 10, g: 10, x: 11, h: 0 },
          { v: 10, g: 10, x: 6, h: 2 },
          { v: 10, g: 10, x: 6, h: -3 },
        ];
        for (const inp of cases) {
          const { stored, reused } = store.createCase(inp);
          const r = stored.report;
          console.log(
            `case #${stored.id} v=${inp.v} g=${inp.g} target=(${inp.x},${inp.h}) ` +
              `-> ${stored.status}${reused ? " (reused)" : ""}`
          );
          for (const k of r.candidates) {
            console.log(
              `  angle=${k.angleDeg.toFixed(8)} deg, t=${k.flightTime.toFixed(8)} s, ` +
                `residual=${k.residualNorm.toExponential(2)}, apex_y=${k.apex.y.toFixed(6)} (${k.apex.source})`
            );
          }
        }
        break;
      }
      default:
        console.error(`unknown command: ${cmd}`);
        console.log(HELP);
        process.exitCode = 1;
    }
  } finally {
    if (cmd !== "serve") store.close();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error("error:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
