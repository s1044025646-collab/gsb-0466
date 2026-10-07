export const ALGO_VERSION = "1.0.0";

export const LIMITS = {
  maxSpeed: 1e6,
  maxGravity: 1e4,
  maxAbsX: 1e9,
  maxAbsH: 1e9,
  minSamples: 2,
  maxSamples: 4096,
  defaultSamples: 64,
} as const;

export interface Tolerances {
  absTol: number;
  relTol: number;
}

export const DEFAULT_TOLERANCES: Tolerances = { absTol: 1e-12, relTol: 1e-12 };

export type SolveStatus =
  | "TWO_SOLUTIONS"
  | "ONE_SOLUTION"
  | "UNREACHABLE"
  | "NUMERIC_FAILURE";

export class InputError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "InputError";
  }
}

export interface SamplePoint {
  t: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  energy: number;
}

export interface Candidate {
  thetaDeg: number;
  thetaRad: number;
  u: number;
  time: number;
  hit: { x: number; y: number };
  residual: { x: number; y: number; abs: number };
  v0: { vx: number; vy: number };
  vEnd: { vx: number; vy: number };
  apex: { t: number; y: number; source: "interior" | "start" | "end" };
  energy: { initial: number; maxAbsError: number };
  samples: SamplePoint[];
}

export interface DiscriminantInfo {
  A: number;
  rawD: number;
  scale: number;
  absTol: number;
  relTol: number;
  tolerance: number;
  effectiveD: number;
  note: string;
}

export interface SolveResult {
  status: SolveStatus;
  algoVersion: string;
  input: { v: number; g: number; x: number; h: number };
  tolerances: Tolerances;
  discriminant: DiscriminantInfo;
  candidates: Candidate[];
  diagnostics: string[];
}

function assertFinite(name: string, value: number): void {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new InputError("NAN_INPUT", `${name} 为 NaN`);
  }
  if (!Number.isFinite(value)) {
    throw new InputError("NON_FINITE", `${name} 非有限数`);
  }
}

export function validateInput(v: number, g: number, x: number, h: number): void {
  assertFinite("v", v);
  assertFinite("g", g);
  assertFinite("x", x);
  assertFinite("h", h);
  if (v <= 0) throw new InputError("INVALID_V", "v 必须为正");
  if (g <= 0) throw new InputError("INVALID_G", "g 必须为正");
  if (x <= 0) throw new InputError("INVALID_X", "x 必须严格为正");
  if (v > LIMITS.maxSpeed) throw new InputError("OUT_OF_RANGE", `v 超过上限 ${LIMITS.maxSpeed}`);
  if (g > LIMITS.maxGravity) throw new InputError("OUT_OF_RANGE", `g 超过上限 ${LIMITS.maxGravity}`);
  if (x > LIMITS.maxAbsX) throw new InputError("OUT_OF_RANGE", `x 超过上限 ${LIMITS.maxAbsX}`);
  if (Math.abs(h) > LIMITS.maxAbsH) throw new InputError("OUT_OF_RANGE", `|h| 超过上限 ${LIMITS.maxAbsH}`);
}

export function positionAt(v: number, g: number, thetaDeg: number, t: number) {
  assertFinite("v", v);
  assertFinite("g", g);
  assertFinite("thetaDeg", thetaDeg);
  assertFinite("t", t);
  if (v <= 0) throw new InputError("INVALID_V", "v 必须为正");
  if (g <= 0) throw new InputError("INVALID_G", "g 必须为正");
  if (thetaDeg <= -90 || thetaDeg >= 90) {
    throw new InputError("INVALID_THETA", "角度必须在 (-90, 90) 度内");
  }
  if (t < 0) throw new InputError("INVALID_T", "t 必须非负");
  const th = (thetaDeg * Math.PI) / 180;
  const vx = v * Math.cos(th);
  const vy0 = v * Math.sin(th);
  const x = vx * t;
  const y = vy0 * t - 0.5 * g * t * t;
  const vy = vy0 - g * t;
  const energy = 0.5 * (vx * vx + vy * vy) + g * y;
  if (![x, y, vy, energy].every(Number.isFinite)) {
    throw new InputError("NON_FINITE", "计算结果非有限");
  }
  return { t, x, y, vx, vy, energy };
}

