import {
  Callout,
  Card,
  CardBody,
  CardHeader,
  CollapsibleSection,
  Divider,
  Grid,
  H1,
  H2,
  Link,
  Pill,
  Row,
  Stack,
  Stat,
  Table,
  Text,
  useCanvasState,
  useHostTheme,
} from "cursor/canvas";

type View = "结论" | "与编程 Agent 对比" | "学习与落地" | "豆包纠错";

const views: View[] = ["结论", "与编程 Agent 对比", "学习与落地", "豆包纠错"];

function OakFlow() {
  const t = useHostTheme();
  const nodes = [
    { x: 12, w: 116, label: "Feature", sub: "形成状态特征" },
    { x: 150, w: 126, label: "Subproblem", sub: "提出奖励一致的子问题" },
    { x: 298, w: 116, label: "Option", sub: "学习策略 + 停止条件" },
    { x: 436, w: 126, label: "Model", sub: "预测结果与累计奖励" },
    { x: 584, w: 116, label: "Planning", sub: "用模型规划" },
  ];

  return (
    <svg viewBox="0 0 712 150" style={{ width: "100%", minWidth: 620 }}>
      <defs>
        <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
          <path d="M0,0 L8,4 L0,8 Z" fill={t.accent.primary} />
        </marker>
      </defs>
      {nodes.slice(0, -1).map((node, index) => {
        const next = nodes[index + 1];
        return (
          <line
            key={`${node.label}-edge`}
            x1={node.x + node.w}
            y1={58}
            x2={next.x - 8}
            y2={58}
            stroke={t.accent.primary}
            strokeWidth={2}
            markerEnd="url(#arrow)"
          />
        );
      })}
      {nodes.map((node) => (
        <g key={node.label}>
          <rect
            x={node.x}
            y={24}
            width={node.w}
            height={68}
            rx={8}
            fill={t.fill.tertiary}
            stroke={t.stroke.secondary}
          />
          <text
            x={node.x + node.w / 2}
            y={51}
            textAnchor="middle"
            fill={t.text.primary}
            fontSize={14}
            fontWeight={600}
          >
            {node.label}
          </text>
          <text
            x={node.x + node.w / 2}
            y={72}
            textAnchor="middle"
            fill={t.text.secondary}
            fontSize={10}
          >
            {node.sub}
          </text>
        </g>
      ))}
      <path
        d="M 642 101 C 540 142, 155 142, 70 101"
        fill="none"
        stroke={t.stroke.primary}
        strokeWidth={1.5}
        strokeDasharray="5 4"
        markerEnd="url(#arrow)"
      />
      <text x={356} y={137} textAnchor="middle" fill={t.text.tertiary} fontSize={10}>
        规划结果反过来评价、保留或淘汰特征与技能，形成开放式循环
      </text>
    </svg>
  );
}

