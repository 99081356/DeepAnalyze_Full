# 阶段 0：数据库基础设施 + 模型管理

> **给执行代理的说明：** 必须使用 superpowers:subagent-driven-development 或 superpowers:executing-plans 来逐步实施本计划。

**目标：** 将 SQLite 替换为 PostgreSQL + pgvector + zhparser 作为统一数据基础设施，构建 Repository 抽象层隔离业务代码与数据库实现，部署本地嵌入模型（bge-m3），建立模型自动下载机制。

**架构方案：** PostgreSQL 提供 pgvector HNSW 向量索引（百万级向量毫秒检索）、zhparser 中文分词全文检索、JSONB 结构化查询、MVCC 并发。通过 Repository 接口层隔离业务代码，支持渐进式迁移。本地模型统一存放于 `data/models/`，优先从 ModelScope 下载。

**技术栈：** PostgreSQL 17 + pgvector + zhparser、pg 驱动（node-postgres）、Docker Compose、Ollama

**前置条件：** 无（本阶段是所有其他阶段的基础）

**设计规格：** `docs/superpowers/specs/2026-04-15-three-layer-architecture-redesign.md` 第 4 章

---

## 文件清单

| 操作 | 文件路径 | 职责说明 |
|------|---------|---------|
| 修改 | `docker-compose.yml` | 新增 PostgreSQL + zhparser 服务 |
| 新建 | `config/pg-zhparser.Dockerfile` | 自定义 PG 镜像（含 pgvector + zhparser） |
| 修改 | `config/default.yaml` | 新增 embedding 模型配置 + dimension |
| 新建 | `src/store/pg.ts` | PostgreSQL 连接池 + 迁移框架 |
| 新建 | `src/store/repos/interfaces.ts` | Repository 接口定义 |
| 新建 | `src/store/repos/vector-search.ts` | 向量检索 Repo（pgvector HNSW） |
| 新建 | `src/store/repos/fts-search.ts` | 全文检索 Repo（zhparser 中文分词） |
| 新建 | `src/store/repos/anchor.ts` | 锚点 Repo |
| 新建 | `src/store/repos/wiki-page.ts` | Wiki 页面 Repo |
| 新建 | `src/store/repos/document.ts` | 文档 Repo |
| 新建 | `src/store/repos/embedding.ts` | 嵌入存储 Repo |
| 新建 | `src/services/model-manager.ts` | 本地模型管理（自动下载 + 路径解析） |
| 修改 | `src/models/embedding.ts` | 优先读 DB settings、dimension 配置、本地模型支持 |
| 新建 | `src/store/pg-migrations/001_init.ts` | PG 初始化 Schema |
| 新建 | `tests/repos/vector-search.test.ts` | 向量检索测试 |
| 新建 | `tests/model-manager.test.ts` | 模型管理器测试 |

---

## 任务 1：Docker Compose + PostgreSQL 服务

**涉及文件：** `docker-compose.yml`、`config/pg-zhparser.Dockerfile`（新建）

- [ ] **步骤 1：创建自定义 PG Dockerfile**

新建 `config/pg-zhparser.Dockerfile`：
```
FROM pgvector/pgvector:pg17
# 安装 zhparser 中文分词
RUN apt-get update && apt-get install -y postgresql-17-zhparser || \
    (apt-get install -y build-essential postgresql-server-dev-17 wget && \
     cd /tmp && wget https://github.com/amutu/zhparser/archive/master.tar.gz && \
     tar xzf master.tar.gz && cd zhparser-master && \
     SCRAM_BUILD_DIR=/tmp make && SCRAM_BUILD_DIR=/tmp make install && \
     rm -rf /tmp/zhparser-master /tmp/master.tar.gz) && \
    apt-get clean
```

- [ ] **步骤 2：更新 docker-compose.yml**

在现有 services 中新增 `postgres` 服务：
- 使用自定义 Dockerfile 构建（含 pgvector + zhparser）
- 端口 5432
- 环境变量：POSTGRES_DB、POSTGRES_USER、POSTGRES_PASSWORD
- 命名卷 `pgdata` 持久化数据
- healthcheck 使用 `pg_isready`
- backend 服务增加 depends_on postgres
- backend 增加环境变量 PG_HOST、PG_PORT、PG_DATABASE、PG_USER、PG_PASSWORD
- 新增 models 卷挂载：`./data/models:/app/data/models`

