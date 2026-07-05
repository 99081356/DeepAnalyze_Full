# 第4组：知识库全生命周期与检索（8项）

---

## T29: 知识库完整生命周期——创建→上传→处理→分析→删除

### 测试设计
**知识库**：新建空知识库
**提示词**（多步骤操作）：
> 1. 创建新知识库"测试知识库"
> 2. 上传一组多类型测试文件，覆盖系统支持的全部格式：
>    - 3个PDF + 2张图片（PNG/JPG） + 1个音频
>    - 2个文本类：1个YAML + 1个SVG（验证 TextProcessor 路由）
>    - 2个文档类：1个DOCX + 1个RTF（验证 LibreOffice 转换链路）
>    - 1个表格：1个XLSX + 1个XLSM（验证 NativeTableProcessor）
>    - 1个Markdown（验证 Docling 结构化解析）
>    - 2个编码文本：1个GBK编码的TXT + 1个Big5编码的TXT（验证编码检测）
> 3. 等待处理完成，检查每类文件的处理质量
> 4. 对上传的文档进行分析
> 5. 删除知识库
> 6. 验证删除后数据完全清理

### 观察目标
1. **KB创建**：API返回201，前端KB列表出现新KB
2. **上传完整**：全部文件上传成功，文件路径正确
3. **处理进度**：前端DocumentCard显示正确的处理进度（5%→50%→100%）
4. **L0质量**：每个文档的摘要有意义（非空、非模板文本）
5. **L1质量**：PDF有正文内容（非仅有页码/页眉），图片有VLM描述
6. **L2质量**：PDF的Docling JSON结构完整
7. **文本格式解析**（C-234/C-235/C-236）：
   - YAML/YML：TextProcessor 正确解析键值结构，非当作二进制乱码
   - SVG：提取出文本内容（`<text>` 标签内容），非路由到 VLM 图片处理
   - MD：Docling 生成结构化 L1（标题/代码块/列表），非纯文本
   - TOML/INI/HTM：TextProcessor 正确读取为 UTF-8 文本
8. **LibreOffice 转换链路**（C-156增强）：
   - RTF：经 LibreOffice 转为 DOCX 后 Docling 解析，中文不乱码
   - ODT：同上，验证开放文档格式支持
   - PPT：经 LibreOffice Impress 转为 PPTX 后解析
9. **表格格式**：
   - XLSX/XLSM：NativeTableProcessor 生成正确的元数据描述（行数+列数+样本行）
   - CSV：同上
10. **编码检测**（C-234）：
    - GBK编码TXT：自动检测为GBK并正确解码为中文，非 mojibake
    - Big5编码TXT：自动检测为Big5并正确解码
    - UTF-8 BOM文件：正确识别并去除BOM
11. **分析可用**：expand/kb_search能正常检索到上传的文档
12. **删除彻底**：KB删除后，数据库记录清除、磁盘文件清除、搜索索引清除
13. **删除后验证**：搜索原KB内容返回空结果

### 未达标时的优化方向
| 问题 | 优化方向 |
|------|---------|
| 创建失败 | 检查KB创建API和目录创建逻辑 |
| 上传失败 | 检查multipart upload处理和磁盘写入 |
| 处理卡住 | 检查ProcessingQueue的worker和超时 |
| L0空文本 | 检查LLM摘要生成的prompt和fallback |
| 删除不彻底 | 检查CASCADE删除和磁盘清理逻辑 |
| YAML/SVG被当二进制 | 检查 detectFileType 返回值与 TextProcessor.HANDLED_TYPES 对齐 |
| RTF/ODT转换失败 | 检查 DocConverterProcessor 的 LibreOffice 调用和 CONVERT_TARGET 映射 |
| PPT转换失败 | 检查 libreoffice-impress 是否安装，CONVERT_TARGET.ppt=pptx |
| GBK/Big5乱码 | 检查 TextProcessor 编码检测链（BOM→ASCII→UTF-8→GBK→Big5→Latin-1） |
| MD无结构化 | 检查 detectFileType 返回 "md"（非 "markdown"），Docling HANDLED_TYPES 含 "md" |
| XLSM不处理 | 检查 NativeTableProcessor.HANDLED_TYPES 含 "xlsm" |