function SummaryView() {
  return (
    <Stack gap={18}>
      <Callout tone="info" title="一句话结论">
        这不是一场“如何训练更大的 LLM”的演讲，而是一套尚未完成的、以持续经验学习为核心的
        model-based reinforcement-learning agent 认知架构。OaK 与 Claude Code、Cursor
        有若干功能类比，但没有证据表明后二者按 OaK 设计，也不具备其关键的在线权重学习与显式价值函数。
      </Callout>

      <Grid columns="minmax(0, 1.25fr) minmax(260px, .75fr)" gap={18}>
        <Stack gap={10}>
          <H2>4.1 “AI 第一性原理”到底是什么</H2>
          <Text>
            演讲没有宣称一个被学界公认的唯一公理。“第一性原理”是由问题定义、方法论和架构推论组成的一条链：
          </Text>
          <Table
            headers={["层次", "Sutton 在本场演讲中的主张"]}
            rows={[
              ["问题定义", "智能体通过 observation → action → reward 与世界长期交互；reward 是定义目标的标量信号。"],
              ["世界假设", "世界远大于智能体，因此策略、价值和世界模型只能近似，局部环境还会显得非平稳。"],
              ["方法原则", "Bitter Lesson：长期突破来自可随算力扩展的 search 与 learning，而不是把人的领域知识硬编码进去。"],
              ["运行时推论", "学习、规划和抽象形成必须能在 runtime 发生；可以在 design time 做，但不能只在 design time 做。"],
              ["发展目标", "架构应 domain-general、experiential、open-ended，能不断产生更高层的状态与时间抽象。"],
            ]}
            striped
          />
        </Stack>

        <Card size="lg">
          <CardHeader trailing={<Pill size="sm" active>核心判断</Pill>}>“第一性原理”不是一句口号</CardHeader>
          <CardBody>
            <Stack gap={12}>
              <Text weight="semibold">Bitter Lesson 是方法论，不是完整的智能理论。</Text>
              <Text>
                它回答“应把研究努力放在哪里”；Big World 回答“为什么必须在线适应”；reward hypothesis
                回答“目标如何形式化”；OaK 才是 Sutton 给出的架构性答案。
              </Text>
              <Divider />
              <Text tone="secondary" size="small">
                录音核对：演讲原话使用了 “simple/basic principles” 和 “my quest for those
                principles”，是复数、探索性的表述。
              </Text>
            </Stack>
          </CardBody>
        </Card>
      </Grid>

      <H2>4.2 OaK 是新概念还是旧概念</H2>
      <OakFlow />
      <Grid columns={3} gap={14}>
        <Stat value="旧组件" label="MDP、价值迭代、model-based RL、options、GVFs" />
        <Stat value="新组合" label="Feature → reward-respecting subproblem → option → model" tone="info" />
        <Stat value="未完成" label="深度持续学习、特征发现、安全高效 off-policy 学习" tone="warning" />
      </Grid>
      <Text>
        因此最准确的说法是：<Text weight="semibold">OaK 这个名称和完整组合较新，但绝大多数组件有几十年历史。</Text>
        Options 框架可追溯到 1999；Alberta Plan 与 STOMP 路线在 2022 年已成文；2023
        年论文明确提出 reward-respecting subtasks 并把扩展称为 FC-STOMP/Oak；2025
        年 Sutton 才以完整 OaK 架构集中公开讲解。
      </Text>

      <H2>4.3 演讲焦点</H2>
      <Table
        headers={["不是", "而是"]}
        rows={[
          ["LLM 的参数规模、预训练配方或 Transformer 改进", "通用智能体如何在运行时学习、规划并形成抽象"],
          ["普通应用层工作流编排", "长期、开放式、model-based RL 认知架构"],
          ["把 “model” 当作神经网络", "把 model 严格指作 transition model：预测行动/option 的后果与累计奖励"],
        ]}
        rowTone={["info", "info", "info"]}
      />
    </Stack>
  );
}

