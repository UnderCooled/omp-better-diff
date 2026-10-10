# omp-better-diff

OpenCode 风格的 diff 卡片，替换 omp 内置 `edit` / `apply_patch` 工具结果的渲染。

内置渲染器把 diff 画成一条扁平的着色行流；本扩展重新排版同一份 `details.diff`，给出分栏 / 统一 / 紧凑 / 摘要四种布局，并重建卡片顶栏的操作、路径、`[+n/-n]` 与增删进度条。

## 特性

- **顶栏**：`Edit: <lang icon> src/foo.ts [+7/-1] ━━━━[━━━━━]`，左侧是操作与目标路径（含 `source → dest` 移动），右侧是按增删比例着色的进度条。
- **分栏 (split)**：左右两列，删行在左、增行在右、上下文两侧重复；中间分隔列同时充当改动标记。
- **统一 (unified)**：行号槽 + 改动标记 + 代码三段式，行号槽带混合背景色，与代码本体在视觉上分离。
- **行内词级高亮**：位置对齐的 `-` / `+` 行对，用 inverse 标出真正改动的词，与宿主自己的行内处理保持一致。
- **紧凑 (compact)**：无行号，只留一个标记列，给窄面板用。
- **摘要 (summary)**：`↳ diff +7 -1 • 1h` 一行式，宽度过小时的兜底。
- **折叠**：卡片收起时最多显示 `collapsedLines` 行，尾部标注 `… +N more lines`；展开状态由宿主控制。
- **行标记 `hatch`**：改动行的分隔列换成 `░`，与上下文行的 `│` 区分；不靠整行底色（底色在暗色主题下任何强度都读成噪点）。

## 安装

扩展只在 omp 运行时加载，`package.json` 未声明 `dependencies`，仓库里也没有 `node_modules`：`@oh-my-pi/*` 由扩展加载器重写到进程内的宿主代码，本目录不需要 `npm install`。单个扩展路径的 import 或工厂失败会被单独记录，不会中断其他扩展的加载，出问题时按路径查即可。

任选一种加载方式：

**1. 用户级自动发现**（所有会话生效）

```text
~/.omp/agent/extensions/
  omp-better-diff/
    package.json     # { "omp": { "extensions": ["./index.ts"] } }
    index.ts
    src/diff-view.ts
```

**2. 项目级自动发现**（只在该项目生效）

```text
<repo>/.omp/extensions/omp-better-diff/   # 同上目录结构
```

**3. 配置显式路径**

```yaml
# ~/.omp/agent/config.yml
extensions:
  - ~/repos/omp-better-diff
```

**4. 命令行**

```bash
omp -e /path/to/omp-better-diff
```

同一路径同时被自动发现和显式配置时按绝对路径去重，只加载一次。

### 启用 / 停用

扩展 id 由入口路径推导（`omp-better-diff/index.ts` → `omp-better-diff`）：

```yaml
# ~/.omp/agent/config.yml
disabledExtensions:
  - extension-module:omp-better-diff
```

或直接 `omp --no-extensions` 跳过全部扩展发现。

## 使用

扩展加载后自动接管 `edit` 与 `apply_patch` 两个工具的 `renderResult`，无需额外开关。配置用斜杠命令：

```text
/better-diff                    # 打印当前配置
/better-diff split              # 固定分栏
/better-diff unified hatch      # 统一布局 + 改动行阴影标记
/better-diff 12                 # 折叠时显示 12 行
/better-diff auto none reset    # 恢复默认
```

参数可混用、顺序不限；无法识别的词只警告不中断。配置存在模块级内存里，**不落盘，重启会话即回到默认值**。

| 参数 | 取值 | 默认 |
| --- | --- | --- |
| `mode` | `auto` / `split` / `unified` / `compact` / `summary` | `auto` |
| `rowMarker` | `hatch` / `none` | `hatch` |
| 行数（纯数字） | `≥ 1` | `24` |
| `reset` | 恢复默认 | — |

`splitMinWidth`（`auto` 切分栏的宽度阈值，默认 110）命令行改不了，要改就动 `src/diff-view.ts` 的 `DEFAULT_DIFF_CONFIG`。

## 布局选择

宽度不足时显式 `mode` 也会被降级，保证每行都有可读空间：

| 内容宽度 | 布局 |
| --- | --- |
| `< 12` | `summary` |
| `< 34` | `compact` |
| `≥ 34`，显式 `split` 但列宽不足 28×2 + 3 | `unified` |
| 其余 `mode` | 按显式值 |
| `auto`，宽度 `≥ 110` | `split` |
| `auto`，宽度 `< 110` | `unified` |

此外整个卡片宽度 `< 100` 时（分栏放不下两列、顶栏也没有余量），直接回退到宿主自己的渲染器。

## 实现

```text
index.ts          扩展入口：接管渲染器 + /better-diff 命令 + 顶栏拼装
src/diff-view.ts  纯函数：diff 解析、四种布局、统计片段、折叠
```

- 只替换 `toolRenderers[tool].renderResult` 这一个槽位；调用行、流式预览、展开状态、诊断信息、多文件分叉仍归宿主所有。`renderCall` / 流式阶段不受影响。
- 拿不到 diff 就交给宿主：删除 / 移动、失败的编辑、多文件结果（`perFileResults.length !== 1`）都不走本扩展。
- `src/diff-view.ts` 除注入的 `DiffTheme` 外不查任何主题，因此可以脱离终端单测。
- 行号槽背景是把卡片背景与 `borderMuted` 在**线性光**下按 0.6 混合后输出的 truecolor 转义；sRGB 直接插值在暗端会把差异压没（16% 比例下对比度只有 1.17）。非 truecolor 终端返回 `undefined`，静默降级为无底色，绝不输出残缺转义。
- 所有布局行先按纯文本裁到目标宽度再上色，裁切永远不会切断 ANSI 转义序列而把背景色漏到后面。

## 已知限制

- 只覆盖 `edit` 与 `apply_patch`；`write`、`ast_edit` 等仍用宿主渲染。
- 一次编辑多个文件时不显示 diff 卡片，回退到宿主的多文件列表。
- `splitMinWidth` 无运行时入口。
- 扩展与宿主同进程、无沙箱；`disabledExtensions` 是唯一的事前停用手段。

## 验证

1. `omp` 启动后确认扩展已加载（`/better-diff` 能打印 `mode=auto splitMinWidth=110 collapsedLines=24 rowMarker=hatch`）。
2. 让模型做一次 `edit`，检查卡片顶栏的 `[+n/-n]` 与进度条、以及行号槽。
3. `/better-diff split` 后再编辑一次，确认切到分栏；把终端拖窄，确认按 `auto` 阈值降级且行不溢出。