---

## T30: 跨知识库搜索与结果溯源

### 测试设计
**知识库**：同时绑定 bigtest + lbctest
**提示词**：
> 请搜索两个知识库中所有包含"证据"关键词的内容，标注每条结果来自哪个知识库。然后搜索两个库中所有包含"分析"关键词的内容。对比两个库中"证据"相关内容的差异。

### 观察目标
1. **跨库搜索**：kb_search使用两个kbId，返回结果来自两个库
2. **来源标注**：每条搜索结果标注来源KB名称
3. **结果去重**：同一文档不重复出现
4. **对比质量**：对比分析有实质内容（bigtest是虚构证据 vs lbctest是真实证据）
5. **搜索覆盖率**：关键文档都能被搜索到
6. **无混淆**：引用内容时不混淆来源

### 未达标时的优化方向
| 问题 | 优化方向 |
|------|---------|
| 搜索只返回一个库 | 检查cross-KB search的kbId数组解析 |
| 来源不标注 | 改进搜索结果格式，添加kbId字段 |
| 遗漏文档 | 增大topK或改进搜索策略 |

---

## T31: 知识库深度预处理效果验证

### 测试设计
**知识库**：bigtest
**提示词**：
> 请触发知识库的深度预处理（preprocessing），等待完成后：
> 1. 对比预处理前后，文档的L0摘要质量变化
> 2. 检查预处理生成的实体关系和时间线
> 3. 使用kb_search搜索预处理新增的内容
> 4. 评估预处理对搜索质量的影响

### 观察目标
1. **预处理触发**：API调用成功，进入processing状态
2. **进度可观测**：前端显示预处理进度
3. **L0改善**：预处理后的摘要比默认摘要更详细和准确
4. **实体提取**：Entity页面显示提取的人物、地点、组织等实体
5. **时间线生成**：Timeline页面显示按时间排序的事件
6. **搜索改善**：预处理后的搜索召回率提升（特别是跨文档关联搜索）
7. **耗时合理**：预处理不会超时或耗时过长

### 未达标时的优化方向
| 问题 | 优化方向 |
|------|---------|
| 预处理超时 | 检查preprocessing pipeline的timeout设置 |
| 实体不提取 | 检查entity-extractor的触发和LLM调用 |
| 搜索无改善 | 分析preprocessing添加的索引类型和权重 |
| 进度不显示 | 检查preprocessing status API和前端轮询 |

---

## T32: 文档重处理与质量对比

### 测试设计
**知识库**：bigtest
**提示词**：
> 选择知识库中一个已处理的PDF文档，强制重新处理它（reprocess, force=true）。对比处理前后的内容质量：
> 1. L0摘要是否改善
> 2. L1结构是否更完整
> 3. L2原始数据是否有变化
> 4. 搜索索引是否更新

### 观察目标
1. **重处理成功**：文档重新进入processing状态
2. **状态重置**：DocumentCard显示从processing重新开始
3. **内容更新**：处理后wiki_pages内容更新（非旧的缓存内容）
4. **索引重建**：搜索能找到更新后的内容
5. **旧内容清理**：旧的wiki_pages和embeddings被清理
6. **其他文档不受影响**：只重处理目标文档

### 未达标时的优化方向
| 问题 | 优化方向 |
|------|---------|
| 重处理不生效 | 检查force参数的传递和处理逻辑 |
| 旧内容残留 | 检查reprocess时的旧数据清理（DELETE wiki_pages, embeddings） |
| 索引不更新 | 检查reindex是否在reprocess后自动触发 |
| 影响其他文档 | 确认reprocess的范围隔离 |

---

## T33: 搜索模式对比（向量/BM25/混合）

### 测试设计
**知识库**：bigtest
**提示词**：
> 请分别使用以下三种搜索模式搜索"记忆机制"：
> 1. 向量搜索（semantic）
> 2. 关键词搜索（keyword/BM25）
> 3. 混合搜索（hybrid）
> 对比三种模式的搜索结果数量、相关性、覆盖率。评估哪种模式在这个查询上表现最好。