function AgentComparisonView() {
  return (
    <Stack gap={16}>
      <Callout tone="warning" title="结论：相似不等于同构">
        Claude Code 与 Cursor 的“任务分解、工具、skills、subagents、记忆、执行反馈”可类比 OaK
        的部分模块；但这种类比停留在功能层。公开资料不支持“它们按 OaK 设计”的说法。
      </Callout>
      <Table
        headers={["能力", "OaK", "Claude Code / Cursor", "判断"]}
        rows={[
          ["Policy", "运行时持续学习的策略", "主要由预训练 LLM 在上下文中生成下一步动作", "表面对应，学习机制不同"],
          ["Value function", "显式评估主问题与每个子问题", "可用测试、lint、自评等反馈，但未公开显式 RL value function", "不等同"],
          ["Option", "学习得到的策略 + 停止条件", "skill、工具流程、subagent 可看作宏动作，通常由人预设或临时规划", "可借鉴"],
          ["Transition model", "学习 action/option 的终止状态分布与累计奖励", "通常执行工具后读取真实结果；无公开的在线 option model", "关键缺失"],
          ["Planning", "用学习到的世界模型持续后台规划", "LLM 在 token/context 中规划并循环调用工具", "都有规划，但原理不同"],
          ["Runtime learning", "权重、表示、技能和模型持续更新", "会话上下文、规则和外部记忆可更新；基础模型权重通常不变", "核心差异"],
          ["Subproblem discovery", "由高价值 feature 自动生成 reward-respecting 子问题", "由 prompt/LLM 分解任务，不是 feature→subproblem 学习", "核心差异"],
        ]}
        striped
        stickyHeader
      />
      <H2>与当前 Agent 框架的关系</H2>
      <Text>
        ReAct、Plan-and-Execute、LangGraph、Claude Code、Cursor 都实现了“观察—思考—行动—再观察”的闭环；
        OaK 则进一步要求这个闭环<Text weight="semibold">长期改变智能体本身</Text>：形成新特征、提出新问题、学出
        option、学出后果模型，再用模型规划。当前 coding agent 多数是在冻结 LLM
        上做上下文内适应和外部状态管理，还不是 Sutton 所说的 continual experiential learning。
      </Text>
      <CollapsibleSection title="能否把预训练 LLM 塞进 OaK？" defaultOpen>
        <Text>
          工程上可以把 LLM 作为 perception、feature generator 或 policy prior，做混合系统；但这不是 Sutton
          的纯粹主张。他强调核心能力必须能从第一人称 runtime experience 中成长，而不依赖人类整理的数据和标签。
        </Text>
      </CollapsibleSection>
      <CollapsibleSection title="现场真正比较的是谁？">
        <Text>
          录音中观众问的是 Yann LeCun 的 JEPA 路线。Sutton 回答两者元素很相似，都有
          policy、perception、value function、transition model；主要分歧之一是 LeCun
          不喜欢用 reinforcement learning 这个名称。豆包写成 “OpenAI AGI roadmap” 是误识别。
        </Text>
      </CollapsibleSection>
    </Stack>
  );
}

function LearningView() {
  return (
    <Stack gap={16}>
      <H2>4.4 最值得学习的内容</H2>
      <Grid columns="minmax(0, 1fr) minmax(0, 1fr)" gap={16}>
        <Card>
          <CardHeader trailing={<Pill size="sm" active>现在可用</Pill>}>用于生产 Agent</CardHeader>
          <CardBody>
            <Stack gap={9}>
              <Text><Text weight="semibold">奖励一致的子任务：</Text>子代理不能只完成局部 KPI，必须保留主目标、约束和成本。</Text>
              <Text><Text weight="semibold">Option 化技能：</Text>每个 skill 写清适用条件、步骤、成功/失败与停止条件。</Text>
              <Text><Text weight="semibold">多时间尺度规划：</Text>用高层技能做长程计划，每一步仍观察结果并允许中途重规划。</Text>
              <Text><Text weight="semibold">经验模型：</Text>记录工具在不同状态下的成功率、成本、延迟与副作用。</Text>
              <Text><Text weight="semibold">效用驱动的整理：</Text>按实际贡献保留、合并或淘汰 memories、skills 和 subagents。</Text>
            </Stack>
          </CardBody>
        </Card>
        <Card>
          <CardHeader trailing={<Pill size="sm">研究前沿</Pill>}>暂不能当成熟方案</CardHeader>
          <CardBody>
            <Stack gap={9}>
              <Text>深度网络的可靠 continual learning：避免 catastrophic forgetting 与 loss of plasticity。</Text>
              <Text>自动发现真正有用的新 state features，而不是无限制造噪声特征。</Text>
              <Text>大规模、稳定、安全且高效的 off-policy learning。</Text>
              <Text>从大量 features 中选择值得建立 subproblem/option/model 的少数候选。</Text>
              <Text>把标量 reward 与真实复杂目标、安全边界和多方价值可靠对齐。</Text>
            </Stack>
          </CardBody>
        </Card>
      </Grid>

      <H2>一套可落地的 coding-agent 改造顺序</H2>
      <Table
        headers={["阶段", "工程动作", "对应 OaK 思想"]}
        rows={[
          ["1. 定义主目标", "把用户意图、测试、权限、成本与不可违反的约束分开记录", "Primary reward + constraints"],
          ["2. 提取状态", "从代码、诊断、测试、git diff、历史失败形成结构化特征", "Perception / features"],
          ["3. 选择子任务", "只创建能提高主任务成功率、且价值随上下文变化的子任务", "Reward-respecting subproblems"],
          ["4. 封装技能", "为重复工作定义流程、输入、成功标准和停止条件", "Options"],
          ["5. 建经验模型", "统计每个技能在不同项目状态下的结果、耗时、风险", "Option transition models"],
          ["6. 规划并执行", "按经验模型选技能；每个边界点重新观察并允许终止", "Planning with larger jumps"],
          ["7. 维护与淘汰", "根据对最终结果的边际贡献更新评分、合并或删除技能", "Utility metadata / curation"],
        ]}
        striped
      />

      <Callout tone="warning" title="安全边界">
        不要直接照搬“智能体自己产生目标”。生产系统应由人定义顶层目标、权限和不可违反的约束；智能体只能在边界内提出子任务。
        否则开放式目标生成会放大 reward hacking、越权和不可预测行为。
      </Callout>

      <H2>建议学习顺序</H2>
      <Text>1. Sutton & Barto《Reinforcement Learning》：MDP、value、policy、planning。</Text>
      <Text>2. Options framework：理解“策略 + 停止条件”的时间抽象。</Text>
      <Text>3. GVFs 与 Horde：理解如何把知识表示为可验证的、策略相关的预测。</Text>
      <Text>4. Reward-respecting subtasks（2023）：本场 OaK 最具体、最可检验的新机制。</Text>
      <Text>5. Alberta Plan 与 OaK 2025 演讲：理解完整路线及未解决问题。</Text>
    </Stack>
  );
}

