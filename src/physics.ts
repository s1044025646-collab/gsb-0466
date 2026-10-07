/**
 * Ideal 2-D projectile solver (point mass, constant gravity, no drag).
 * Origin (0,0), +x right, +y up. No ground clamping: targets below the
 * launch point are allowed and flight continues through y = 0.
 *
 * With u = tan(theta), eliminating t from
 *   x(t) = v cos(theta) t,  y(t) = v sin(theta) t - g t^2 / 2
 * gives  A u^2 - x u + (A + h) = 0,  A = g x^2 / (2 v^2).
 */

export const ALGO_VERSION = "1.0.0";

export interface Tolerances {
  abs: number;
  rel: number;
}

export const DEFAULT_TOLERANCES: Tolerances = { abs: 1e-12, rel: 1e-12 };

export const LIMITS = {
  vMax: 1e6,
  gMax: 1e6,
  xMax: 1e9,
  hMax: 1e9,
  samplesMin: 2,
  samplesMax: 10000,
  samplesDefault: 64,
};

export type CaseStatus =
  | "two_solutions"
  | "one_solution"
  | "unreachable"
  | "numeric_error";

export interface CaseInput {
  v: number;
  g: number;
  x: number;
  h: number;
}

export interface SamplePoint {
  t: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** mechanical energy per unit mass: |v|^2/2 + g*y */
  energy: number;
}

export interface Candidate {
  index: number;
  u: number;
  angleDeg: number;
  angleRad: number;
  v0x: number;
  v0y: number;
  flightTime: number;
  arrivalX: number;
  arrivalY: number;
  residualX: number;
  residualY: number;
  residualNorm: number;
  endVx: number;
  endVy: number;
  apex: { t: number; x: number; y: number; source: "interior" | "endpoint" };
  energy0: number;
  energyMaxAbsError: number;
  samples: SamplePoint[];
}

export interface SolveResult {
  status: CaseStatus;
  input: CaseInput;
  tolerances: Tolerances;
  algoVersion: string;
  A: number;
  discriminant: number;
  discriminantRaw: number;
  discriminantScale: number;
  discriminantNote: string;
  candidates: Candidate[];
  error?: string;
}

export function validateInput(inp: CaseInput): string | null {
  const { v, g, x, h } = inp;
  for (const [name, val] of Object.entries({ v, g, x, h })) {
    if (typeof val !== "number" || !Number.isFinite(val)) {
      return `parameter ${name} must be a finite number`;
    }
  }
  if (v <= 0) return "v must be > 0";
  if (g <= 0) return "g must be > 0";
  if (x <= 0) return "x must be strictly > 0";
  if (v > LIMITS.vMax) return `v exceeds limit ${LIMITS.vMax}`;
  if (g > LIMITS.gMax) return `g exceeds limit ${LIMITS.gMax}`;
  if (x > LIMITS.xMax) return `|x| exceeds limit ${LIMITS.xMax}`;
  if (Math.abs(h) > LIMITS.hMax) return `|h| exceeds limit ${LIMITS.hMax}`;
  return null;
}

function allFinite(...vals: number[]): boolean {
  return vals.every(Number.isFinite);
}

/**
 * Solve A u^2 - x u + (A + h) = 0 with a numerically stable formula
 * (avoids subtractive cancellation when one root is near zero,
 * e.g. h close to -A).
 */
function stableRoots(
  A: number,
  x: number,
  c: number,
  sqrtD: number
): [number, number] {
  // q = (x + sqrt(D)) / 2  (x > 0 so no cancellation in q itself)
  const q = (x + sqrtD) / 2;
  const r1 = c / q; // may be near zero; computed via division, not subtraction
  const r2 = q / A;
  return r1 <= r2 ? [r1, r2] : [r2, r1];
}