- [ ] **步骤 3：验证 Docker 构建**
```bash
cd /mnt/d/code/deepanalyze/deepanalyze && docker compose build postgres
```

- [ ] **步骤 4：提交**
```bash
git add docker-compose.yml config/pg-zhparser.Dockerfile
git commit -m "feat: Docker Compose 新增 PostgreSQL + pgvector + zhparser 服务"
```

---

## 任务 2：PostgreSQL 连接模块 + 迁移框架

**涉及文件：** `src/store/pg.ts`（新建）

- [ ] **步骤 1：安装 pg 依赖**
```bash
cd /mnt/d/code/deepanalyze/deepanalyze && npm install pg && npm install -D @types/pg
```

- [ ] **步骤 2：实现 PG 连接池模块**

新建 `src/store/pg.ts`：
- 导出 `getPool()` 单例函数，返回 `pg.Pool` 实例
- 从环境变量读取连接配置（PG_HOST/PORT/DATABASE/USER/PASSWORD）
- 默认值：localhost:5432/deepanalyze
- 连接池配置：max=20, idleTimeoutMillis=30000
- 导出 `query(sql, params)` 和 `transaction(fn)` 辅助函数
- 启动时执行 `CREATE EXTENSION IF NOT EXISTS vector` 和 `CREATE EXTENSION IF NOT EXISTS zhparser`
- 导出 `migratePG()` 函数：读取 `src/store/pg-migrations/` 目录按序号执行迁移

- [ ] **步骤 3：提交**
```bash
git add src/store/pg.ts package.json package-lock.json
git commit -m "feat: 新增 PostgreSQL 连接池和迁移框架"
```

---

## 任务 3：PG 初始化 Schema 迁移

**涉及文件：** `src/store/pg-migrations/001_init.ts`（新建）

- [ ] **步骤 1：创建 PG 迁移目录**
```bash
mkdir -p /mnt/d/code/deepanalyze/deepanalyze/src/store/pg-migrations
```

- [ ] **步骤 2：编写初始化迁移**

将 SQLite 现有所有表转写为 PostgreSQL 语法，关键差异：
- `TEXT` → `TEXT`（不变）
- `INTEGER` → `INTEGER`（不变）
- `BLOB` (embeddings.vector) → `vector(1024)` (pgvector 类型)
- `datetime('now')` → `NOW()`
- `ON DELETE CASCADE` 保持不变
- 新增 `fts_vector tsvector` 列到 wiki_pages 表
- 新增 zhparser 全文搜索配置：`CREATE TEXT SEARCH CONFIGURATION chinese (PARSER = zhparser)`
- 创建 HNSW 索引：`CREATE INDEX idx_embeddings_vector ON embeddings USING hnsw (vector vector_cosine_ops)`
- 创建 GIN 索引：`CREATE INDEX idx_wiki_pages_fts ON wiki_pages USING gin(fts_vector)`
- 创建 tsvector 更新触发器
- 新增 `anchors` 表（设计文档第 3.1 节定义的完整 schema）

- [ ] **步骤 3：提交**
```bash
git add src/store/pg-migrations/001_init.ts
git commit -m "feat: PostgreSQL 初始化 Schema 迁移（含 pgvector + zhparser）"
```

---

## 任务 4：Repository 接口定义

**涉及文件：** `src/store/repos/interfaces.ts`（新建）

- [ ] **步骤 1：创建 repos 目录**
```bash
mkdir -p /mnt/d/code/deepanalyze/deepanalyze/src/store/repos
```

- [ ] **步骤 2：定义所有 Repository 接口**