function buildCandidate(
  v: number,
  g: number,
  x: number,
  h: number,
  u: number,
  sampleCount: number,
  diagnostics: string[]
): Candidate | null {
  const thetaRad = Math.atan(u);
  const thetaDeg = (thetaRad * 180) / Math.PI;
  const cos = Math.cos(thetaRad);
  const sin = Math.sin(thetaRad);
  const vx = v * cos;
  const vy0 = v * sin;
  if (vx <= 0) {
    diagnostics.push(`u=${u} 对应水平速度非正，丢弃`);
    return null;
  }
  const tHit = x / vx;
  if (!(tHit > 0) || !Number.isFinite(tHit)) {
    diagnostics.push(`u=${u} 到达时间非正或非有限，丢弃`);
    return null;
  }
  const hitX = vx * tHit;
  const hitY = vy0 * tHit - 0.5 * g * tHit * tHit;
  if (!Number.isFinite(hitX) || !Number.isFinite(hitY)) {
    diagnostics.push(`u=${u} 回代位置非有限，丢弃`);
    return null;
  }
  const resX = hitX - x;
  const resY = hitY - h;
  const resAbs = Math.hypot(resX, resY);
  const resScale = Math.abs(x) + Math.abs(h) + 1;
  if (!(resAbs <= 1e-6 * resScale)) {
    diagnostics.push(`u=${u} 回代残差 ${resAbs} 过大，候选未通过核验`);
    return null;
  }
  const vyEnd = vy0 - g * tHit;

  // 最高点：竖直速度为零的时刻，限制在 [0, tHit]
  const tApexRaw = vy0 / g;
  let tApex: number;
  let apexSource: Candidate["apex"]["source"];
  if (tApexRaw <= 0) {
    tApex = 0;
    apexSource = "start";
  } else if (tApexRaw >= tHit) {
    tApex = tHit;
    apexSource = "end";
  } else {
    tApex = tApexRaw;
    apexSource = "interior";
  }
  const apexY = vy0 * tApex - 0.5 * g * tApex * tApex + 0;

  const e0 = 0.5 * v * v;
  const samples: SamplePoint[] = [];
  let maxEnergyErr = 0;
  for (let i = 0; i < sampleCount; i++) {
    const t = sampleCount === 1 ? 0 : (tHit * i) / (sampleCount - 1);
    const sx = vx * t;
    const sy = vy0 * t - 0.5 * g * t * t;
    const svy = vy0 - g * t;
    const e = 0.5 * (vx * vx + svy * svy) + g * sy;
    if (![sx, sy, svy, e].every(Number.isFinite)) {
      diagnostics.push(`u=${u} 采样点 ${i} 出现非有限值`);
      return null;
    }
    const err = Math.abs(e - e0);
    if (err > maxEnergyErr) maxEnergyErr = err;
    samples.push({ t, x: sx, y: sy, vx, vy: svy, energy: e });
  }

  return {
    thetaDeg,
    thetaRad,
    u,
    time: tHit,
    hit: { x: hitX, y: hitY },
    residual: { x: resX, y: resY, abs: resAbs },
    v0: { vx, vy: vy0 },
    vEnd: { vx, vy: vyEnd },
    apex: { t: tApex, y: apexY, source: apexSource },
    energy: { initial: e0, maxAbsError: maxEnergyErr },
    samples,
  };
}