function CorrectionsView() {
  return (
    <Stack gap={16}>
      <Callout tone="neutral" title="证据优先级">
        原始录音与现场照片 ＞ Sutton/论文官方原文 ＞ 媒体报道 ＞ 豆包摘要。自动转写仍可能听错专有名词，因此关键争议段另用更大模型复核。
      </Callout>
      <Table
        headers={["豆包记录", "核对结果", "证据"]}
        rows={[
          ["“2024 World AI Conference”", "错误：资料、舞台照片与录音均对应 WAIC 2026；2024 是 Sutton 获图灵奖的年份。", "PDF 页眉、现场照片"],
          ["“与 OpenAI AGI roadmap 对齐”", "错误：现场问的是 Yann LeCun 的 JEPA；Sutton 说二者组件相近。", "录音 约 57:17，高精度复核"],
          ["2030 为 25%，2040 为 50%", "豆包正确。录音清楚说 one chance in four by 2030、one chance in two by 2040。部分媒体写 10% 是误报。", "录音 约 55:30，高精度复核"],
          ["“所有能力 exclusively 在部署后形成”", "过强。原话是学习、规划、抽象必须能在 runtime 发生，也可以在 design time 发生。", "录音 约 12–13 分钟"],
          ["“永久 capability library”", "不准确。OaK 明确维护 utility metadata 并 curate；低价值 feature/option 应淘汰。", "现场 8 步骤 slide"],
          ["“自身 intrinsic reward 可消除 reward gaming”", "过度推断。问答支持减少人类主观打分、让 agent 从世界获得自身可感知的 reward；并未证明可消除 reward gaming。", "录音 约 60:28"],
          ["“经验学习不能给 TSP 最优解”", "应理解为它不是精确组合优化的通用替代品，而非数学上绝不可能得到最优解。", "录音 约 59:12"],
          ["“middle lesson / metal learning / Subhop”", "转写错误：分别应为 Bitter Lesson、meta-learning、subproblem。", "录音、slide、官方演讲"],
        ]}
        rowTone={["danger", "danger", "success", "warning", "warning", "warning", "warning", "neutral"]}
        striped
      />
      <H2>进一步值得追问的问题</H2>
      <CollapsibleSection title="OaK 如何避免自己制造无穷无用子目标？" defaultOpen>
        <Text>
          Sutton 明确承认尚无完整答案。现场给出的启发式是优先选择与主 value function
          强相关、且权重不是永久高而是随状态变化的 feature；后续还需根据规划效用回传并淘汰。
        </Text>
      </CollapsibleSection>
      <CollapsibleSection title="标量 reward 真的足够表达复杂价值吗？">
        <Text>
          这是 reward hypothesis，而不是已证明定理。多主体价值冲突、安全约束、延迟反馈和 reward hacking
          都仍是薄弱环节；工程上应把硬约束与优化目标分层，而不是压成一个可被钻空子的分数。
        </Text>
      </CollapsibleSection>
      <CollapsibleSection title="OaK 为什么与当前 LLM 路线存在张力？">
        <Text>
          LLM 把大量人类知识放在 design-time 预训练中，部署后通常冻结；OaK
          要求核心知识、表示和技能从第一人称运行时经验持续形成。混合路线可行，但会偏离其最纯粹的研究假设。
        </Text>
      </CollapsibleSection>
    </Stack>
  );
}