```typescript
// VectorSearchRepo — pgvector HNSW 向量检索
interface VectorSearchRepo {
  upsertEmbedding(id: string, pageId: string, vector: Float32Array,
    textChunk: string, modelName: string, dimension: number): Promise<void>;
  searchByVector(queryVector: Float32Array, kbIds: string[],
    options: { topK: number; minScore?: number; pageTypes?: string[] }
  ): Promise<VectorSearchResult[]>;
  deleteByPageId(pageId: string): Promise<void>;
  deleteByDocId(docId: string): Promise<void>;
}

// FTSSearchRepo — zhparser 中文全文检索
interface FTSSearchRepo {
  upsertFTSEntry(pageId: string, title: string, content: string): Promise<void>;
  searchByText(query: string, kbIds: string[],
    options: { topK: number }
  ): Promise<FTSSearchResult[]>;
  deleteByPageId(pageId: string): Promise<void>;
}

// AnchorRepo — 锚点 CRUD
interface AnchorRepo {
  batchInsert(anchors: AnchorDef[]): Promise<void>;
  getByDocId(docId: string): Promise<AnchorDef[]>;
  getById(anchorId: string): Promise<AnchorDef | null>;
  getByStructurePageId(pageId: string): Promise<AnchorDef[]>;
  updateStructurePageId(anchorIds: string[], pageId: string): Promise<void>;
  deleteByDocId(docId: string): Promise<void>;
}

// WikiPageRepo — Wiki 页面 CRUD
interface WikiPageRepo {
  create(page: WikiPageCreate): Promise<WikiPage>;
  getById(id: string): Promise<WikiPage | null>;
  getByDocAndType(docId: string, pageType: string): Promise<WikiPage[]>;
  getByKbAndType(kbId: string, pageType: string): Promise<WikiPage[]>;
  updateMetadata(id: string, metadata: Record<string, unknown>): Promise<void>;
  updateContent(id: string, content: string, contentHash: string): Promise<void>;
  deleteById(id: string): Promise<void>;
  deleteByDocId(docId: string): Promise<void>;
}

// DocumentRepo — 文档 CRUD
interface DocumentRepo { /* 基本同现有 documents 表操作 */ }

// EmbeddingRepo — 嵌入存储
interface EmbeddingRepo {
  getOrNone(pageId: string, modelName: string, chunkIndex: number): Promise<EmbeddingRow | null>;
  upsert(embedding: EmbeddingCreate): Promise<void>;
  deleteByPageId(pageId: string): Promise<void>;
}
```

- [ ] **步骤 3：导出 RepoFactory**

```typescript
// 工厂函数：根据环境选择 PG 或 SQLite 实现
export function createRepos(): RepoSet {
  if (process.env.PG_HOST) {
    return createPgRepos();
  }
  return createSqliteRepos(); // 兼容过渡期
}
```

- [ ] **步骤 4：提交**
```bash
git add src/store/repos/interfaces.ts
git commit -m "feat: 定义 Repository 接口层（向量检索、全文检索、锚点、Wiki页面）"
```

---

## 任务 5：VectorSearchRepo PostgreSQL 实现

**涉及文件：** `src/store/repos/vector-search.ts`（新建）、`tests/repos/vector-search.test.ts`（新建）

- [ ] **步骤 1：编写测试**

测试用例：
- 插入 10 个 1024 维向量 → searchByVector 返回 top-3 且按相似度降序
- searchByVector 支持 kbIds 过滤
- deleteByPageId 后该页面的向量不再被搜索到

- [ ] **步骤 2：实现 PgVectorSearchRepo**

核心 SQL：
```sql
-- 向量搜索（利用 HNSW 索引）
SELECT e.id, e.page_id, e.text_chunk, e.model_name,
       1 - (e.vector <=> $1) as similarity,
       wp.kb_id, wp.doc_id, wp.page_type, wp.title
FROM embeddings e
JOIN wiki_pages wp ON wp.id = e.page_id
WHERE wp.kb_id = ANY($2)
  AND e.model_name = $3
ORDER BY e.vector <=> $1
LIMIT $4;
```

向量序列化：Float32Array → `[0.1,0.2,...]` 字符串传给 pgvector

- [ ] **步骤 3：运行测试**
```bash
cd /mnt/d/code/deepanalyze/deepanalyze && npx vitest run tests/repos/vector-search.test.ts
```

- [ ] **步骤 4：提交**
```bash
git add src/store/repos/vector-search.ts tests/repos/vector-search.test.ts
git commit -m "feat: 向量检索 PostgreSQL 实现（pgvector HNSW 索引）"
```

---

## 任务 6：FTSSearchRepo PostgreSQL 实现

