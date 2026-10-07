import * as http from "node:http";
import { CaseStore } from "./db";
import {
  DEFAULT_TOLERANCES,
  LIMITS,
  Tolerances,
  forwardQuery,
} from "./physics";

export type ErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "UNREACHABLE"
  | "NUMERIC_ERROR"
  | "BAD_REQUEST";

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown
): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendError(
  res: http.ServerResponse,
  status: number,
  code: ErrorCode,
  message: string
): void {
  sendJson(res, status, { error: { code, message } });
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function parseTolerances(obj: Record<string, unknown>): Tolerances | null {
  const abs = obj.tolAbs ?? DEFAULT_TOLERANCES.abs;
  const rel = obj.tolRel ?? DEFAULT_TOLERANCES.rel;
  if (
    typeof abs !== "number" ||
    typeof rel !== "number" ||
    !Number.isFinite(abs) ||
    !Number.isFinite(rel) ||
    abs < 0 ||
    rel < 0 ||
    abs > 1e-3 ||
    rel > 1e-3
  ) {
    return null;
  }
  return { abs, rel };
}

function toCsv(report: {
  candidates: { index: number; angleDeg: number; samples: { t: number; x: number; y: number; vx: number; vy: number; energy: number }[] }[];
}): string {
  const lines = ["candidate,angle_deg,t,x,y,vx,vy,energy"];
  for (const c of report.candidates) {
    for (const s of c.samples) {
      lines.push(
        [c.index, c.angleDeg, s.t, s.x, s.y, s.vx, s.vy, s.energy].join(",")
      );
    }
  }
  return lines.join("\n") + "\n";
}

export function createServer(store: CaseStore): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      const method = req.method ?? "GET";

      if (method === "GET" && path === "/api/health") {
        return sendJson(res, 200, { ok: true, limits: LIMITS });
      }

      if (method === "POST" && path === "/api/cases") {
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          return sendError(res, 400, "BAD_REQUEST", "request body must be JSON");
        }
        const { v, g, x, h } = body as Record<string, number>;
        const tol = parseTolerances(body);
        if (!tol) {
          return sendError(
            res,
            400,
            "INVALID_INPUT",
            "tolAbs/tolRel must be finite numbers in [0, 1e-3]"
          );
        }
        const sampleCount = body.samples ?? LIMITS.samplesDefault;
        if (
          typeof sampleCount !== "number" ||
          !Number.isInteger(sampleCount) ||
          sampleCount < LIMITS.samplesMin ||
          sampleCount > LIMITS.samplesMax
        ) {
          return sendError(
            res,
            400,
            "INVALID_INPUT",
            `samples must be an integer in [${LIMITS.samplesMin}, ${LIMITS.samplesMax}]`
          );
        }
        const { stored, reused } = store.createCase({ v, g, x, h }, tol, sampleCount);
        const status = stored.status;
        if (status === "numeric_error") {
          return sendJson(res, 422, {
            id: stored.id,
            reused,
            status,
            error: {
              code: "NUMERIC_ERROR",
              message: stored.report.error ?? "numeric failure",
            },
          });
        }
        return sendJson(res, reused ? 200 : 201, {
          id: stored.id,
          reused,
          status,
          report: stored.report,
        });
      }

      if (method === "GET" && path === "/api/cases") {
        return sendJson(
          res,
          200,
          store.listCases().map((c) => ({
            id: c.id,
            status: c.status,
            createdAt: c.createdAt,
            input: c.report.input,
          }))
        );
      }

      const caseMatch = path.match(/^\/api\/cases\/(\d+)(\/(position|discriminant|compare|export))?$/);
      if (caseMatch && method === "GET") {
        const id = Number(caseMatch[1]);
        const sub = caseMatch[3];
        const stored = store.getCase(id);
        if (!stored) {
          return sendError(res, 404, "NOT_FOUND", `case ${id} not found`);
        }
        const report = stored.report;

        if (!sub) {
          return sendJson(res, 200, {
            id: stored.id,
            status: stored.status,
            createdAt: stored.createdAt,
            report,
          });
        }

        if (sub === "position") {
          const angle = Number(url.searchParams.get("angle"));
          const samplesParam = url.searchParams.get("samples");
          const samples = samplesParam ? Number(samplesParam) : LIMITS.samplesDefault;
          const result = forwardQuery(report.input, angle, samples);
          if (!result.ok) {
            return sendError(res, 400, "INVALID_INPUT", result.error);
          }
          return sendJson(res, 200, { caseId: id, ...result });
        }

        if (sub === "discriminant") {
          return sendJson(res, 200, {
            caseId: id,
            status: stored.status,
            A: report.A,
            equation: "A*u^2 - x*u + (A+h) = 0, u = tan(theta)",
            discriminant: report.discriminant,
            discriminantRaw: report.discriminantRaw,
            discriminantScale: report.discriminantScale,
            tolerances: report.tolerances,
            note: report.discriminantNote,
          });
        }

        if (sub === "compare") {
          if (report.candidates.length < 2) {
            return sendError(
              res,
              400,
              "BAD_REQUEST",
              `case ${id} has ${report.candidates.length} candidate(s); comparison requires two`
            );
          }
          const [a, b] = report.candidates;
          return sendJson(res, 200, {
            caseId: id,
            candidates: report.candidates.map((c) => ({
              index: c.index,
              angleDeg: c.angleDeg,
              flightTime: c.flightTime,
              apex: c.apex,
              residualNorm: c.residualNorm,
              energyMaxAbsError: c.energyMaxAbsError,
            })),
            delta: {
              angleDeg: b.angleDeg - a.angleDeg,
              flightTime: b.flightTime - a.flightTime,
              apexY: b.apex.y - a.apex.y,
            },
          });
        }

        if (sub === "export") {
          const format = url.searchParams.get("format") ?? "json";
          if (format === "csv") {
            const csv = toCsv(report);
            res.writeHead(200, {
              "Content-Type": "text/csv; charset=utf-8",
              "Content-Disposition": `attachment; filename="case-${id}-samples.csv"`,
            });
            return res.end(csv);
          }
          return sendJson(res, 200, {
            caseId: id,
            status: stored.status,
            candidates: report.candidates,
          });
        }
      }

      return sendError(res, 404, "NOT_FOUND", "unknown route");
    } catch (err) {
      return sendError(
        res,
        500,
        "NUMERIC_ERROR",
        err instanceof Error ? err.message : "internal error"
      );
    }
  });
}

export function startServer(
  store: CaseStore,
  port: number
): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer(store);
    server.on("error", reject);
    // port 0 = pick a free port (default behavior)
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : port });
    });
  });
}
