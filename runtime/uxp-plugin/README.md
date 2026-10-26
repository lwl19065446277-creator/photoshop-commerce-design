# Photoshop UXP 插件

最低 Photoshop **24.2**，使用 Manifest v5、UXP API v2。此目录是可加载的开发插件，不依赖 Node.js 模块或浏览器鼠标自动化。

1. 启动根目录 Node 本地服务，确认生成 `.studio/connection.json`。
2. 在 Adobe **UXP Developer Tool** 中 Add Plugin，选择本目录 `manifest.json`，Load。
3. Photoshop → 插件 → Design Agent Studio。点“选择连接文件并连接”，选择项目 `.studio/connection.json`。
4. 服务的连接诊断和 `ping` 收到插件真实返回后，才能称为 Photoshop 连接通过。

需要在 Photoshop 启用开发者模式并允许本地插件权限。`localFileSystem: fullAccess` 是按服务指定的本地工作副本和素材路径执行所需；网络仅允许 `http://127.0.0.1:57123`。连接密钥只从选择的文件读入内存，面板不展示、不持久化、不记录密钥。

插件串行拉取命令，只运行内置操作白名单，没有执行任意 JS、系统命令或外部 BatchPlay 描述符的接口。文件保存仅创建新路径，拒绝覆盖。修改/关闭仅允许本插件通过 `open_document` 打开的受管文档；Node 服务负责先复制原始 PSD/PSB。图层查找必须精确且唯一。所有修改进入 `executeAsModal`，图层修改使用单个可撤销历史状态，失败时请求回滚；保存文件不在 Photoshop 历史回滚范围内，失败生成的文件应保留审查。

源模板支持 `.psd` 和 `.psb` 工作副本，第一版交付格式仍为 PSD。画布任一边超过 PSD 的 30,000 像素限制时明确返回 `PSD_LIMIT_EXCEEDED`；文件大小、位深或其他 Photoshop 保存限制由真实保存 API 返回具体错误。不会为了导出成功而自动扁平化、缩小或覆盖源模板。PSB 文件可否导出为保留图层的 PSD 仍需目标 Photoshop 实测。

PNG/JPG 预览及成品图采用单个 `executeAsModal` 内的临时合并副本。副本通过官方 `Document.changeMode(ChangeMode.RGB)` 转为 RGB，再用 `convertProfile("sRGB IEC61966-2.1", Intent.RELATIVECOLORIMETRIC, true, true)` 转 sRGB，核对模式和配置文件后保存；转换错误或回读不一致返回 `UNSUPPORTED_PREVIEW_MODE`，不会将 CMYK 直接交给 PNG 保存。临时副本注册自动关闭，并在正常或出错路径通过 `DONOTSAVECHANGES` 关闭；清理失败会明确报错，禁止把结果当作成功。原始工作文档及 PSD 交付仍保留 CMYK、图层和原图层 ID，PSD 保存还显式保留 Alpha/专色通道。

这是屏幕图导出路径，不能当作印刷打样。`changeMode(RGB)` 受本机 Photoshop 工作 RGB 设置和源 ICC 影响，再转换 sRGB 可能发生色域映射；未指定/丢失的源 ICC、专色、油墨与屏幕表现仍须人工核对。返回的 `color` 元数据含源模式/配置文件、渲染目标 sRGB 及 `requiresColorReview:true`。不声称 CMYK 与 RGB 数值或印刷外观完全相同，也不把转换过的 PNG/JPG替代可编辑 CMYK PSD。PNG 的 ICC 元数据具体保存行为仍需真实文件检验；当前验证仅核对临时文档的渲染配置文件。

`create_text` 的 x/y 是 Photoshop 文字插入点（近似左下角基线），不是文字边界左上角。图层 bounds 使用 `boundsNoEffects`，仍可能包含素材透明边、蒙版或其他非主体因素，不能当成真实商品主体边界。均匀缩放不改变宽高比；存在链接图层时拒绝自动变换，以免同时改动其他图层。

智能对象替换采用 `placedLayerReplaceContents` 与当次 UXP File session token，只接受嵌入智能对象；链接或无法读取嵌入状态的对象暂停人工检查。此 Photoshop 动作描述符和商品替换后几何行为必须用目标版本/真实 PSD 验证。读取源文件并不改写素材；视觉正确性仍需预览审查。输出 PSD 保留图层，PNG/JPG 用 `asCopy=true`。

读取文字及核对文案仅统一 CRLF/CR 为 LF，保留其余文字、空格和符号；写入原文后进行规范化换行回读核对。

断开按钮会让已在执行的命令结束，并拒绝下一条未执行命令。轮询循环正常停止后调用 `POST /plugin/disconnect {sessionId}` 释放会话；失败仅记录，不重放操作。通信失败会停止拉取，禁止自动重放。插件重载会清空受管文档集合，因此旧文档不能自动继续修改；需从原始 PSD/PSB 创建新工作副本再运行。

Node 中的适配器合约测试只验证分派、参数、文档边界和错误处理，**不能证明 Photoshop 或 PSD 导出已通过**。

已核对官方资料（2026-10-21）：

- [Manifest v5 权限](https://developer.adobe.com/photoshop/uxp/2022/guides/uxp-guide/uxp-misc/manifest-v5/)
- [executeAsModal 和历史回滚](https://developer.adobe.com/photoshop/uxp/2022/ps-reference/media/executeasmodal)
- [Document 保存与文字创建](https://developer.adobe.com/photoshop/uxp/2022/ps-reference/classes/document)
- [ChangeMode、DocumentMode 和 Intent](https://developer.adobe.com/photoshop/uxp/2022/ps-reference/modules/constants)
- [在线查看时使用 sRGB](https://helpx.adobe.com/photoshop/desktop/adjust-color/color-profiles/manage-documents-colors-for-online-viewing.html)
- [PNG 支持的颜色模式](https://helpx.adobe.com/photoshop/desktop/save-and-export/export-files-to-different-formats/image-file-formats-supported-in-photoshop.html)
- [Layer 读取、缩放、移动](https://developer.adobe.com/photoshop/uxp/2022/ps-reference/classes/layer)
- [TextItem](https://developer.adobe.com/photoshop/uxp/2022/ps-reference/classes/textitem)
- [文件 Entry 和 session token](https://developer.adobe.com/photoshop/uxp/2022/uxp-api/reference-js/modules/uxp/persistent-file-storage/storage)
- [BatchPlay](https://developer.adobe.com/photoshop/uxp/2022/ps-reference/media/batchplay)
- [PSD/PSB 格式和尺寸限制](https://www.adobe.com/devnet-apps/photoshop/fileformatashtml/)
