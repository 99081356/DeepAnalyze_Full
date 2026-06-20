// =============================================================================
// DeepAnalyze Hub - Central Configuration
// =============================================================================

export const HUB_CONFIG = {
  /** Application name */
  appName: "DeepAnalyze Hub",

  /** Semantic version */
  version: "0.1.0",

  /** HTTP server port */
  port: parseInt(process.env.PORT || "22000", 10),

  /** Node environment */
  env: process.env.NODE_ENV || "development",

  /** PostgreSQL connection */
  database: {
    host: process.env.PG_HOST || "localhost",
    port: parseInt(process.env.PG_PORT || "5433", 10),
    database: process.env.PG_DATABASE || "deepanalyze_hub",
    user: process.env.PG_USER || "deepanalyze_hub",
    password: process.env.PG_PASSWORD || "deepanalyze_hub_dev",
    poolSize: parseInt(process.env.PG_POOL_SIZE || "10", 10),
  },

  /** JWT configuration */
  auth: {
    jwtSecret: process.env.JWT_SECRET || "change-me-in-production",
    jwtRefreshSecret: process.env.JWT_REFRESH_SECRET || "change-me-refresh-in-production",
    jwtExpiry: process.env.JWT_EXPIRY || "7d",
    workerTokenExpiry: process.env.WORKER_TOKEN_EXPIRY || "30d",
  },

  /** Marketplace configuration */
  marketplace: {
    maxSkillSize: 102400, // 100KB
    defaultPageSize: 20,
    maxPageSize: 100,
  },
} as const;

export type HubConfig = typeof HUB_CONFIG;
