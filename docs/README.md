# Agent Leader 项目文档中心

本目录归集 **Agent Leader** 的产品需求基线、系统技术架构方案、界面视觉样例以及早期评审归档文档。

---

## 一、当前生效研发基线（以此为准）

进入代码重构与正式研发前，统一以以下三份文档为最新基准：

1. **[Agent Leader 产品需求文档（PRD v0.2 · 已对齐基线版）](01-产品需求文档-PRD-v0.2/Agent-Leader-产品需求文档-PRD-v0.2.md)**
   - 确立产品定位：面向个人开发者的纯本地（macOS / Windows）单一入口多智能体指挥系统。
   - 明确核心闭环：后台对接独立指挥大模型（阶段化拆解 → 调用 Codex 等执行器并实时监控 → 结合回复与客观证据评判 / 返工 / 动态二次拆分子任务 / 换人交接）。
   - 收录完整可指挥智能体清单：**48 款开箱/目录智能体**（6 核心原生 + 6 内置扩展 + 36 标准 ACP 目录）+ 自定义扩展。
2. **[Agent Leader 系统技术架构与实施规划（v0.3）](03-系统架构方案-v0.3/Agent-Leader-系统技术架构与实施规划-v0.3.md)**
   - 确立工程架构：参考 Paseo 独立自建执行底座，采用「单仓 Monorepo + 运行态本地 C/S 双进程（`127.0.0.1` Daemon + Client）」。
   - 涵盖模块设计：`Leader Brain` 三大决策器、DAG 动态拆解护栏、`Codex` 原生与通用 `ACP` 适配器、Git Worktree 隔离、防双写换人状态锁、macOS/Windows 跨平台子进程治理、SQLite 存储及 6 阶段实施路线图（Phase 1–Phase 6）。
3. **[多 Agent 统一控制与数据回传系统架构方案（Runtime 专项规范）](multi_agent_control_and_data_return_plan.md)**
   - 从 Paseo 提炼的底层执行运行时实现级规范：定义 `AgentClient` / `AgentSession` 接口、五类异构驱动模式、`AgentMessageDelivery` 保序调度、`TimelineProjection` 单调序号投影与裁剪、`FinishSubscriptions` 异步回传及十条防坑铁律（注：本项目实施时裁剪掉其中的跨机器远端路由，仅保留本机模式）。
4. **[界面视觉与交互基线（v0.8 工作台 + 可点击原型截图）](04-界面样例/README.md)**
   - 最新静态布局基线：[04-界面样例/v0.8/工作台-精简文案.png](04-界面样例/v0.8/工作台-精简文案.png)
   - 可点击原型对照截图：[04-界面样例/可点击原型截图/](04-界面样例/可点击原型截图/)

---

## 二、完整目录结构

```text
docs/
  README.md                                                    本说明（文档总索引）
  01-产品需求文档-PRD-v0.2/
    Agent-Leader-产品需求文档-PRD-v0.2.md                       【当前基线】正式产品需求书
  03-系统架构方案-v0.3/
    Agent-Leader-系统技术架构与实施规划-v0.3.md                 【当前基线】工程总体技术架构与分阶段规划
  multi_agent_control_and_data_return_plan.md                  【当前基线】底层多 Agent 控制与数据回传专项规范
  04-界面样例/
    README.md                                                  界面样例总览
    v0.8/                                                      【当前基线】最新静态视觉：工作台-精简文案
    可点击原型截图/                                             工作台、任务详情、交接、新建项目运行截图
    v0.1/ · v0.2/ · v0.5/ · v0.6/ · v0.7/                      早期界面演进留档
  01-产品需求文档-PRD-v0.1/                                     【历史归档】早期 Cursor Canvas 导出草案
    指挥Agent-产品需求文档-PRD-v0.1.md
    source.canvas.tsx
  03-系统架构图-v0.2/                                           【历史归档】早期逻辑架构草案
    Agent-Leader-系统架构图-v0.2.md
    source.canvas.tsx
    workbench-v08.png
```

---

## 三、早期在线 Canvas 归档参考

早期草案由对应 Cursor Page 导出保留在历史归档目录中，未改写原文：

1. [指挥 Agent 产品需求文档 PRD v0.1](https://cursor.com/canvas/store-677ff2fa-7a30-4969-b3db-3d9af3954dbf/c5339b29-2ec5-4fda-b7bd-4f3565921bfe)（`c5339b29-2ec5-4fda-b7bd-4f3565921bfe`）
2. [指挥 Agent 交互设计方案 v0.1](https://cursor.com/canvas/store-677ff2fa-7a30-4969-b3db-3d9af3954dbf/7208c189-51de-46b9-840e-9c121593c281)（`7208c189-51de-46b9-840e-9c121593c281`）
3. [Agent Leader 系统架构图 v0.2](https://cursor.com/canvas/store-677ff2fa-7a30-4969-b3db-3d9af3954dbf/1b1ba1eb-170c-4367-a933-8f103e6e09dd)（`1b1ba1eb-170c-4367-a933-8f103e6e09dd`）
