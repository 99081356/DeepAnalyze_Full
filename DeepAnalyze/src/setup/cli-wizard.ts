// =============================================================================
// src/setup/cli-wizard.ts
// Interactive CLI setup wizard for first-run configuration.
// Invoked from main.ts when stdout is a TTY and setup isn't complete.
// =============================================================================

import * as p from "@clack/prompts";
import { detectEnvironment } from "./environment.js";
import { runWizard, saveConfig, isSetupComplete, type WizardInput } from "./wizard.js";
import { hashPassword } from "../services/auth/local-idp.js";
import { getRepos } from "../store/repos/index.js";

export async function runCliWizard(): Promise<void> {
  p.intro("DeepAnalyze Setup");

  if (isSetupComplete()) {
    p.note("Setup already complete. Delete data/setup-complete.flag to re-run.");
    p.outro("Exiting");
    return;
  }

  // Phase 1: environment detection
  p.log.step("Detecting environment...");
  const environment = await detectEnvironment();
  p.log.info(`CPU: ${environment.cpu.cores} cores | RAM: ${environment.memory.totalGb} GB`);
  p.log.info(`Disk: ${environment.disk.availableGb} GB available`);
  p.log.info(`GPU: ${environment.gpu.available ? environment.gpu.name : "not detected"}`);

  // Phase 2: mode selection
  const mode = await p.select({
    message: "运行模式",
    options: [
      { value: "personal", label: "个人版（standalone）" },
      { value: "enterprise_worker", label: "企业 Worker（接入 Hub）" },
    ],
  });
  if (p.isCancel(mode)) { p.cancel("Cancelled"); process.exit(0); }

  let authChoice: "none" | "local" | undefined;
  let adminUsername: string | undefined;
  let adminPassword: string | undefined;
  let hubUrl: string | undefined;
  let joinToken: string | undefined;

  // Phase 3: auth configuration
  if (mode === "personal") {
    const choice = await p.select({
      message: "认证方式",
      options: [
        { value: "none", label: "免登录（直接进入应用）" },
        { value: "local", label: "启用登录（创建管理员账号）" },
      ],
    });
    if (p.isCancel(choice)) { p.cancel("Cancelled"); process.exit(0); }
    authChoice = choice as "none" | "local";

    if (authChoice === "local") {
      adminUsername = await p.text({ message: "管理员用户名", defaultValue: "admin" }) as string;
      const pwd = await p.password({ message: "管理员密码（≥6 位）" });
      if (typeof pwd !== "string" || pwd.length < 6) {
        p.cancel("Password too short"); process.exit(1);
      }
      adminPassword = pwd;
    }
  } else {
    // enterprise_worker
    hubUrl = await p.text({ message: "Hub URL", placeholder: "https://hub.corp.com:22000" }) as string;
    joinToken = await p.password({ message: "Join Token" }) as string;
  }

  // Phase 4: model strategy
  const modelStrategy = await p.select({
    message: "模型策略",
    options: [
      { value: "all_cloud", label: "全部云端 API" },
      { value: "all_local", label: "全部本地（按硬件推荐）" },
      { value: "hybrid", label: "混合（云端 LLM + 本地 embedding）— 推荐" },
      { value: "manual", label: "手动拷贝（指向 data/models/）" },
    ],
  });
  if (p.isCancel(modelStrategy)) { p.cancel("Cancelled"); process.exit(0); }

  const modelSource = await p.select({
    message: "模型下载源",
    options: [
      { value: "auto", label: "自动（按可用性探测）" },
      { value: "hf", label: "HuggingFace 官方" },
      { value: "hf_mirror", label: "中国镜像（hf-mirror.com）" },
      { value: "enterprise", label: "企业内部仓库" },
      { value: "manual", label: "手动（不下载）" },
    ],
  });
  if (p.isCancel(modelSource)) { p.cancel("Cancelled"); process.exit(0); }

  // Build WizardInput from collected answers
  const input: WizardInput = {
    environment,
    mode: mode as WizardInput["mode"],
    authChoice: authChoice as WizardInput["authChoice"],
    adminUsername,
    adminPassword,
    hubUrl,
    joinToken,
    modelStrategy: modelStrategy as WizardInput["modelStrategy"],
    modelSource: modelSource as WizardInput["modelSource"],
    providerKeys: {},
  };

  // Phase 3 (local mode): create admin account before saving config
  if (authChoice === "local" && adminUsername && adminPassword) {
    const repo = (await getRepos()).settings;
    const hash = await hashPassword(adminPassword);
    await repo.set("auth", JSON.stringify({
      mode: "local",
      username: adminUsername,
      passwordHash: hash,
    }));
  }

  const result = runWizard(input);
  await saveConfig(result);

  p.outro("Setup complete! Restart DeepAnalyze to apply.");
}

// Entry point when run directly via `da-setup` bin or `bun run src/setup/cli-wizard.ts`
if (import.meta.url === `file://${process.argv[1]}`) {
  runCliWizard().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
