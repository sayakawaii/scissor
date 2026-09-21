# OaK 启发的 Scissor Agent 设计

> 目标：把 Richard Sutton 的 OaK（Options and Knowledge）思想转化为 Scissor 可逐步实现、可测试、可回退的工程设计。
> 边界：这是“受 OaK 启发”的 coding-agent 架构，不宣称 Scissor 已实现或将完整实现 OaK。

[English version](./oak-inspired-agent-design.en.md)

## 1. 核心判断

Scissor 已具备 OaK 式闭环的工程基础：

- `AgentCallbacks` 和工具调用形成 observation/action 接口；
- guardrail pipeline 表达权限、安全和执行约束；
- tests、typecheck、lint、eval、bench 提供可观测结果；
- scratchpad、session archive、`SCISSOR_MEMORY.md` 提供不同时间尺度的状态；
- tools、skills、subagents 和 control tools 可作为 option 的工程近似；
- trace、cost report 和 eval-gen 已经能积累运行经验。

但它目前仍是“冻结 LLM + 上下文适应 + 外部状态”的 Agent，不是 Sutton 意义上的 OaK。最重要的缺口是：

- 没有显式、持续学习的 value function；
- 没有根据经验学习 option 的成功条件和后果模型；
- 没有从状态 feature 自动发现 reward-respecting subproblem；
- 没有基于长期效用自动整理和淘汰 skills、memory 与 subagents；
- 基础模型权重和表示不会从第一人称经验持续更新。

合理目标不是复刻研究中的完整 OaK，而是先实现一个安全的 **OaK-inspired experience layer**：将真实执行轨迹转化为结构化特征、技能统计和规划依据。

## 2. 设计原则

### 2.1 主目标与硬约束分离

不要把权限、安全、数据完整性和用户确认压缩成一个可被其他收益抵消的总分。

- **Primary objective**：用户要求的最终结果。
- **Success evidence**：测试、构建、lint、文件或命令结果。
- **Cost signals**：token、时间、工具调用次数、失败重试。
- **Hard constraints**：权限、审批、路径边界、不可逆操作、秘密信息。

Guardrails 始终优先于优化目标。任何经验学习都不能自行放宽硬约束。

### 2.2 子任务必须 reward-respecting

每个子任务必须说明它如何提高主任务成功率，不能只追求局部完成。

建议给 planner 产生的子任务增加以下字段：

- `parentGoalId`
- `expectedContribution`
- `successEvidence`
- `constraints`
- `budget`
- `terminationCondition`

如果无法说明对主目标的贡献，则不创建该子任务，或将它降级为候选调查。

### 2.3 Skill 应有 Option 语义

OaK 中的 option 是“策略 + 终止条件”。Scissor 的 tool、skill 和 subagent 可以采用类似契约：

- initiation：什么状态下适用；
- policy：建议的步骤或可调用工具集合；
- success termination：成功停止条件；
- failure termination：失败、超时、预算耗尽或风险升高时的停止条件；
- expected outcome：预计会改变哪些状态特征；
- evidence：如何证明结果，而不是只相信模型文本。

这里的“option”是工程抽象，不意味着策略由强化学习训练得到。

### 2.4 每个 Option 边界都重新观察

长程计划不应被当作不可更改的脚本。每完成一个 skill 或 subagent：

1. 重新读取关键状态；
2. 检查成功证据；
3. 更新成本和风险；
4. 判断继续、终止、回退或重规划。

这能减少因早期错误假设造成的连锁失败。

### 2.5 用真实效用整理能力

不要无限累积 memories、skills 和 workflow。保留的依据应是对最终任务结果的边际贡献，而不是被调用次数。

候选指标包括：

- 在哪些项目状态下提高成功率；
- 是否减少 turns、token、时间或重试；
- 是否降低验证失败和人工纠正次数；
- 结果是否能跨任务复现；
- 是否引入新的安全风险或维护成本。

## 3. 建议架构

### 3.1 State Feature Extractor

从现有上下文提取稳定、可比较的结构化状态：

- repo：语言、框架、包管理器、工作区规模、git 状态；
- task：意图、目标文件、风险等级、是否需要用户决策；
- execution：最近工具结果、错误类型、重试次数、剩余预算；
- verification：typecheck、lint、test、eval 的结果与失败签名；
- history：类似任务中成功或失败的 option。

