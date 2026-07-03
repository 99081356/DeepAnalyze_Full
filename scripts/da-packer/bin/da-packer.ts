#!/usr/bin/env bun
// =============================================================================
// da-packer - Build offline deployment bundles for DeepAnalyze
// =============================================================================

import { Command } from "commander";
import { buildCommand } from "../src/commands/build.js";
import { listCommand } from "../src/commands/list.js";
import { verifyCommand } from "../src/commands/verify.js";
import { infoCommand } from "../src/commands/info.js";

const program = new Command();

program
  .name("da-packer")
  .description("Build offline deployment bundles for DeepAnalyze")
  .version("0.1.0");

program
  .command("build")
  .description("Build an offline deployment bundle")
  .requiredOption("--da-version <version>", "DA Worker image version")
  .requiredOption("--hub-version <version>", "Hub image version")
  .option("--models <list>", "Comma-separated model names", "bge-m3,whisper-tiny,whisper-base,docling")
  .option("--skills <list>", "Comma-separated skill package ids", "enterprise-essentials")
  .option("-o, --output <path>", "Output tar.gz path", "da-bundle.tar.gz")
  .option("--source <source>", "Model source: hf | hf_mirror | enterprise | cache", "hf_mirror")
  .option("--enterprise-url <url>", "Enterprise model repository URL")
  .option("--platform <list>", "Target platforms", "linux/amd64")
  .option("--split <size>", "Split into volumes (e.g. 2GB)")
  .option("--no-hub", "Exclude Hub image (mini bundle for personal DA)")
  .option("--skip-images", "Skip image packaging (dev/test only)")
  .option("--skip-models", "Skip model download")
  .option("--skip-skills", "Skip skill packaging")
  .action(buildCommand);

program
  .command("list")
  .description("List previously built bundles")
  .option("--dir <path>", "Bundles directory", "./bundles")
  .action(listCommand);

program
  .command("verify")
  .description("Verify bundle integrity")
  .argument("<bundle-path>", "Path to bundle tar.gz")
  .action(verifyCommand);

program
  .command("info")
  .description("Show bundle contents")
  .argument("<bundle-path>", "Path to bundle tar.gz")
  .action(infoCommand);

program.parseAsync(process.argv);
