# SVG视图导出

[返回总索引](../README.md) · [交互索引](./README.md)

核验口径：2026-10-16 对当前源码作静态核对；相关自动测试已在本轮统一运行，结果见[验证报告](../验证/01-验证范围与结果.md)。本轮没有新增 Web/桌面全套手工复验。

## 入口与状态

- 左工具栏点击「导出」图标，在右向菜单选择「画布 SVG」下载当前流程视图，导出范围不局限于当前屏幕可见节点。
- 导出包含节点、连线、当前层便签及连接线，使用局部展示编号和主题基础颜色。
- 这是视图文件，不是可重新导入的工作流定义。

## 操作步骤

1. 在目标层级点击导出；浏览器创建并下载 SVG Blob。
2. 用 SVG 查看器打开，检查整图边界、分支和便签内容。
3. 需要结构复用时用同一菜单的「流程 JSON」或另存为；当前没有 SVG 导入流程。

## 调用链与边界

`exportSvg → svgForWorkflow → nodeSize/portY + noteContentSvg → Blob/ObjectURL/download`。字符串进行 XML 转义；便签排版使用浏览器字体测量，无法测量时有估算 fallback，不使用 HTML foreignObject。

导出仅是客户端渲染，不调用 Graphon。当前 SVG 是简化静态视图，不承诺像素级复制所有控件、节点配置、运行状态或富文本能力；没有 PNG/PDF 导出。可执行结构的 JSON/ZIP 导入导出使用独立数据格式，见[导入导出说明](23-JSON导入导出与待处理.md)。

## 源码与验证证据

源码：[canvas.tsx](../../../src/client/canvas.tsx)、[note-content.ts](../../../src/client/note-content.ts)、[notes.ts](../../../src/client/notes.ts)、[nodes.ts](../../../src/client/nodes.ts)。

- [note-content.test.ts](../../../tests/note-content.test.ts)：实际SVG文本排版、转义与宽度边界。
- [viewport.test.ts](../../../tests/viewport.test.ts)：节点与分支几何。

SVG 下载交互没有专门端到端测试；本次未触发浏览器下载或检查导出的新文件。

关联：[连线与分支出口](./06-连线与分支出口.md)、[便签与节点连接](./18-便签与节点连接.md)、[自动整理](./21-自动整理.md)。