**涉及文件：** `src/store/repos/fts-search.ts`（新建）

- [ ] **步骤 1：实现 PgFTSSearchRepo**

核心 SQL：
```sql
-- 中文全文搜索（利用 zhparser 分词 + GIN 索引）
SELECT wp.id, wp.kb_id, wp.doc_id, wp.page_type, wp.title, wp.file_path,
       ts_rank(wp.fts_vector, query) as rank
FROM wiki_pages wp, to_tsquery('chinese', $1) query
WHERE wp.fts_vector @@ query
  AND wp.kb_id = ANY($2)
ORDER BY rank DESC
LIMIT $3;
```

upsertFTSEntry：更新 `fts_vector` 列（由触发器自动维护，或手动 `setweight(to_tsvector('chinese', title), 'A') || setweight(to_tsvector('chinese', content), 'B')`）

- [ ] **步骤 2：提交**
```bash
git add src/store/repos/fts-search.ts
git commit -m "feat: 全文检索 PostgreSQL 实现（zhparser 中文分词）"
```

---

## 任务 7：基础 CRUD Repository 实现

**涉及文件：** `src/store/repos/anchor.ts`、`wiki-page.ts`、`document.ts`、`embedding.ts`（均为新建）

- [ ] **步骤 1：实现 PgAnchorRepo**

batchInsert：批量 INSERT 到 anchors 表（使用 `UNNEST` 或多条 INSERT）
getByDocId：`SELECT * FROM anchors WHERE doc_id = $1 ORDER BY element_index`
getById：`SELECT * FROM anchors WHERE id = $1`

- [ ] **步骤 2：实现 PgWikiPageRepo**

CRUD 操作映射到 wiki_pages 表。create 时同时更新 fts_vector。

- [ ] **步骤 3：实现 PgDocumentRepo**

CRUD 操作映射到 documents 表。

- [ ] **步骤 4：实现 PgEmbeddingRepo**

upsert：`INSERT INTO embeddings ... ON CONFLICT (page_id, model_name, chunk_index) DO UPDATE SET vector = EXCLUDED.vector`

- [ ] **步骤 5：实现 RepoFactory 和 createPgRepos()**

新建 `src/store/repos/index.ts`：导出 `createRepos()` 工厂函数。

- [ ] **步骤 6：提交**
```bash
git add src/store/repos/
git commit -m "feat: 实现 PG 版本的锚点/Wiki页面/文档/嵌入 Repository"
```

---

## 任务 8：本地模型管理器

**涉及文件：** `src/services/model-manager.ts`（新建）、`tests/model-manager.test.ts`（新建）

- [ ] **步骤 1：编写测试**

测试用例：
- `getModelPath('bge-m3')` 返回 `data/models/bge-m3`（已存在不下载）
- `getModelPath('nonexistent-model')` 触发从 ModelScope 下载（mock 网络请求）
- `listLocalModels()` 返回 `['bge-m3']`

- [ ] **步骤 2：实现 ModelManager**

```typescript
class ModelManager {
  private modelsDir: string; // data/models/

  /** 获取模型路径，不存在则自动下载 */
  async getModelPath(modelName: string): Promise<string> {
    const localPath = join(this.modelsDir, modelName);
    if (existsSync(join(localPath, 'config.json'))) return localPath;
    return this.download(modelName);
  }

  /** 下载模型：ModelScope 优先，HuggingFace 备选 */
  private async download(modelName: string): Promise<string> {
    // 1. 尝试 modelscope download
    // 2. 失败则尝试 huggingface-cli download
    // 3. 下载到 data/models/{modelName}/
  }

  /** 列出本地已有模型 */
  listLocalModels(): string[] {
    // 扫描 data/models/ 下含 config.json 的子目录
  }
}
```

模型下载使用 `snapshot_download`（Python 子进程）或直接 HTTP 下载。首次下载后缓存到本地，后续直接使用。

- [ ] **步骤 3：运行测试**
```bash
cd /mnt/d/code/deepanalyze/deepanalyze && npx vitest run tests/model-manager.test.ts
```

- [ ] **步骤 4：提交**
```bash
git add src/services/model-manager.ts tests/model-manager.test.ts
git commit -m "feat: 本地模型管理器，支持 ModelScope/HuggingFace 自动下载"
```