### 观察目标
1. **三种模式都可用**：kb_search的mode参数支持三种模式
2. **结果数量差异**：三种模式返回的结果数量有差异
3. **相关性差异**：向量搜索倾向语义相关，BM25倾向精确匹配
4. **混合模式优势**：hybrid模式的结果应该综合了前两者的优点（RRF融合）
5. **中文分词**：BM25模式对中文查询"记忆机制"正确分词
6. **搜索面板**：前端SearchTestPanel可以对比不同模式的结果

### 未达标时的优化方向
| 问题 | 优化方向 |
|------|---------|
| 模式不支持 | 检查kb_search的mode参数处理 |
| 结果相同 | 检查retriever的模式分支逻辑 |
| 中文分词差 | 检查zhparser扩展和BM25配置 |
| RRF融合无效 | 检查Reciprocal Rank Fusion的实现 |

---

## T34: 搜索饱和检测与去重

### 测试设计
**知识库**：bigtest
**提示词**：
> 请反复搜索知识库中与"RAG检索增强"相关的内容，每次使用稍微不同的关键词（"RAG"、"检索增强"、"知识检索"、"向量搜索"等），直到搜索结果不再有新增内容。记录每次搜索的新增结果数量。

### 观察目标
1. **饱和检测触发**：当Jaccard overlap > 80%时，Agent收到饱和信号
2. **搜索效率**：Agent不会无限搜索，饱和后自动停止
3. **去重有效**：不同关键词搜索到的相同文档被去重
4. **覆盖率**：最终所有相关文档都被找到
5. **工具调用合理**：搜索次数在3-8次之间（不过多不过少）

### 未达标时的优化方向
| 问题 | 优化方向 |
|------|---------|
| 无限搜索 | 检查search saturation detection的触发阈值和信号传递 |
| 过早停止 | 调整Jaccard阈值，降低过早饱和的风险 |
| 去重失败 | 检查搜索结果的dedup逻辑 |

---

## T35: Anchor锚点系统精确溯源

### 测试设计
**知识库**：lbctest
**提示词**：
> 请搜索知识库中所有包含金额信息的内容。对每条结果：
> 1. 展示具体的金额数值
> 2. 使用expand L2获取精确的段落位置
> 3. 标注anchor锚点（docId:type:index格式）
> 4. 确认每个金额都能通过锚点精确追溯到原文位置

### 观察目标
1. **锚点格式**：anchor格式为 `docId:type:index`（如 `doc123:body:5`）
2. **溯源验证**：每个锚点可通过expand/doc_grep验证到原文
3. **精度**：锚点定位到段落级别（不是文档级别）
4. **前端hover预览**：鼠标悬停锚点链接显示原文预览（AnchorHoverCard）
5. **点击跳转**：点击锚点跳转到文档对应位置
6. **覆盖完整**：所有主要金额信息都有锚点

### 未达标时的优化方向
| 问题 | 优化方向 |
|------|---------|
| 无锚点 | 检查anchor-generator的运行和存储 |
| 精度不够 | 改进anchor粒度到段落级别 |
| hover不显示 | 检查AnchorHoverCard组件 |
| 跳转失败 | 检查前端路由和DocumentViewer定位逻辑 |

---

## T36: 知识库文档CRUD压力测试

### 测试设计
**知识库**：bigtest
**提示词**（API级别测试）：
> 1. 上传20个文档到知识库（批量上传）
> 2. 立即删除其中10个文档
> 3. 再次上传5个新文档
> 4. 并行执行：搜索+上传+删除同时进行
> 5. 最终验证：文档数量与预期一致

### 观察目标
1. **批量上传不丢**：20个文件全部上传成功
2. **删除即时生效**：删除后搜索不再返回已删文档
3. **并发安全**：搜索+上传+删除并行不导致数据不一致
4. **处理队列**：新上传文档正确排队处理，不因并发操作遗漏
5. **最终一致性**：所有操作完成后，文档数量与预期一致
6. **磁盘清理**：删除文档后磁盘文件也被清理

