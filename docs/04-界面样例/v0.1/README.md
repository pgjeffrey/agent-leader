# 指挥 Agent 静态线框原型 v0.1

## 交付文件
- `command-agent-wireframe-v0.1.png`（2400×1960，中文静态线框，可直接打开查看）
- `render_prototype.py`（由文档示例数据生成该 PNG，非正式产品代码）

## 文档依据（未改写需求原文）
1. 指挥 Agent 产品需求文档 PRD v0.1  
   产品经理 bot（c579d3d0-9a17-4598-97f4-5cfe8caba6db）于 2026年11月24日 12:54（Asia/Shanghai）交付  
   https://cursor.com/canvas/store-677ff2fa-7a30-4969-b3db-3d9af3954dbf/c5339b29-2ec5-4fda-b7bd-4f3565921bfe  
   canvas_id: `c5339b29-2ec5-4fda-b7bd-4f3565921bfe`  
   状态：待评审草案；Library 中未见更新版本；附件目录为空。

2. 指挥 Agent 交互设计方案 v0.1  
   UE交互设计师 bot（7fdcca21-5fba-465b-8662-3c8363650533）于 2026年11月24日 13:03（Asia/Shanghai）交付  
   https://cursor.com/canvas/store-677ff2fa-7a30-4969-b3db-3d9af3954dbf/7208c189-51de-46b9-840e-9c121593c281  
   canvas_id: `7208c189-51de-46b9-840e-9c121593c281`  
   状态：可迭代工作文档，依据上述 PRD。

## 原型说明
- 画面 1：指挥入口「目标与对话」（交互方案中的常驻入口），并同时露出任务、实例、事实、验收与待办。
- 画面 2：交接包 H-07（从画面 1 的立即处理请求打开），展示换人、无法托管与接收确认。
- 产品形态（CLI / API / 桌面 / 插件）仍待确认（PRD Q2），本图是工作面线框示意，不是视觉定稿，也不是可运行界面。

## 示例数据（虚构，仅用于演示）
- 示例项目：登录模块错误处理与测试补齐
- 角色绑定示例（可改绑，非写死）：规划 = Gemini，实现 = Codex
- 任务 T1–T4、实例 I-12 / I-21 / I-22、交接包 H-07、产物 login-error-spec.md（spec-012）