function buildCandidate(
  u: number,
  index: number,
  inp: CaseInput,
  sampleCount: number
): Candidate | null {
  const { v, g, x, h } = inp;
  const angleRad = Math.atan(u);
  const angleDeg = (angleRad * 180) / Math.PI;
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  const v0x = v * cos;
  const v0y = v * sin;
  if (!(v0x > 0)) return null; // angle must stay in (-90, 90) deg
  const t = x / v0x;
  if (!(t > 0) || !Number.isFinite(t)) return null; // reject non-positive flight time

  const arrivalX = v0x * t;
  const arrivalY = v0y * t - (g * t * t) / 2;
  const residualX = arrivalX - x;
  const residualY = arrivalY - h;
  const residualNorm = Math.hypot(residualX, residualY);
  const endVx = v0x;
  const endVy = v0y - g * t;

  // Highest point during THIS flight: clamp vy=0 time into [0, t].
  const tApexRaw = v0y / g;
  const tApex = Math.min(Math.max(tApexRaw, 0), t);
  const apex = {
    t: tApex,
    x: v0x * tApex,
    y: v0y * tApex - (g * tApex * tApex) / 2,
    source: (tApexRaw > 0 && tApexRaw < t ? "interior" : "endpoint") as
      | "interior"
      | "endpoint",
  };

  const energy0 = (v * v) / 2; // y(0) = 0
  const samples: SamplePoint[] = [];
  let energyMaxAbsError = 0;
  for (let i = 0; i < sampleCount; i++) {
    const ti = (t * i) / (sampleCount - 1);
    const xi = v0x * ti;
    const yi = v0y * ti - (g * ti * ti) / 2;
    const vyi = v0y - g * ti;
    const energy = (v0x * v0x + vyi * vyi) / 2 + g * yi;
    const err = Math.abs(energy - energy0);
    if (err > energyMaxAbsError) energyMaxAbsError = err;
    samples.push({ t: ti, x: xi, y: yi, vx: v0x, vy: vyi, energy });
  }

  if (
    !allFinite(
      angleDeg,
      t,
      arrivalX,
      arrivalY,
      residualNorm,
      endVy,
      apex.y,
      energyMaxAbsError
    )
  ) {
    return null;
  }

  return {
    index,
    u,
    angleDeg,
    angleRad,
    v0x,
    v0y,
    flightTime: t,
    arrivalX,
    arrivalY,
    residualX,
    residualY,
    residualNorm,
    endVx,
    endVy,
    apex,
    energy0,
    energyMaxAbsError,
    samples,
  };
}

