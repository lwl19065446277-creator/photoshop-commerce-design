# Photoshop Commerce Design

**项目名称：`photoshop-commerce-design`**

一个可供 Codex 和其他具备本地工具能力的 AI 使用的 Photoshop 电商设计 Skill。将只读 Excel / 飞书需求整理为设计任务，核对商品与价格，通过真实 Photoshop 制作分层 PSD、独立活动场次、透明图标及商品长图切片。

## 从这里开始

- AI 执行入口：[SKILL.md](SKILL.md)
- 安装及跨 AI 使用：[使用说明.md](使用说明.md)
- 可搬运本地执行代码：[runtime/](runtime/)
- Photoshop 配置及接口边界：[执行说明](references/photoshop-runtime.md)

将仓库下载或克隆为 `photoshop-commerce-design` 文件夹。Codex 使用者可把整个文件夹放入自己的 `~/.codex/skills/`；其他平台按其 Skill 安装方式配置，或直接要求 AI 先读取 `SKILL.md` 及相关参考。

```text
使用 $photoshop-commerce-design，根据我提供的只读需求表和授权素材完成设计。
先检查真实 Photoshop 连接，核对商品、场次和价格，再执行操作计划。
保留可编辑 PSD、真实预览、切片与执行回执；不要覆盖源文件或伪造成功。
```

## 包含的方法

- 需求字段映射、富文本删除线、合并块与版本差异；共享公式内部编号变化不误报为业务变化。
- 表外素材绑定，商品ID / SKU / 颜色核对，正价与秒杀分场景取价。
- 从参考提炼字体层级、网格、留白、配色、摄影接缝与渐变蒙版，而非固定套用同一版式。
- 原版双列商品卡、独立内嵌智能对象、价格效果保留，以及每4款切片。
- 多时间场次独立交付，全天与4小时文案匹配，规则正文日期同步。
- PSD 保存后实际重新打开，核对文字、字体、边界、Alpha、输入散列、切片像素和交付包。

详细内容见 [references/](references/)。特定双11日期、售价与原版结构单独放在 [案例说明](references/double11-case.md)，不能当作其他项目的通用规则。

## 运行与验证边界

将 `runtime/` 的内容复制到新的任务工作目录，配置用户授权素材目录，再运行：

```powershell
npm ci
npm run typecheck
npm run build
npm test
```

Python 标准库辅助工具测试：

```powershell
python -m unittest discover -s scripts -p "test_*.py" -v
```

便携版本已通过102项 Node 测试、7项 Python 测试及本地HTTP/MCP未连接检查，记录见 [validation.json](references/validation.json)。这些检查不操作 Photoshop。历史项目的真实交付使用 Windows COM / ExtendScript，明确记为 `real-com`；附带 UXP 代码尚未计为实机验证通过。换设备后必须重新建立和验证实际通信链路。

使用 Skill 不会自动获得 Photoshop、本地执行权限或素材访问权限。仓库不附带商品照片、品牌 PSD、真实需求表、字体、账号密钥或第三方软件；必须自行提供获准使用的资源。

源表与素材只读，工作表中的路径不作为素材授权。所有文件修改仅在新的运行副本中进行。指令超时或回执丢失时停止检查，不自动重放。
