import { CaseStore } from "./db";
import { solve, positionAt, InputError, LIMITS, DEFAULT_TOLERANCES } from "./physics";
import { startServer } from "./server";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) out[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) out[a.slice(2)] = argv[++i];
      else out[a.slice(2)] = "true";
    }
  }
  return out;
}

function numArg(args: Record<string, string>, key: string, required = true): number {
  const raw = args[key];
  if (raw === undefined) {
    if (required) throw new InputError("MISSING_PARAM", `缺少参数 --${key}`);
    return undefined as unknown as number;
  }
  const n = Number(raw);
  if (Number.isNaN(n)) throw new InputError("NAN_INPUT", `--${key} 不是数字`);
  return n;
}

const USAGE = `用法:
  solve --v <速度> --g <重力> --x <横距> --h <高差> [--samples N] [--absTol] [--relTol]
  position --v <> --g <> --thetaDeg <> --t <>
  list
  show <id>
  export <id>
  serve [--port N]   (默认自动选择空闲端口)
`;

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  switch (cmd) {
    case "solve": {
      const v = numArg(args, "v");
      const g = numArg(args, "g");
      const x = numArg(args, "x");
      const h = numArg(args, "h");
      const samples = args.samples ? numArg(args, "samples") : LIMITS.defaultSamples;
      const absTol = args.absTol ? numArg(args, "absTol") : DEFAULT_TOLERANCES.absTol;
      const relTol = args.relTol ? numArg(args, "relTol") : DEFAULT_TOLERANCES.relTol;
      const result = solve(v, g, x, h, samples, { absTol, relTol });
      if (result.status === "NUMERIC_FAILURE") {
        console.error("数值失败，未保存报告");
        console.error(JSON.stringify(result.diagnostics, null, 2));
        process.exitCode = 2;
        return;
      }
      const store = new CaseStore();
      const { row, created } = store.save(result, samples);
      store.close();
      console.log(`工况 #${row.id} (${created ? "新建" : "已存在，幂等返回"}) 状态: ${row.status}`);
      console.log(JSON.stringify(row.report, null, 2));
      return;
    }
    case "position": {
      const r = positionAt(numArg(args, "v"), numArg(args, "g"), numArg(args, "thetaDeg"), numArg(args, "t"));
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    case "list": {
      const store = new CaseStore();
      console.log(JSON.stringify(store.list(), null, 2));
      store.close();
      return;
    }
    case "show": {
      const id = Number(rest[0]);
      const store = new CaseStore();
      const row = store.get(id);
      store.close();
      if (!row) {
        console.error(`工况 ${id} 不存在`);
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify(row, null, 2));
      return;
    }
    case "export": {
      const id = Number(rest[0]);
      const store = new CaseStore();
      const row = store.get(id);
      store.close();
      if (!row) {
        console.error(`工况 ${id} 不存在`);
        process.exitCode = 1;
        return;
      }
      console.log("candidate,theta_deg,t,x,y,vx,vy,energy");
      row.report.candidates.forEach((cand, idx) => {
        for (const p of cand.samples) {
          console.log([idx, cand.thetaDeg, p.t, p.x, p.y, p.vx, p.vy, p.energy].join(","));
        }
      });
      return;
    }
    case "serve": {
      const port = args.port ? Number(args.port) : 0;
      const { port: actual } = await startServer(port);
      console.log(`抛球计算服务已启动: http://localhost:${actual}`);
      return;
    }
    default:
      console.log(USAGE);
      if (cmd) process.exitCode = 1;
  }
}

main().catch((err) => {
  if (err instanceof InputError) {
    console.error(`[${err.code}] ${err.message}`);
  } else {
    console.error(err);
  }
  process.exitCode = 1;
});
