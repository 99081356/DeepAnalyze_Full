import type { PGMigration } from '../pg';

export const migration: PGMigration = {
  version: 20,
  name: 'skill_source_tracking',

  sql: `
    -- Add source tracking columns to agent_skills
    ALTER TABLE agent_skills ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';
    ALTER TABLE agent_skills ADD COLUMN IF NOT EXISTS plugin_id TEXT DEFAULT NULL;
    ALTER TABLE agent_skills ADD COLUMN IF NOT EXISTS hub_slug TEXT DEFAULT NULL;
    ALTER TABLE agent_skills ADD COLUMN IF NOT EXISTS hub_url TEXT DEFAULT NULL;

    -- Replace UNIQUE(name) with UNIQUE(name, source) to allow same name from different sources
    ALTER TABLE agent_skills DROP CONSTRAINT IF EXISTS agent_skills_name_key;
    ALTER TABLE agent_skills ADD CONSTRAINT agent_skills_name_source_unique UNIQUE (name, source);

    -- Indexes for efficient filtering
    CREATE INDEX IF NOT EXISTS idx_agent_skills_source ON agent_skills(source);
    CREATE INDEX IF NOT EXISTS idx_agent_skills_plugin_id ON agent_skills(plugin_id) WHERE plugin_id IS NOT NULL;

    -- Migrate existing built-in skills to source='builtin'
    UPDATE agent_skills SET source = 'builtin' WHERE name IN (
      'deep-research', 'chunked-analysis', 'precise-qa',
      '全面知识库分析', '深度检索', '报告生成', '长篇写作',
      '文档摘要', '对比分析', '表格专项分析', '实体提取',
      '知识库预处理', 'sql-query', 'skill-find', 'coding-assistant'
    );
  `,
};