function Sources() {
  return (
    <Stack gap={8}>
      <H2>主要来源</H2>
      <Text size="small" tone="secondary">
        本地资料：71 分钟原始录音、豆包 PDF、15 张现场照片。关键争议段已离线转写并二次复核。
      </Text>
      <Row gap={14} wrap>
        <Link href="http://www.incompleteideas.net/IncIdeas/BitterLesson.html">The Bitter Lesson（Sutton, 2019）</Link>
        <Link href="https://arxiv.org/abs/2208.11173">The Alberta Plan for AI Research</Link>
        <Link href="https://arxiv.org/abs/2202.03466">Reward-respecting Subtasks</Link>
        <Link href="https://www.amii.ca/videos/oak-architecture-rich-sutton-rlc2025">OaK 官方演讲页（Amii）</Link>
        <Link href="https://www.youtube.com/watch?v=gEbbGyNkR2U">RLC 2025 完整 OaK 演讲</Link>
        <Link href="https://cursor.com/docs/agent/overview">Cursor Agent 官方架构</Link>
        <Link href="https://docs.anthropic.com/en/docs/claude-code/sub-agents">Claude Code subagents 官方文档</Link>
      </Row>
    </Stack>
  );
}

export default function WAICOakAnalysis() {
  const [view, setView] = useCanvasState<View>("view", "结论");
  const t = useHostTheme();

  return (
    <Stack gap={22} style={{ padding: 24, maxWidth: 1180, margin: "0 auto" }}>
      <Stack gap={8}>
        <Row align="center" justify="space-between" gap={16} wrap>
          <H1>WAIC 2026 · Richard Sutton OaK 演讲核验与 Agent 启示</H1>
          <Pill active>录音 + PDF + 15 张现场照片 + 原始论文</Pill>
        </Row>
        <Text tone="secondary">
          核心主题：从第一人称经验中形成持续学习、时间抽象、世界模型与规划，而不是继续扩大静态预训练本身。
        </Text>
      </Stack>

      <Grid columns={4} gap={12}>
        <Stat value="71 min" label="原始录音" />
        <Stat value="15" label="现场 slide 照片" />
        <Stat value="8" label="已标出的豆包误差/过度推断" tone="warning" />
        <Stat value="高" label="核心技术结论置信度" tone="success" />
      </Grid>

      <Row gap={8} wrap style={{ borderBottom: `1px solid ${t.stroke.tertiary}`, paddingBottom: 10 }}>
        {views.map((item) => (
          <Pill key={item} active={view === item} onClick={() => setView(item)}>
            {item}
          </Pill>
        ))}
      </Row>

      {view === "结论" && <SummaryView />}
      {view === "与编程 Agent 对比" && <AgentComparisonView />}
      {view === "学习与落地" && <LearningView />}
      {view === "豆包纠错" && <CorrectionsView />}

      <Divider />
      <Sources />
    </Stack>
  );
}
