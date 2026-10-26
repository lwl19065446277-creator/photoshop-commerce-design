# 可搬运代码、真实执行与接口边界

## 准备工作目录

将 Skill 的 `runtime/` **内容**复制到新的任务目录，不在技能安装目录执行。需要 Node22+。执行代码前查看本地项目规则，配置 `studio.config.json`：

```json
{
  "port":57123,
  "allowedInputRoots":["assets-in"],
  "workbookRoots":["inputs"],
  "outputRoot":"runs",
  "commandTimeoutMs":90000
}
```

`assets-in` 是默认空的本地输入目录，不代表已授权外部磁盘；加入用户明确给定的真实目录。不要把盘符根目录、整个用户目录或表内路径自动加进去。原素材只读；运行素材工作副本保存在 `runs/` 并记录来源散列。

在工作目录运行：

```powershell
npm ci
npm run typecheck
npm run build
npm test
npm run studio -- doctor
```

这些自检不操作Photoshop。`doctor` 报告UXP桥接状态，不能据此判定COM链路。当前代码包含99项原有测试；以当次运行输出为准。测试里的模拟对象只在 tests 中使用。

## Windows COM：本案例已实机验证的路径

要求已安装可用的Adobe Photoshop和Windows PowerShell5.1。固定仓库脚本通过官方 COM `DoJavaScriptFile` 执行固定 JSX，JSON文案作为参数，不执行自由代码。

```powershell
npm run com -- ping
npm run com -- font_catalog
```

这会尝试连接或启动真实Photoshop，先在实际设计任务中再调用。成功时返回 `backend: real-com`、版本与当前文档；没有成功回执就不宣称连接成功。

`npm run com -- --help` 列出静态操作。参数用JSON文件：

```powershell
npm run com -- open_working_copy --args inputs/open-copy.args.json
npm run com -- inspect_document --args inputs/inspect.args.json
```

`open-copy.args.json` 为 `{"path":"绝对路径/runs/本次运行/working.psd"}`；源模板先经授权根校验和散列复制，不能直接打开原件改。`inspect.args.json` 为 `{"documentId":当次ID,"sourceWorkingPath":"同一工作副本绝对路径"}`。先读实际图层再使用 `set_text` 的 `layerId/expectedText/text`。

### 新画布与原版目录

支持 `render_design`（compose/extract）、`render_native_catalog`、`render_native_variant`、`export_native_slices`。计划格式见 runtime 的 `src/design/*.ts` 与生成的 `schemas/`，JSON Schema不能表达全部路径/跨字段约束，运行时Zod校验为准。

```powershell
npm run validate-plan -- runs/<run-id>/plan.json
npm run com -- render_design --args runs/<run-id>/args.json --timeout-ms 600000
```

`args.json` 只含 `{"path":"该plan.json的绝对路径"}`。输出必须是计划旁边尚不存在的文件。目录适配计划使用 `working.psd`、源散列、真实模板组ID、列/行步距、商品绑定、RGB渐变端点和切片；每批最多60款、最长30000px。新构图限20000px、600层。超限就分文档或扩展受限实现，不能静默裁图。

只验证接口时可生成无商品的文字/形状小样计划：

```powershell
python <skill-dir>/scripts/create_probe_plan.py --workspace . --font <刚查到的真实字体PostScript名>
npm run validate-plan -- runs/interface-probe/plan.json
npm run com -- render_design --args runs/interface-probe/args.json
```

生成计划不调用PS、不产生假PSD。只有后面实际执行并返回重开证据后，才算该机器的小样验证。该小样不能充当业务设计成品。

COM目前**没有通用的任意模板智能对象替换工具**。目录适配器通过新建独立内嵌对象更新灰底图；新构图支持图片/智能对象、文字、形状和蒙版。若需要任意PSD的指定智能对象替换、任意图层移动缩放，使用实际验证过的UXP工具或另写受限适配器，不能把目录功能泛化成已经实现全部PS操作。

### 并发与回执

入口使用 `.studio/skill-com.lock` 串行化此工作目录；其他AI或工作目录也不能向同一PS实例并发提交，需协调使用同一调度入口。渲染计划旁写独占 `skill-attempt.json` 和成功 `receipt.json`。变更失败后保留锁与 `needs-inspection.json`，不自动重试。先检查原命令结果、PS状态与部分输出，确认旧操作已结束后才人工处理锁/从新副本恢复；不能仅因等得久就删除锁。

底层命令/回执在 `.studio/com-commands/`，日志 `.studio/com-events.jsonl`。长目录可读 `native-progress.jsonl`，不要为探测进度同时发送多个COM操作。不要为了释放内存擅自清除用户历史或关闭用户文档。

## UXP与MCP：代码存在，换机须实测

历史V11验证的是COM，**UXP尚未实机验证**。附带UXP插件及Node HTTP/MCP服务，包含连接、文档/图层、文字、智能对象、可见性、位移/等比缩放、文字创建、预览、保存和PNG/JPG导出等结构化代码。MCP连接成功也不等于PS插件已连接。

```powershell
npm start
# 第二个终端：
npm run studio -- status
npm run studio -- mcp-config
```

用Adobe UXP Developer Tool加载 `uxp-plugin/manifest.json`，在PS插件面板选择服务生成的 `.studio/connection.json`。开发者模式/安装许可确实需要用户操作时再说明，不要求无关重复确认。连接文件含本地密钥，不复制分享。

`mcp-config` 只打印配置，不修改全局设置。把输出接入当前AI的MCP配置需遵循该环境要求。这个MCP服务复用UXP桥接，不把COM自动映射成MCP。只有插件实际连接并执行、回读文件后才能写 `real-uxp` 验证通过。

不另行开放公网端口，不把密钥发到浏览器页面。需要更换Adobe API/版本或接入其他宿主时查当时官方文档并在本机验证：
- [Photoshop UXP API](https://developer.adobe.com/photoshop/uxp/2022/ps_reference/)
- [Adobe UXP 插件](https://developer.adobe.com/photoshop/uxp/)
- [MCP 文档](https://modelcontextprotocol.io/docs)

## 快照维护

`runtime-provenance.json` 记录从原项目复制的代码散列。新增便携入口、默认配置及schema生成脚本会有本次适配。它是可独立测试的代码快照，不会自动同步主项目更新，也不携带本机验证权限或凭据。

本次制作 Skill 的离线测试和通信检查见 [validation.json](validation.json)，其中明确记录未调用真实 Photoshop。