export function solve(
  v: number,
  g: number,
  x: number,
  h: number,
  sampleCount: number = LIMITS.defaultSamples,
  tol: Tolerances = DEFAULT_TOLERANCES
): SolveResult {
  validateInput(v, g, x, h);
  if (!Number.isInteger(sampleCount) || sampleCount < LIMITS.minSamples || sampleCount > LIMITS.maxSamples) {
    throw new InputError("INVALID_SAMPLES", `采样数须为 [${LIMITS.minSamples}, ${LIMITS.maxSamples}] 内整数`);
  }
  assertFinite("absTol", tol.absTol);
  assertFinite("relTol", tol.relTol);
  if (tol.absTol < 0 || tol.relTol < 0) throw new InputError("INVALID_TOL", "容差必须非负");

  const diagnostics: string[] = [];
  const A = (g * x * x) / (2 * v * v);
  // A u^2 - x u + (A + h) = 0
  const c = A + h;
  const rawD = x * x - 4 * A * c;
  const scale = x * x + 4 * Math.abs(A) * (Math.abs(A) + Math.abs(h));
  const tolerance = tol.absTol + tol.relTol * scale;

  if (!Number.isFinite(A) || !Number.isFinite(rawD)) {
    return {
      status: "NUMERIC_FAILURE",
      algoVersion: ALGO_VERSION,
      input: { v, g, x, h },
      tolerances: { ...tol },
      discriminant: { A, rawD, scale, absTol: tol.absTol, relTol: tol.relTol, tolerance, effectiveD: rawD, note: "A 或判别式非有限" },
      candidates: [],
      diagnostics: ["中间量非有限，判定为数值失败而非不可达"],
    };
  }

  let effectiveD = rawD;
  let note = "判别式按原值使用";
  if (rawD < 0) {
    if (Math.abs(rawD) <= tolerance) {
      effectiveD = 0;
      note = "判别式微小为负且在容差内，按零处理";
    } else {
      return {
        status: "UNREACHABLE",
        algoVersion: ALGO_VERSION,
        input: { v, g, x, h },
        tolerances: { ...tol },
        discriminant: { A, rawD, scale, absTol: tol.absTol, relTol: tol.relTol, tolerance, effectiveD: rawD, note: "判别式明显为负，目标不可达" },
        candidates: [],
        diagnostics,
      };
    }
  }

  const sqrtD = Math.sqrt(effectiveD);
  // 稳定求根：大根直接算，小根用韦达定理避免相减消去
  const uBig = (x + sqrtD) / (2 * A);
  const uSmall = sqrtD === 0 ? uBig : (2 * c) / (x + sqrtD);
  if (!Number.isFinite(uBig) || !Number.isFinite(uSmall)) {
    return {
      status: "NUMERIC_FAILURE",
      algoVersion: ALGO_VERSION,
      input: { v, g, x, h },
      tolerances: { ...tol },
      discriminant: { A, rawD, scale, absTol: tol.absTol, relTol: tol.relTol, tolerance, effectiveD, note: "根非有限" },
      candidates: [],
      diagnostics: ["求根结果非有限，判定为数值失败"],
    };
  }

  const us: number[] = uBig === uSmall ? [uBig] : [uSmall, uBig];
  const candidates: Candidate[] = [];
  for (const u of us) {
    const cand = buildCandidate(v, g, x, h, u, sampleCount, diagnostics);
    if (cand) candidates.push(cand);
  }
  // 按角度从小到大排序并去重（容差内视为同一方向）
  candidates.sort((a, b) => a.thetaRad - b.thetaRad);
  const deduped: Candidate[] = [];
  for (const cand of candidates) {
    const prev = deduped[deduped.length - 1];
    if (prev && Math.abs(cand.thetaRad - prev.thetaRad) <= 1e-12) {
      diagnostics.push(`角度 ${cand.thetaDeg} 与前一候选重复，已合并`);
      continue;
    }
    deduped.push(cand);
  }

  let status: SolveStatus;
  if (deduped.length === 2) status = "TWO_SOLUTIONS";
  else if (deduped.length === 1) status = "ONE_SOLUTION";
  else status = "NUMERIC_FAILURE";
  if (status === "NUMERIC_FAILURE") {
    diagnostics.push("全部候选未通过回代核验，判定为数值失败");
  }

  return {
    status,
    algoVersion: ALGO_VERSION,
    input: { v, g, x, h },
    tolerances: { ...tol },
    discriminant: { A, rawD, scale, absTol: tol.absTol, relTol: tol.relTol, tolerance, effectiveD, note },
    candidates: deduped,
    diagnostics,
  };
}