### 未达标时的优化方向
| 问题 | 优化方向 |
|------|---------|
| 上传丢失 | 检查multipart upload处理和文件写入的并发安全 |
| 删除延迟 | 添加删除后的索引即时清理 |
| 数据不一致 | 添加数据库事务保护CRUD操作 |
| 处理遗漏 | 检查ProcessingQueue的并发安全 |

---

# 补充测试：多格式文档解析覆盖（C-234 ~ C-236）

> 以下测试用例覆盖 2026-06-23 新增的文件格式解析能力，确保系统对全部声明的文件类型都有正确的处理链路。

---

## T36a: 文本类格式解析覆盖（YAML/SVG/MD/TOML/INI/HTM）

### 测试设计
**知识库**：新建空KB
**操作**：依次上传以下文件，等待处理完成，逐一检查 L0/L1 内容：
1. `config.yaml`：YAML 配置文件（含嵌套结构、列表、注释）
2. `config.yml`：YAML 短扩展名变体
3. `diagram.svg`：SVG 矢量图（含 `<text>` 标签文字和 `<rect>`/`<path>` 图形）
4. `README.md`：Markdown 文档（含多级标题、代码块、表格、列表）
5. `settings.toml`：TOML 配置文件
6. `app.ini`：INI 配置文件
7. `page.htm`：HTML 文件（含表格和文本）

### 观察目标
1. **YAML/YML**（C-236）：
   - status=ready（非 error）
   - L0 摘要正确反映配置内容
   - L1 内容包含键名和键值（非二进制乱码）
   - 处理路径：TextProcessor（txt 策略）
2. **SVG**（C-236）：
   - status=ready
   - L1 提取出 `<text>` 标签内的文字（如 "流程图"、"开始"、"结束"）
   - 未路由到 VLM 图片处理（TextProcessor 路径）
   - 处理路径：TextProcessor（txt 策略）
3. **Markdown**（C-236）：
   - status=ready
   - L1 有结构化格式（标题层级、代码块高亮、列表缩进）
   - 非纯文本无格式
   - 处理路径：Docling（md 策略）
4. **TOML/INI**（C-236）：
   - status=ready
   - L1 内容包含配置键值
   - 处理路径：TextProcessor（txt 策略）
5. **HTM**（C-236）：
   - status=ready
   - L1 提取出 HTML 中的文本内容和表格数据
   - 处理路径：TextProcessor（txt 策略）

### 未达标时的优化方向
| 问题 | 优化方向 |
|------|---------|
| YAML 当二进制 | 检查 detectFileType("yaml")/("yml") 返回值，确认映射到 txt 策略 |
| SVG 无文本 | 检查 pipeline-strategies.ts 中 svg: "txt" 映射 |
| MD 无结构 | 检查 detectFileType("md") 返回 "md"（非 "markdown"），DoclingProcessor.HANDLED_TYPES 含 "md" |
| TOML/INI 不处理 | 检查 TextProcessor.HANDLED_TYPES 是否含 "toml"/"ini" |

---

## T36b: 文档类格式 LibreOffice 转换链路（RTF/ODT/PPT）

### 测试设计
**知识库**：新建空KB
**操作**：上传以下文件（包含中文内容），验证 LibreOffice headless 转换：
1. `document.rtf`：RTF 文档（含 Unicode 转义的中文字符 `\uNNNN?`）
2. `report.odt`：ODT 开放文档格式
3. `slides.ppt`：PPT 演示文稿（旧格式）
4. `legacy.doc`：DOC 文档（旧格式，验证原始支持）

### 观察目标
1. **RTF**（C-156增强）：
   - status=ready（非 error 或 timeout）
   - L1 内容为正确中文（非 mojibake 如 "æ ¼å¼" 乱码）
   - 处理路径：DocConverterProcessor → LibreOffice 转 DOCX → Docling 解析
2. **ODT**（C-156增强）：
   - status=ready
   - L1 内容完整提取
   - 处理路径：DocConverterProcessor → LibreOffice 转 DOCX → Docling
3. **PPT**（C-156增强）：
   - status=ready
   - L1 含幻灯片文本内容
   - 处理路径：DocConverterProcessor → LibreOffice Impress 转 PPTX → Docling
   - 错误信息若出现 "libreoffice-impress"，说明 Impress 组件缺失
