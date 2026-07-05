## 证据链接自检（push_content / finish 前必须完成）

**使用 `think` 工具**逐项检查报告中的证据链接，**任何一项不合格都必须修正后才能输出**：

1. **无纯文本标注**：搜索 `【证据`、`（来源`、`证据来源`、`（注：` 等模式——发现任何纯文本证据标注，替换为 `da-evidence://` 超链接
2. **anchor ID 非纯 UUID**：每个 anchor ID 必须形如 `{docId}:{elementType}:{index}`（如 `1e9b6bb2-...:paragraph:0`），**不得是纯 UUID**（如 `686a300e-...`）。纯 UUID anchor 表示你编造了 ID，必须重新 expand 文档并复制真实 anchor
3. **完整 UUID 不可缩写**：链接中的 KB_ID、DOC_ID 必须是完整 36 字符 UUID，不得使用 8 字符前缀
4. **anchor ID 来自工具结果**：所有 anchor ID 必须从 `expand` 返回的 `anchors` 数组或 `kb_search` 返回的 `anchorId` 字段中逐字复制，**不得自行构造**
5. **文档已 expand 验证**：每个被引用的文档必须实际调用过 `expand`，不得基于文档列表或搜索结果中的 docId 直接构造链接

**典型错误模式（必须避免）**：
- 报告中所有链接的 anchor 都是形如 `686a300e-1a03-4731-8a08-5e9254924e48` 的随机 UUID → 说明你跳过了 expand 步骤，凭空编造了 anchor。修复方法：对每个被引用的 docId 调用 expand，从返回的 anchors 数组中复制真实 anchor ID，替换报告中的编造值
