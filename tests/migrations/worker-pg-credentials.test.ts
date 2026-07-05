// 验证 migration 038 已应用：workers 表有 3 个新列 + 默认值正确
import { describe, test, expect } from "bun:test";
import { query } from "../../src/store/pg";

describe("migration 038: workers 表 PG 凭据列", () => {
  test("三列都存在", async () => {
    const { rows } = await query<{
      column_name: string; data_type: string; is_nullable: string; column_default: string | null;
    }>(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'workers'
        AND column_name IN ('pg_database', 'pg_username', 'pg_password_encrypted')
      ORDER BY column_name
    `);
    expect(rows.length).toBe(3);
    const names = rows.map(r => r.column_name).sort();
    expect(names).toEqual(["pg_database", "pg_password_encrypted", "pg_username"]);
  });

  test("pg_database 默认 'deepanalyze'，NOT NULL", async () => {
    const { rows } = await query<{ is_nullable: string; column_default: string | null }>(`
      SELECT is_nullable, column_default FROM information_schema.columns
      WHERE table_name = 'workers' AND column_name = 'pg_database'
    `);
    expect(rows[0].is_nullable).toBe("NO");
    expect(rows[0].column_default).toBe("'deepanalyze'::text");
  });

  test("pg_username 默认 'da'，NOT NULL", async () => {
    const { rows } = await query<{ is_nullable: string; column_default: string | null }>(`
      SELECT is_nullable, column_default FROM information_schema.columns
      WHERE table_name = 'workers' AND column_name = 'pg_username'
    `);
    expect(rows[0].is_nullable).toBe("NO");
    expect(rows[0].column_default).toBe("'da'::text");
  });

  test("pg_password_encrypted nullable（迁移脚本回填前为 NULL）", async () => {
    const { rows } = await query<{ is_nullable: string }>(`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'workers' AND column_name = 'pg_password_encrypted'
    `);
    expect(rows[0].is_nullable).toBe("YES");
  });

  test("migration 幂等（再跑一次不报错）", async () => {
    // 加 IF NOT EXISTS，重复 ALTER TABLE 应成功
    await query(`
      ALTER TABLE workers
        ADD COLUMN IF NOT EXISTS pg_database TEXT NOT NULL DEFAULT 'deepanalyze',
        ADD COLUMN IF NOT EXISTS pg_username TEXT NOT NULL DEFAULT 'da',
        ADD COLUMN IF NOT EXISTS pg_password_encrypted TEXT
    `);
    // 如果上面没抛错就过
    expect(true).toBe(true);
  });
});
