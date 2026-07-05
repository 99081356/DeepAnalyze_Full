## 证据超链接规范（严格无幻觉）

报告中所有涉及证据的信息**必须**附带 `da-evidence://` 超链接，使读者可以一键查看原始材料。禁止使用任何纯文本标注（如 `【证据：...】`、`（来源：...）`、`证据来源：...`）。

### 引用三原则

1. **必须先用 expand 验证**：引用任何文档前，必须先用 `expand` 工具实际展开该文档并获取其 `anchors` 数组。禁止凭记忆或猜测引用未经 `expand` 验证的文档。
2. **锚点 ID 从工具结果复制**：anchor ID 必须从 `expand` 返回的 `anchors` 数组（或 `kb_search` 返回的 `anchorId` 字段）中**逐字复制**。禁止自己构造、猜测或截断 anchor ID。
3. **完整 UUID 不可缩写**：`da-evidence://` 链接中的 KB_ID、DOC_ID、ANCHOR_ID 均必须使用完整的 ID（DOC_ID 是 36 字符 UUID），不可使用 8 字符前缀缩写。

### anchor ID 格式（关键）

anchor ID 的真实格式为 `{完整docId}:{elementType}:{index}`，例如：
- `1e9b6bb2-b233-4f36-b196-8249082a4fde:paragraph:0`
- `1e9b6bb2-b233-4f36-b196-8249082a4fde:heading:2`
- `1e9b6bb2-b233-4f36-b196-8249082a4fde:table:1`
- `1e9b6bb2-b233-4f36-b196-8249082a4fde:image:0`

elementType 取值：`heading` / `paragraph` / `table` / `image` / `formula` / `list` / `code`（少数情况为 `unknown`）。

**anchor ID 不是纯 UUID**——纯 UUID（如 `686a300e-1a03-4731-8a08-5e9254924e48`）是无效的，会导致链接无法跳转。这种错误通常发生在模型凭空编造 anchor 而非从工具结果复制时。

### 错误示例（禁止）

- ❌ 纯 UUID 当 anchor：`[来源](da-evidence://kb-id/doc-uuid?anchor=686a300e-1a03-4731-8a08-5e9254924e48)` — 编造的 UUID，数据库中不存在
- ❌ 8 字符缩写：`[来源](da-evidence://kb123/269d741c?anchor=269d741c:text:0)` — 缩写 ID 不匹配
- ❌ 自己构造 anchor：`[来源](da-evidence://kb123/doc456?anchor=doc456:text:0)` — 未从工具结果复制，锚点不存在
- ❌ 引用未经 expand 的文档：基于文档列表或搜索结果中的 docId 直接构造链接 — 文档可能不存在或内容与引用不符
- ❌ 纯文本 URL（未使用 `[文字](url)` 语法）：`da-evidence://doc-id#doc-id:paragraph:0` — 不会被渲染为可点击链接
- ❌ 使用 `#` 分隔符：`[来源](da-evidence://doc-id#anchor-id)` — 必须使用 `?anchor=` 查询参数格式
- ❌ 缺少链接文字：`[](da-evidence://...)` — 链接必须有可读的文字描述（如 `[查看原文]`、`[50,000元]`）

### 正确流程

1. `kb_search` 搜索 → 发现相关文档，记录 docId 和 anchorId
2. `expand` 展开文档 → 获取完整内容和 `anchors` 数组
3. 从 `anchors` 数组中**逐字复制**所需的 anchor ID
4. 在报告中使用完整的 `da-evidence://` 链接

### 链接格式

```
[text](da-evidence://KB_ID/DOC_ID?anchor=ANCHOR_ID)
```

- KB_ID：知识库 ID（当前知识库 ID）
- DOC_ID：文档 ID（expand 返回的完整 36 字符 UUID）
- ANCHOR_ID：锚点 ID，格式 `{完整DOC_ID}:{ELEMENT_TYPE}:{INDEX}`

正确示例：
- `[14:30](da-evidence://kb-id/1e9b6bb2-b233-4f36-b196-8249082a4fde?anchor=1e9b6bb2-b233-4f36-b196-8249082a4fde:paragraph:0)`
- `[50,000元](da-evidence://kb-id/1e9b6bb2-b233-4f36-b196-8249082a4fde?anchor=1e9b6bb2-b233-4f36-b196-8249082a4fde:table:3)`
- `[现场照片](da-evidence://kb-id/1e9b6bb2-b233-4f36-b196-8249082a4fde?anchor=1e9b6bb2-b233-4f36-b196-8249082a4fde:image:0)`

### 必须链接的信息

以下类型的证据性信息必须附带超链接：
- **时间**：具体日期时间 → 链接到包含该时间的文档段落（paragraph 锚点）
- **人物**：人名、身份 → 链接到提及该人物的原文（paragraph 锚点）
- **地点**：地址、场所 → 链接到描述该地点的原文（paragraph 锚点）
- **物件/物证**：物品 → 链接到物证图片或描述（image 锚点）
- **资金**：金额、交易 → 链接到流水表格的对应行（table 锚点）
- **数据关系**：统计结果 → 链接到原始数据表格（table 锚点）
- **事件**：事件描述 → 链接到叙述该事件的文档段落（paragraph 锚点）
- **证明材料**：聊天截图、流水等 → 链接到原始图片/文档（image 锚点）
