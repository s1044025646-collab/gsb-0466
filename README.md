# 理想抛球定点到达角求解器（教学演示后端）

纯后端服务：给定初速度大小 `v`、恒定重力 `g` 和目标相对位置 `(x, h)`，
求所有能命中目标的**向右**初始方向（可能 0、1 或 2 个），并输出到达时间、
轨迹采样、残差核验与能量核验。仅提供 HTTP API 与 CLI，无界面。

## 物理模型与约定

- 质点、无空气阻力、平面恒定重力；**不做**碰撞、旋转、气动或数值物理引擎。
- 起点 `(0,0)`，横轴向右、纵轴向上；单位固定为米和秒。
- 运动方程：`x(t) = v·cosθ·t`，`y(t) = v·sinθ·t − g·t²/2`。
- 初始角 `θ ∈ (−90°, 90°)`，因此水平速度恒为正。
- **目标在起点下方（h < 0）完全合法**：本题没有地面，轨迹穿过 `y = 0` 不会截停。
- 只接受**正的飞行时间**；同一抛物线的反向时间解不作为候选。
- 途中最高点：先求竖直速度为零的时刻，再裁剪到 `[0, 到达时间]`；
  向下抛或到达时仍在上升段时，最高点就是端点（`apex.source = "endpoint"`）。

## 数学方法

令 `u = tanθ`，消去时间得关于 `u` 的二次方程：

```
A·u² − x·u + (A + h) = 0,   A = g·x² / (2·v²)
```

- 判别式 `D = x² − 4A(A+h)`：`D > 0` 两解；`D = 0` 切线单解（重根去重合并）；
  `D < 0` 不可达。
- 容差公开且可配置：默认 `abs = 1e-12`、`rel = 1e-12`。
  仅当 `|D| ≤ abs + rel·scale`（`scale = x² + |4A(A+h)|`）时，把微小负判别式
  视为 0（切线解）；真实不可达目标**不会**被截成边界可达。
- 求根用数值稳定公式 `q = (x + √D)/2`，两根为 `c/q` 与 `q/A`，
  避免 `h ≈ −A`（一个根接近零）时的相减消去误差。
- 可达性由**解析根 + 回代原始运动方程**共同决定：每个候选都实际回代计算
  到达位置与位置残差（不是复制目标坐标）；残差超差或出现非有限值时返回
  `numeric_error`，绝不伪装成不可达，也不会输出 NaN/Infinity。
- 每条候选附带单位质量机械能 `E = |v(t)|²/2 + g·y(t)` 的沿途一致性检查，
  误差独立列出（`energyMaxAbsError`），不修改轨迹强行守恒。

## 结果状态

| 状态 | 含义 |
|---|---|
| `two_solutions` | 两个不同方向（按角度升序） |
| `one_solution`  | 切线单解（重根已去重） |
| `unreachable`   | 判别式负且超出容差 |
| `numeric_error` | 输入非法或数值失败（含原因 `error` 字段） |

## 环境与运行

要求：Windows + Node.js ≥ 22（使用内置 `node:sqlite`，无原生编译依赖）、
不依赖 Docker / WSL / 任何在线服务。唯一开发依赖是 TypeScript。

```powershell
npm install        # 安装 typescript
npm run build      # 编译到 dist/
npm test           # 构建并运行全部测试
npm start          # 启动 API（默认自动选择空闲端口）
npm run demo       # 运行内置演示工况
```

数据保存在项目内 `data/projectile.db`（可用环境变量 `PROJECTILE_DB` 覆盖）。

## CLI

```
node dist/src/cli.js solve --v 10 --g 10 --x 8 --h 0 [--samples 64] [--tolAbs 1e-12] [--tolRel 1e-12]
node dist/src/cli.js list
node dist/src/cli.js show <id>
node dist/src/cli.js position <id> --angle 45 [--samples 32]
node dist/src/cli.js discriminant <id>
node dist/src/cli.js compare <id>
node dist/src/cli.js export <id> [--format csv|json]
node dist/src/cli.js serve [--port 0]     # 0 = 自动空闲端口（默认）
node dist/src/cli.js demo
```

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET  | `/api/health` | 健康检查与公开参数上限 |
| POST | `/api/cases` | 创建工况，Body：`{v,g,x,h,samples?,tolAbs?,tolRel?}`；幂等：相同输入返回已有报告 |
| GET  | `/api/cases` | 列出全部工况 |
| GET  | `/api/cases/:id` | 查看冻结报告（含全部候选、残差、采样） |
| GET  | `/api/cases/:id/position?angle=度` | 正向查询指定角度的轨迹与到达目标横坐标时的位置 |
| GET  | `/api/cases/:id/discriminant` | 查看判别式来源（A、原始 D、缩放、容差、说明） |
| GET  | `/api/cases/:id/compare` | 比较两条路线（角度差、时间差、最高点差） |
| GET  | `/api/cases/:id/export?format=csv` | 导出采样（CSV 或 JSON） |

错误码：`INVALID_INPUT`（400）、`BAD_REQUEST`（400）、`NOT_FOUND`（404）、
`NUMERIC_ERROR`（422/500）。`unreachable` 是正常结果（201），不是错误。

## 持久化与幂等

SQLite 保存原始输入、容差、算法版本、全部候选与冻结报告（单个 JSON blob，
要么完整写入要么不写，不会留下只有一半候选的"成功"结果）。相同
（输入, 容差, 采样数, 算法版本）的重复请求直接返回已有报告（`reused: true`）；
修改初速度或目标会产生新报告。重启后仍可按 id 查询当时的解与残差。

## 参数上限（公开）

`v, g ≤ 1e6`，`|x|, |h| ≤ 1e9`，采样数 `2..10000`（默认 64，仅影响展示，
不影响角度、时间或可达性判定），容差 `tolAbs/tolRel ∈ [0, 1e-3]`。

## 已知验证用例

- `v=10, g=10, (8,0)`：两解，`tanθ = 0.5 / 2`，角度 ≈ 26.56505118° / 63.43494882°
- `v=10, g=10, (10,0)`：45° 切线单解，到达时间 `√2` 秒
- `v=10, g=10, (11,0)`：不可达
- `(6, 2)`（高于起点）与 `(6, −3)`（低于起点）：均为两解

## 限制

- 仅教学用理想模型，不接传感器、不控制任何设备。
- `node:sqlite` 在 Node 25 仍标记为实验特性（启动时有 ExperimentalWarning），
  如需长期稳定可换 `better-sqlite3`，接口已隔离在 `src/db.ts`。
- 采样仅用于展示与核验，加密采样不会改变解析解。
