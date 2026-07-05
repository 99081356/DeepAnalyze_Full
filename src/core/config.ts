// =============================================================================
// DeepAnalyze Hub - Central Configuration
// =============================================================================

export const HUB_CONFIG = {
  /** Application name */
  appName: "DeepAnalyze Hub",

  /** Semantic version */
  version: "0.8.0",

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
    rs256: {
      publicKeyPath: process.env.HUB_JWT_PUBLIC_KEY_PATH || "",
      privateKeyPath: process.env.HUB_JWT_PRIVATE_KEY_PATH || "",
      keyId: process.env.HUB_JWT_KEY_ID || "hub-rs256-v1",
    },
    joinToken: {
      expiry: process.env.HUB_JOIN_TOKEN_EXPIRY || "24h",
      maxCount: parseInt(process.env.HUB_JOIN_TOKEN_MAX || "100", 10),
    },
    ssh: {
      port: parseInt(process.env.HUB_SSH_DEFAULT_PORT || "22", 10),
      timeout: parseInt(process.env.HUB_SSH_TIMEOUT || "60000", 10),
    },
    hs256TransitionUntil: process.env.HUB_HS256_TRANSITION_UNTIL || "",
  },

  /** Marketplace configuration */
  marketplace: {
    maxSkillSize: 102400, // 100KB
    defaultPageSize: 20,
    maxPageSize: 100,
  },

  /** Model repository configuration (Phase 5: internal model storage) */
  modelRepo: {
    storageDir: process.env.HUB_MODEL_REPO_DIR || "./data/model-repo",
    maxFileSize: parseInt(process.env.HUB_MODEL_MAX_SIZE || "5368709120", 10), // 5GB
  },

  /** Bundle repository configuration (Phase 5: da-packer offline bundles) */
  bundle: {
    imagesDir: process.env.HUB_BUNDLE_IMAGES_DIR || "./data/bundle/images",
    bundlesDir: process.env.HUB_BUNDLE_DIR || "./data/bundle",
  },

  /** Docker registry for worker-side images (da-postgres etc.) */
  docker: {
    registry: process.env.HUB_DOCKER_REGISTRY ?? "",
  },

  /** Backup lifecycle (Spec 2.2) */
  backup: {
    retentionDays: parseInt(process.env.HUB_BACKUP_RETENTION_DAYS || "30", 10),
    cleanupIntervalHours: parseInt(
      process.env.HUB_BACKUP_CLEANUP_INTERVAL_HOURS || "24",
      10,
    ),
    storageDir: process.env.HUB_BACKUP_DIR || "./data/backups",
  },
} as const;

export type HubConfig = typeof HUB_CONFIG;
