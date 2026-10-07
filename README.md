# 理想抛球定点到达角与双轨迹核验后端

教学用二维理想抛球计算服务。输入初速度大小 `v`、恒定重力 `g` 和目标相对位置 `(x, h)`，
求能到达目标的全部向右初始方向，输出到达时间、轨迹采样、回代残差与能量核验。
仅提供 HTTP API 与 CLI，无前端。TypeScript + Node.js + SQLite（Node 内置 `node:sqlite`），
Windows 本地运行，不依赖 Docker / WSL / 外部服务。

## 模型约定

- 质点、无空气阻力、平面恒定重力，起点 `(0,0)`，横轴向右、纵轴向上，单位米 / 秒。
- 初始角 θ ∈ (-90°, 90°)，水平速度恒为正。
- 轨迹：`x(t) = v·cosθ·t`，`y(t) = v·sinθ·t − g·t²/2`。
- **目标可以低于起点（h < 0），没有地面截停规则**：不会把 `y = 0` 当作轨迹终点。
- 只返回正的飞行时间，不取同一条抛物线的反向时间解。
- 不接传感器、不控制设备，无碰撞、旋转、空气动力与数值物理引擎。

## 数学方法

令 `u = tanθ`，`A = g·x² / (2·v²)`，消去时间得：

```
A·u² − x·u + (A + h) = 0
```

- 判别式 `D = x² − 4A(A+h)`。`D < 0` 且超出容差 → 不可达；`D` 微小为负（容差内）按零处理。
- 公开容差：默认 `absTol = 1e-12`，`relTol = 1e-12`，判定阈值
  `absTol + relTol · (x² + 4|A|(|A|+|h|))`，可在请求中覆盖。
- 稳定求根：大根 `(x+√D)/(2A)` 直接算，小根用韦达定理 `2(A+h)/(x+√D)`，
  避免 `h ≈ −A`（一个根接近零）时的相减消去。
- 候选按角度升序，重根（切线单解）合并为一个。
- 每个候选回代原始运动方程：到达时间 `t = x/(v·cosθ)`、到达位置、位置残差（真实计算，
  非复制目标坐标）、初末速度分量。残差超标的候选被丢弃；全部候选失效时返回
  `NUMERIC_FAILURE` 而不是伪装成不可达。
- 最高点：先算 `vy = 0` 的时刻再截断到 `[0, t到达]`，因此向下抛时最高点在起点、
  目标仍在上升段时最高点在终点。
- 能量核验：单位质量机械能 `E(t) = |v(t)|²/2 + g·y(t)`，报告沿途最大绝对误差，
  不修改轨迹强行守恒。
- 采样表含首尾两端；采样密度只影响展示，不影响角度、时间与可达性判定。

## 状态与错误码

求解状态：`TWO_SOLUTIONS`（两解）、`ONE_SOLUTION`（切线单解）、`UNREACHABLE`（不可达）、
`NUMERIC_FAILURE`（数值失败，不落库）。

输入错误码（HTTP 400）：`MISSING_PARAM`、`NAN_INPUT`、`NON_FINITE`、`INVALID_V`、
`INVALID_G`、`INVALID_X`、`INVALID_THETA`、`INVALID_T`、`INVALID_SAMPLES`、
`INVALID_TOL`、`OUT_OF_RANGE`、`BAD_JSON`。另有 `NOT_FOUND`(404)、
`NOT_COMPARABLE`(409)、`NUMERIC_FAILURE`(422)。

公开上限：`v ≤ 1e6`，`g ≤ 1e4`，`x ≤ 1e9`，`|h| ≤ 1e9`，采样数 2–4096（默认 64）。

## 构建 / 测试 / 启动

```powershell
npm install
npm run build     # 编译到 dist/
npm test          # 编译并运行全部测试（node:test）
npm start         # 启动 HTTP 服务（默认自动选择空闲端口，--port=8080 可指定）
node dist/cli.js  # CLI 帮助
```

数据保存在项目内 `data/cases.db`。SQLite 保存原始输入、容差、算法版本、全部候选与冻结报告；
修改任一输入产生新报告；相同输入幂等返回已有报告；非法输入与数值失败不落库；
重启后可用 `show` / `GET /api/cases/:id` 查询当时的解与残差。

## CLI

```powershell
node dist/cli.js solve --v 10 --g 10 --x 8 --h 0 [--samples 64] [--absTol 1e-12] [--relTol 1e-12]
node dist/cli.js position --v 10 --g 10 --thetaDeg 45 --t 1.4142
node dist/cli.js list
node dist/cli.js show 1
node dist/cli.js export 1        # CSV 采样表
node dist/cli.js serve --port 8080
```

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/cases` | 创建工况 `{v,g,x,h,samples?,absTol?,relTol?}`，幂等 |
| GET | `/api/cases` | 历史工况列表 |
| GET | `/api/cases/:id` | 冻结报告（含候选、残差、采样） |
| GET | `/api/cases/:id/discriminant` | 判别式来源与容差细节 |
| GET | `/api/cases/:id/compare` | 比较两条候选轨迹（单解返回 409） |
| GET | `/api/cases/:id/export` | 导出 CSV 采样表 |
| POST | `/api/position` | 正向查询 `{v,g,thetaDeg,t}` 的位置/速度/能量 |

## 验证案例

- `v=10, g=10, (8,0)`：`tanθ = 0.5` 与 `2`，角度 ≈ 26.56505118° 与 63.43494882°。
- `(10,0)`：45° 单解，到达时间 `√2`。
- `(11,0)`：不可达。
- 测试另覆盖：高于/低于起点目标、近平射（`h ≈ −A` 小根）、小正横距、判别式边界、
  候选去重、采样数变化不影响结果、端点最高点、能量守恒、失败后历史报告不变。

## 限制

- 双精度浮点；超出公开上限或中间量非有限时返回 `NUMERIC_FAILURE` / `OUT_OF_RANGE`。
- `node:sqlite` 在 Node 25 仍为实验特性（启动时有 ExperimentalWarning，不影响功能）。
- 采样为均匀时间采样，仅用于展示与能量核验。