export function solve(
  inp: CaseInput,
  tolerances: Tolerances = DEFAULT_TOLERANCES,
  sampleCount: number = LIMITS.samplesDefault
): SolveResult {
  const { v, g, x, h } = inp;
  const base = {
    input: inp,
    tolerances,
    algoVersion: ALGO_VERSION,
    A: NaN,
    discriminant: NaN,
    discriminantRaw: NaN,
    discriminantScale: NaN,
    discriminantNote: "",
  };
  const fail = (error: string): SolveResult => ({
    ...base,
    status: "numeric_error" as CaseStatus,
    candidates: [],
    error,
  });

  const invalid = validateInput(inp);
  if (invalid) return fail(invalid);
  if (
    !Number.isInteger(sampleCount) ||
    sampleCount < LIMITS.samplesMin ||
    sampleCount > LIMITS.samplesMax
  ) {
    return fail(
      `sampleCount must be an integer in [${LIMITS.samplesMin}, ${LIMITS.samplesMax}]`
    );
  }

  const A = (g * x * x) / (2 * v * v);
  const c = A + h;
  const rawD = x * x - 4 * A * c;
  const scale = x * x + Math.abs(4 * A * c);
  if (!allFinite(A, c, rawD, scale)) {
    return fail("non-finite intermediate value (A or discriminant)");
  }

  const tol = tolerances.abs + tolerances.rel * scale;
  let D = rawD;
  let note = "discriminant >= 0";
  if (rawD < 0) {
    if (Math.abs(rawD) <= tol) {
      D = 0;
      note =
        "discriminant slightly negative within tolerance; treated as tangent (single) solution";
    } else {
      return {
        ...base,
        A,
        discriminant: rawD,
        discriminantRaw: rawD,
        discriminantScale: scale,
        discriminantNote: "discriminant negative beyond tolerance: unreachable",
        status: "unreachable",
        candidates: [],
      };
    }
  }

  const sqrtD = Math.sqrt(D);
  let roots: number[] = stableRoots(A, x, c, sqrtD);
  // Deduplicate a repeated (tangent) root.
  const rootTol =
    tolerances.abs + tolerances.rel * Math.max(1, Math.abs(roots[1]));
  if (Math.abs(roots[1] - roots[0]) <= rootTol) {
    roots = [(roots[0] + roots[1]) / 2];
  }

  const candidates: Candidate[] = [];
  for (const u of roots) {
    const cand = buildCandidate(u, candidates.length, inp, sampleCount);
    if (!cand) {
      return {
        ...base,
        A,
        discriminant: D,
        discriminantRaw: rawD,
        discriminantScale: scale,
        discriminantNote: note,
        status: "numeric_error" as CaseStatus,
        candidates: [],
        error: "failed to verify candidate against the equations of motion",
      };
    }
    candidates.push(cand);
  }

  // Reachability requires analytic roots AND back-substitution verification.
  const verifyTol =
    1e-6 * Math.max(1, Math.abs(x), Math.abs(h)) + tolerances.abs;
  const verified = candidates.filter((cd) => cd.residualNorm <= verifyTol);
  if (verified.length !== candidates.length || verified.length === 0) {
    return {
      ...base,
      A,
      discriminant: D,
      discriminantRaw: rawD,
      discriminantScale: scale,
      discriminantNote: note,
      status: "numeric_error" as CaseStatus,
      candidates: [],
      error: "back-substitution residual exceeds verification tolerance",
    };
  }

  return {
    ...base,
    A,
    discriminant: D,
    discriminantRaw: rawD,
    discriminantScale: scale,
    discriminantNote: note,
    status: candidates.length === 2 ? "two_solutions" : "one_solution",
    candidates,
  };
}

/** Forward query: trajectory at a given launch angle (degrees). */
export function forwardQuery(
  inp: CaseInput,
  angleDeg: number,
  sampleCount: number = LIMITS.samplesDefault
):
  | {
      ok: true;
      angleDeg: number;
      u: number;
      v0x: number;
      v0y: number;
      arrivalTimeAtTargetX: number;
      arrivalYAtTargetX: number;
      missY: number;
      samples: SamplePoint[];
    }
  | { ok: false; error: string } {
  if (!Number.isFinite(angleDeg) || angleDeg <= -90 || angleDeg >= 90) {
    return { ok: false, error: "angleDeg must be in (-90, 90)" };
  }
  const invalid = validateInput(inp);
  if (invalid) return { ok: false, error: invalid };
  const { v, g, x } = inp;
  const angleRad = (angleDeg * Math.PI) / 180;
  const u = Math.tan(angleRad);
  const v0x = v * Math.cos(angleRad);
  const v0y = v * Math.sin(angleRad);
  const t = x / v0x;
  const y = v0y * t - (g * t * t) / 2;
  if (!allFinite(u, v0x, v0y, t, y)) {
    return { ok: false, error: "non-finite result" };
  }
  const n = Math.min(
    Math.max(sampleCount, LIMITS.samplesMin),
    LIMITS.samplesMax
  );
  const samples: SamplePoint[] = [];
  for (let i = 0; i < n; i++) {
    const ti = (t * i) / (n - 1);
    const xi = v0x * ti;
    const yi = v0y * ti - (g * ti * ti) / 2;
    const vyi = v0y - g * ti;
    samples.push({
      t: ti,
      x: xi,
      y: yi,
      vx: v0x,
      vy: vyi,
      energy: (v0x * v0x + vyi * vyi) / 2 + g * yi,
    });
  }
  return {
    ok: true,
    angleDeg,
    u,
    v0x,
    v0y,
    arrivalTimeAtTargetX: t,
    arrivalYAtTargetX: y,
    missY: y - inp.h,
    samples,
  };
}