---

## 任务 9：EmbeddingManager 升级

**涉及文件：** `src/models/embedding.ts`、`config/default.yaml`

- [ ] **步骤 1：更新 default.yaml 新增 embedding 配置**

```yaml
models:
  # ... main 保持不变 ...
  embedding:
    provider: openai-compatible
    endpoint: http://localhost:11434/v1
    model: bge-m3
    dimension: 1024
    maxTokens: 8192

defaults:
  main: main
  embedding: embedding
```

- [ ] **步骤 2：改造 EmbeddingManager**

改造 `resolveProvider()`：
1. 先从数据库 settings 表读取 providers 配置（含 dimension）
2. 数据库无配置时从 YAML 读取
3. 两处都没有 → HashEmbeddingProvider

新增逻辑：
- 从 ModelManager 获取本地模型路径，验证模型是否存在
- 如果 embedding 配置的 endpoint 是 Ollama，验证 Ollama 是否已拉取模型
- dimension 从配置中读取（不再硬编码 768）

- [ ] **步骤 3：更新 ProviderConfig 类型**

在 `src/models/provider.ts` 的 ModelConfigSchema 中新增可选字段：
```typescript
dimension: z.number().positive().optional(),
```

- [ ] **步骤 4：提交**
```bash
git add src/models/embedding.ts src/models/provider.ts config/default.yaml
git commit -m "feat: EmbeddingManager 支持 dimension 配置和 DB settings 优先读取"
```

---

## 任务 10：数据迁移脚本

**涉及文件：** `scripts/migrate-sqlite-to-pg.ts`（新建）

- [ ] **步骤 1：编写迁移脚本**

流程：
1. 读取 SQLite 数据库（better-sqlite3）
2. 连接 PostgreSQL
3. 按 table 顺序迁移：knowledge_bases → documents → wiki_pages → embeddings → wiki_links → tags → document_tags → sessions → messages → agent_tasks → settings → 其他表
4. embeddings 表：BLOB → Float32Array → pgvector vector 类型
5. 验证迁移后数据行数一致
6. 输出迁移报告

- [ ] **步骤 2：提交**
```bash
git add scripts/migrate-sqlite-to-pg.ts
git commit -m "feat: SQLite → PostgreSQL 数据迁移脚本"
```

---

## 任务 11：集成测试

**涉及文件：** `tests/pg-infrastructure.test.ts`（新建）

- [ ] **步骤 1：编写集成测试**

测试：
- PG 连接池正常工作
- pgvector 扩展可用（CREATE TABLE with vector column + INSERT + SELECT with <=>）
- zhparser 扩展可用（to_tsvector('chinese', '微服务架构') 正确分词）
- HNSW 索引生效（EXPLAIN 分析查询使用了索引扫描）
- Repository 工厂函数根据环境正确创建 PG/SQLite 实现

- [ ] **步骤 2：运行测试**
```bash
cd /mnt/d/code/deepanalyze/deepanalyze && npx vitest run tests/pg-infrastructure.test.ts
```

- [ ] **步骤 3：提交**
```bash
git add tests/pg-infrastructure.test.ts
git commit -m "test: PostgreSQL 基础设施集成测试"
```

---

## 执行顺序

```
任务 1 (Docker PG) ─── 任务 2 (连接模块) ─── 任务 3 (Schema)
                                                  ↓
任务 8 (模型管理器) ────────────────────── 任务 4 (Repo 接口)
                                                  ↓
                                         任务 5 (向量Repo) ─┐
                                         任务 6 (FTS Repo) ─┼─ 任务 7 (CRUD Repos)
                                                            │
                                         任务 9 (Embedding升级) ← 任务 8
                                                            │
                                         任务 10 (迁移脚本) ← 任务 7
                                         任务 11 (集成测试) ← 任务 5,6,7
```

任务 1-3 必须先完成（PG 服务和 Schema）。
任务 4 依赖任务 3。
任务 5、6、8 可并行。
任务 7 依赖任务 4。
任务 9 依赖任务 8。
任务 10 依赖任务 7。
任务 11 依赖任务 5、6、7。
