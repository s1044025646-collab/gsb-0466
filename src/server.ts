import * as http from "node:http";
import { CaseStore } from "./db";
import { solve, positionAt, InputError, LIMITS, DEFAULT_TOLERANCES } from "./physics";

function send(res: http.ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(text);
}

function sendError(res: http.ServerResponse, code: number, errCode: string, message: string): void {
  send(res, code, { error: { code: errCode, message } });
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new InputError("BAD_JSON", "请求体不是合法 JSON");
  }
}

function num(body: any, key: string, required = true): number {
  const val = body?.[key];
  if (val === undefined || val === null) {
    if (required) throw new InputError("MISSING_PARAM", `缺少参数 ${key}`);
    return undefined as unknown as number;
  }
  const n = Number(val);
  if (Number.isNaN(n)) throw new InputError("NAN_INPUT", `参数 ${key} 不是数字`);
  return n;
}

export function createServer(store: CaseStore): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      const method = req.method ?? "GET";

      if (method === "POST" && path === "/api/cases") {
        const body = await readBody(req);
        const v = num(body, "v");
        const g = num(body, "g");
        const x = num(body, "x");
        const h = num(body, "h");
        const samples = body.samples === undefined ? LIMITS.defaultSamples : num(body, "samples");
        const absTol = body.absTol === undefined ? DEFAULT_TOLERANCES.absTol : num(body, "absTol");
        const relTol = body.relTol === undefined ? DEFAULT_TOLERANCES.relTol : num(body, "relTol");
        const result = solve(v, g, x, h, samples, { absTol, relTol });
        if (result.status === "NUMERIC_FAILURE") {
          sendError(res, 422, "NUMERIC_FAILURE", "数值范围导致无法可靠求解，未保存报告");
          return;
        }
        const { row, created } = store.save(result, samples);
        send(res, created ? 201 : 200, { id: row.id, created, status: row.status, report: row.report });
        return;
      }

      if (method === "GET" && path === "/api/cases") {
        send(res, 200, { cases: store.list() });
        return;
      }

      const caseMatch = path.match(/^\/api\/cases\/(\d+)(\/(discriminant|compare|export))?$/);
      if (method === "GET" && caseMatch) {
        const id = Number(caseMatch[1]);
        const row = store.get(id);
        if (!row) {
          sendError(res, 404, "NOT_FOUND", `工况 ${id} 不存在`);
          return;
        }
        const sub = caseMatch[3];
        if (!sub) {
          send(res, 200, { id: row.id, createdAt: row.createdAt, status: row.status, report: row.report });
          return;
        }
        if (sub === "discriminant") {
          send(res, 200, { id: row.id, discriminant: row.report.discriminant, diagnostics: row.report.diagnostics });
          return;
        }
        if (sub === "compare") {
          const cands = row.report.candidates;
          if (cands.length < 2) {
            sendError(res, 409, "NOT_COMPARABLE", "该工况不足两条候选轨迹");
            return;
          }
          const [a, b] = cands;
          send(res, 200, {
            id: row.id,
            low: { thetaDeg: a.thetaDeg, time: a.time, apex: a.apex, vEnd: a.vEnd },
            high: { thetaDeg: b.thetaDeg, time: b.time, apex: b.apex, vEnd: b.vEnd },
            diff: {
              thetaDeg: b.thetaDeg - a.thetaDeg,
              time: b.time - a.time,
              apexY: b.apex.y - a.apex.y,
            },
          });
          return;
        }
        if (sub === "export") {
          const lines = ["candidate,theta_deg,t,x,y,vx,vy,energy"];
          row.report.candidates.forEach((cand, idx) => {
            for (const p of cand.samples) {
              lines.push([idx, cand.thetaDeg, p.t, p.x, p.y, p.vx, p.vy, p.energy].join(","));
            }
          });
          res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8" });
          res.end(lines.join("\n") + "\n");
          return;
        }
      }

      if (method === "POST" && path === "/api/position") {
        const body = await readBody(req);
        const result = positionAt(num(body, "v"), num(body, "g"), num(body, "thetaDeg"), num(body, "t"));
        send(res, 200, result);
        return;
      }

      sendError(res, 404, "NOT_FOUND", "路由不存在");
    } catch (err) {
      if (err instanceof InputError) {
        sendError(res, 400, err.code, err.message);
      } else {
        sendError(res, 500, "INTERNAL", String(err));
      }
    }
  });
}

export function startServer(port = 0, dbPath?: string): Promise<{ server: http.Server; port: number }> {
  const store = new CaseStore(dbPath);
  const server = createServer(store);
  return new Promise((resolve) => {
    server.listen(port, () => {
      const addr = server.address();
      const actual = typeof addr === "object" && addr ? addr.port : port;
      resolve({ server, port: actual });
    });
  });
}

if (require.main === module) {
  const portArg = process.argv.find((a) => a.startsWith("--port="));
  const port = portArg ? Number(portArg.split("=")[1]) : 0;
  startServer(port).then(({ port }) => {
    console.log(`抛球计算服务已启动: http://localhost:${port}`);
  });
}
