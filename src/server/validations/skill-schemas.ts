// deepanalyze-hub/src/server/validations/skill-schemas.ts
import { z } from "zod";

export const CATEGORY_ENUM = [
  "engineering", "writing", "operations", "business",
  "security", "productivity", "general",
] as const;

export const createPackageSchema = z.object({
  name: z.string().min(1, "name required"),
  description: z.string().min(10, "description min 10 chars"),
  scope: z.enum(["system", "org", "user"]).default("user"),
  org_id: z.string().optional(),
  category: z.enum(CATEGORY_ENUM).default("general"),
  tags: z.array(z.string()).default([]),
  icon: z.string().default("📦"),
});

export const createVersionSchema = z.object({
  version: z.string().min(1, "version required"),
  content: z.string().min(1, "content required"),
  when_to_use: z.string().optional(),
  allowed_tools: z.array(z.string()).optional(),
  data_classification: z.enum(["public", "internal", "confidential", "secret"]).default("public"),
  change_summary: z.string().min(5, "change_summary min 5 chars"),
  autoPublish: z.boolean().default(false),
});

export const createSharingSchema = z.object({
  package_id: z.string().min(1, "package_id required"),
  source_org_id: z.string().optional(),
  target_org_id: z.string().min(1, "target_org_id required"),
  usage_intent: z.string().min(5, "usage_intent min 5 chars"),
  business_justification: z.string().optional(),
  restrictions: z.object({
    max_users: z.number().int().positive().optional(),
    expires_at: z.string().optional(),
    data_classification_max: z.enum(["public", "internal", "confidential", "secret"]).optional(),
  }).optional(),
});

export type CreatePackageInput = z.infer<typeof createPackageSchema>;
export type CreateVersionInput = z.infer<typeof createVersionSchema>;
export type CreateSharingInput = z.infer<typeof createSharingSchema>;