4. **DOC**（原始支持）：
   - status=ready
   - L1 内容完整提取
   - 处理路径：DocConverterProcessor → LibreOffice 转 DOCX → Docling

### 未达标时的优化方向
| 问题 | 优化方向 |
|------|---------|
| RTF 乱码 | 检查 RTF 文件是否使用正确 Unicode 转义（非 raw UTF-8 in ANSI RTF）；检查 LibreOffice 转换编码 |
| ODT 不处理 | 检查 DocConverterProcessor.CONVERT_TARGET 含 odt: "docx" |
| PPT 转换失败 | 检查 libreoffice-impress 包是否安装；检查 CONVERT_TARGET.ppt = "pptx" |
| 转换超时 | 检查 LibreOffice headless 启动参数和 timeout 设置 |

---

## T36c: 文本编码自动检测链（C-234）

### 测试设计
**知识库**：新建空KB
**操作**：上传同一份中文文本的不同编码版本，验证 TextProcessor 编码检测链：
1. `utf8_bom.txt`：UTF-8 with BOM（EF BB BF 前缀）
2. `utf8_no_bom.txt`：UTF-8 无 BOM
3. `gbk.txt`：GBK 编码的简体中文
4. `big5.txt`：Big5 编码的繁体中文
5. `latin1.txt`：Latin-1/ISO-8859-1 编码的西欧文本
6. `ascii.txt`：纯 ASCII 内容

### 观察目标
1. **UTF-8 BOM**：BOM 被正确识别并去除，L1 内容无 `\ufeff` 前缀
2. **UTF-8 无 BOM**：UTF-8 验证通过，内容正确
3. **GBK**：ASCII 验证失败 → UTF-8 验证失败 → GBK 验证成功，输出正确简体中文
4. **Big5**：GBK 验证失败 → Big5 验证成功，输出正确繁体中文
5. **Latin-1**：所有编码验证失败 → Latin-1 兜底，输出有内容（可能有 lossy 标记但不崩溃）
6. **ASCII**：ASCII 验证直接通过
7. **无 mojibake**：所有编码文件的处理结果不含乱码字符（如 "æœºå™¨" 之类）

### 未达标时的优化方向
| 问题 | 优化方向 |
|------|---------|
| GBK 乱码 | 检查 TextProcessor.detectEncoding 的检测链顺序：BOM → ASCII → UTF-8 → GBK → Big5 → Latin-1 |
| Big5 不识别 | 检查 iconv-lite 是否支持 Big5 解码和验证 |
| BOM 未去除 | 检查 detectEncoding 是否识别 BOM 标记并 strip |
| 编码检测崩溃 | 检查 detectEncoding 的 fallback 路径，确认 Latin-1 作为最终兜底 |

---

## T36d: 表格格式扩展（XLSM 支持）

### 测试设计
**知识库**：新建空KB
**操作**：上传以下表格文件：
1. `data.xlsx`：标准 XLSX 文件
2. `macro.xlsm`：含宏的 XLSM 文件（验证 C-236 扩展支持）
3. `legacy.xls`：旧版 XLS 文件
4. `data.csv`：CSV 文件（含中文）

### 观察目标
1. **XLSX**：NativeTableProcessor 处理，L0/L1 含表格元数据（行数+列数+样本行）
2. **XLSM**（C-236）：
   - status=ready（非 "不支持的格式" 错误）
   - 处理路径：NativeTableProcessor（spreadsheet 策略）
   - L1 含表格元数据
3. **XLS**：NativeTableProcessor 处理，L1 含表格元数据
4. **CSV**：NativeTableProcessor 处理，L1 含列名和样本数据

### 未达标时的优化方向
| 问题 | 优化方向 |
|------|---------|
| XLSM 不支持 | 检查 NativeTableProcessor.HANDLED_TYPES 是否含 "xlsm" |
| XLSM 路由错误 | 检查 detectFileType("xlsm") 返回 "xlsm"，pipeline-strategies 映射到 "spreadsheet" |
| 表格无元数据 | 检查 NativeTableProcessor 的元数据生成逻辑（行数/列数/样本行/文件路径） |
