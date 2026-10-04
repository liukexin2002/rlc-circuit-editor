# NOTICE — 修改声明与上游归属

本仓库是 **EasySchematic** 的衍生作品（fork），依据上游的 **AGPL-3.0** 许可发布。

## 上游

- 项目：EasySchematic — Browser-based AV signal flow diagram tool
- 来源：https://github.com/duremovich/EasySchematic
- 作者：duremovich
- 许可：GNU Affero General Public License v3.0（全文见本仓库 `LICENSE`）
- 分叉基线提交：`57724b3`（"Fixture: EU/UK power bench for the new connector types (#390)"）

## 本衍生作品所做的修改

本次修改的目标是交付一个**独立的 RLC（电阻/电感/电容）电路图编辑器**，并复用上游已经过验证的正交 A\* 布线引擎。具体改动如下：

1. **新增独立编辑器（`src/rlc/`）**
   - `rlcModel.ts` — RLC 元件/连线文档模型，四向引脚几何（上/下/左/右）
   - `rlcRouting.ts` — 将 RLC 文档桥接到上游 A\* 引擎的适配层：引脚方向约束、残线避让、可靠性度量
   - `rlcConstants.ts` — 网格、符号跨度、障碍外扩、残线长度等常量
   - `rlcGeometry.ts` / `rlcSymbols.ts` — 命中检测、吸附、符号路径生成
   - `rlcStore.ts` — 编辑器状态、撤销/重做、导入导出、自动保存
   - `RlcEditorCanvas.tsx` / `RlcEditorApp.tsx` / `mainRlc.tsx` — 画布与界面外壳

2. **对上游核心文件的向后兼容增强（`src/pathfinding.ts`）**
   - `astarOrthogonal()` 新增两个**可选**参数 `startDirExplicit` / `endDirExplicit`，用于表达
     四个方向的出入线约束（上游原本只支持水平方向）。两个参数省略时，行为与上游完全一致。

3. **新增构建与测试入口**
   - `vite.config.rlc.ts` + `rlc-web/` — 独立静态构建（不启用 PWA/Service Worker）
   - `src/__tests__/rlc/` — 模型与路由规则单测
   - `e2e-rlc/` + `playwright.rlc.config.ts` — 浏览器端到端冒烟测试
   - `package.json` 新增脚本：`dev:rlc`、`build:rlc`、`preview:rlc`、`test:e2e:rlc`

4. **未修改的部分**
   上游 AV 编辑器的应用代码、器件库、路由规则与其 1482 个既有测试全部保留且未被削弱；
   上游 LICENSE 全文保留在本仓库，未移除任何版权与许可声明。

## 许可义务

依据 AGPL-3.0：

- 本仓库**公开**，任何人可获取完整源码；
- 通过网络提供服务时的源码提供义务已由公开仓库满足；
- 本仓库保留上游版权声明与 `LICENSE` 全文。

## 第三方依赖

本仓库沿用上游的依赖集合（React、Vite、Zustand 等，均为各自许可的原作者作品），
并新增/使用以下依赖构建产物：无。RLC 编辑器本身不引入任何新的运行时依赖。