第一阶段应使用确定性规则和现有 trace 数据，不引入向量数据库或在线训练依赖。

### 3.2 Subproblem Selector

输入主目标和 state features，输出少量候选子任务。每个候选必须带预期贡献和停止条件。

优先选择：

- 对最终成功有明确因果路径的子任务；
- 价值随当前状态变化，而不是所有任务都机械执行的步骤；
- 能产生新的决策信息或降低重大风险的调查；
- 有可验证产物的步骤。

限制并发候选数量，避免“开放式发现”退化为无限扩张。

### 3.3 Option Registry

在现有 tools、control tools、skills 和 subagents 之上维护统一元数据：

- `id`、`version`、`description`
- `applicableWhen`
- `requiredCapabilities`
- `termination`
- `expectedFeatures`
- `verification`
- `risk`
- `utilityStats`

Registry 只保存元数据和统计，不复制 tool 的执行逻辑。实际执行继续通过当前 agent loop 和 guardrail pipeline。

### 3.4 Experience Model

根据 trace 记录 `(state, option, outcome)`，学习“在什么状态下使用什么能力更可能成功”。

最初不要上神经网络。可采用：

- 按稳定特征分桶；
- Beta/Bernoulli 成功率估计；
- 指数衰减的时延和成本均值；
- 错误签名与失败原因计数；
- 最小样本数和置信区间；
- 按 option 版本隔离统计。

这不是完整 transition model，但能以可解释、可测试的方式为规划提供经验先验。

### 3.5 Planner

Planner 的评分应同时考虑：

- 达成主目标的预期贡献；
- 成功概率；
- token、时间和工具成本；
- 风险与可逆性；
- 信息增益；
- 是否已有足够成功证据。

规划器只能在 guardrails 允许的动作空间内选择 option。高风险或破坏性动作仍需用户批准。

### 3.6 Utility Curator

周期性评估 option、memory 和自动生成规则：

- 提升明确且样本足够：保留或提高优先级；
- 作用重复：合并；
- 长期无贡献：降级或归档；
- 与新版本冲突：失效；
- 导致越权、循环或验证退化：立即禁用并记录原因。

自动删除应谨慎。第一阶段只生成建议，由人确认后变更能力库。

## 4. 与现有 Scissor 模块的映射

### `packages/core`

- `agent.ts`：保持小型主循环；只消费结构化 planner 决策，不把策略规则硬编码进循环。
- `guardrails/**`：继续承载跨工具安全策略；经验模型不能绕过它。
- `tools/**`：为工具补充可选的 initiation、outcome 和 verification 元数据。
- `prompt.ts` / `repo-index.ts`：提供 state feature 的输入，但避免把所有原始 trace 塞入 prompt。
- `session-store`：保存当前任务的结构化目标、子任务和 option 状态。

### `packages/cli`

- `trace/**`：扩展稳定 schema，记录 option id/version、前置特征、终止原因和验证结果。
- `eval` / `bench`：评估经验路由是否真正提高 pass rate，而不只减少 token。
- `self/**`：保持独立安全边界，不允许学习层自动修改或绕过 supervisor。
- UI：展示“为什么选择该 option”、置信度、预计成本和停止条件。

### 建议新增的核心边界

可在 `packages/core` 内逐步增加：

- `experience/features.ts`
- `experience/option-registry.ts`
- `experience/model.ts`
- `experience/planner.ts`
- `experience/curator.ts`

这些模块只依赖结构化数据，不依赖终端 UI。持久化继续使用本地 JSON/JSONL，符合 local-first 和 minimal-deps 原则。

## 5. 分阶段实施

### Phase 0：先定义可测目标

增加能够区分新旧行为的 bench/eval：

- 相同错误连续出现时，能切换更合适的诊断 option；
- 已有验证证据时，不重复运行高成本步骤；
- 不适用的 skill 不会被调用；
- 子任务局部成功但破坏主目标时，最终判定为失败；
- 经验数据不足时安全退化到现有 planner。

主要指标依次为：

1. real-task autonomy；
2. reliability；
3. harder-benchmark pass rate；
4. 在不降低前三项时再优化成本和速度。

### Phase 1：Trace 正规化

只做可观测性，不改变决策：

- 为每次工具/skill/subagent 执行记录稳定的 option id；
- 记录前置特征、结果、终止原因、验证结果、耗时和 token；
- 对路径、密钥和用户内容做隐私过滤；
- schema 带版本号，旧 trace 可迁移或安全忽略。

### Phase 2：离线 Experience Report

从 trace 生成只读报告：

- option 在不同状态下的成功率；
- 主要失败签名；
- 平均成本和时延；
- 与最终任务成功的相关性；
- 数据量和置信度。

先让人验证统计是否可信，不进入在线决策。

### Phase 3：建议模式

Planner 根据经验模型给出 option 排序和理由，但现有策略仍作最终选择。记录“建议被采用后是否改善结果”，防止离线指标自我强化。

### Phase 4：受限自动路由

只对低风险、可回退、样本充足的 option 自动选择。必须支持：

- feature flag；
- 每个 option 的 kill switch；
- 置信度阈值；
- 数据漂移检测；
- 回退到现有 planner；
- A/B 或 shadow evaluation。

### Phase 5：受控能力整理

系统可以建议合并、降级或归档 skill，但不自动更改权限和硬约束。任何自动生成的新 skill 必须经过确定性测试或 eval 才能启用。

## 6. 最小数据模型

```ts
type ExperienceEvent = {
  schemaVersion: 1;
  taskId: string;
  option: { id: string; version: string };
  state: Record<string, string | number | boolean>;
  startedAt: string;
  durationMs: number;
  termination: "success" | "failure" | "cancelled" | "budget" | "guardrail";
  evidence: {
    verificationPassed?: boolean;
    errorSignature?: string;
    changedFiles?: number;
  };
  cost: { inputTokens?: number; outputTokens?: number; usd?: number };
  finalTaskOutcome?: "success" | "failure" | "unknown";
};
```

状态特征必须低基数、稳定且不包含秘密。自由文本只保留经过归一化的错误签名或哈希，避免经验库变成隐私数据仓库。

## 7. 失败模式与防护

### Reward hacking

只优化“测试通过”可能导致删除测试或降低断言。应同时保护测试完整性、用户约束和 diff 合理性，并把硬规则放在 guardrail。

### 局部 KPI 伤害主任务

子代理可能完成自己的文件修改，却破坏构建或需求。最终效用只能由主任务级验证决定。

### 数据污染

用户中断、环境故障和权限拒绝不应被简单记为 option 能力失败；termination reason 必须区分。

### 非平稳与版本漂移

模型、prompt、tool 或项目版本变化后，旧统计可能失效。按版本隔离，使用时间衰减，并保留最小样本阈值。

### 过早自动化

少量相关性数据不能证明因果。采用“观察 → 报告 → 建议 → 受限自动化”的递进顺序。

### 能力库膨胀

设置容量、重复检测、最低效用和人工审核。新增 option 必须带成功证据和停止条件。

## 8. 建议的第一个实现切片

优先实现 **Trace 正规化 + 离线 Option 效用报告**，暂不改 agent 决策。

这个切片的收益：

- 直接复用 Scissor 现有 trace、eval 和 bench；
- 不影响 agent loop 与安全边界；
- 能验证“经验模型是否真的有信号”；
- 容易添加确定性测试；
- 如果数据无价值，可以低成本停止，而不会留下复杂在线学习系统。

验收条件：

1. trace 能稳定关联 state、option、termination 和最终验证结果；
2. 报告对样本量和置信度透明；
3. 敏感文本不会进入经验数据；
4. 同一份 fixture 生成确定性结果；
5. 新 bench case 证明报告能识别一个在特定状态下明显更可靠的 option；
6. 不改变现有 Agent 行为和基准通过率。

## 9. 明确不做

- 不让 Agent 自行改变顶层目标、权限或 guardrails；
- 不把每次工具调用都包装成“强化学习”；
- 不在没有数据验证前引入神经网络、向量数据库或在线权重训练；
- 不把 skill 调用次数当作效用；
- 不声称 frozen-LLM planning 等价于 OaK continual learning；
- 不因为概念相似就重写当前稳定的 agent loop。

## 参考

- [`WAIC 2026 OaK 演讲分析`](../research/waic-2026-oak-analysis.md)
- [The Alberta Plan for AI Research](https://arxiv.org/abs/2208.11173)
- [Reward-respecting Subtasks](https://arxiv.org/abs/2202.03466)
- [OaK Architecture — Rich Sutton, RLC 2025](https://www.amii.ca/videos/oak-architecture-rich-sutton-rlc2025)
