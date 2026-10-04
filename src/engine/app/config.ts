import { z } from "zod";

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

const configSchema = z.object({
  port: z.coerce.number().int().min(1).max(65535).default(7800),
  hostname: z
    .string()
    .default("127.0.0.1")
    .transform((value) => value.trim())
    .refine((value) => LOOPBACK_HOSTNAMES.has(value.toLowerCase()), {
      message:
        "the engine binds loopback only — AGENT_HOSTNAME must be 127.0.0.1, localhost or ::1; a non-loopback bind would expose an unauthenticated control plane",
    }),
  dbPath: z.string().default("./data/agent.db"),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  workspaceRoot: z.string().default(process.cwd()),
  numCtx: z.coerce.number().int().min(2048).max(131072).default(16384),
  temperature: z.coerce.number().min(0).max(2).default(0.2),
  checkCommand: z
    .string()
    .transform((value) => value || undefined)
    .optional(),
  models: z
    .object({
      coder: z.string().default(""),
      general: z.string().default(""),
      vision: z.string().default(""),
      mimon1: z.string().default(""),
      mimon2: z.string().default(""),
      mimon3: z.string().default(""),
      mimonMax: z.string().default(""),
    })
    .default({
      coder: "",
      general: "",
      vision: "",
      mimon1: "",
      mimon2: "",
      mimon3: "",
      mimonMax: "",
    }),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): Config {
  return configSchema.parse({
    port: env.AGENT_PORT,
    hostname: env.AGENT_HOSTNAME,
    dbPath: env.AGENT_DB_PATH,
    logLevel: env.AGENT_LOG_LEVEL,
    workspaceRoot: env.AGENT_WORKSPACE_ROOT,
    numCtx: env.AGENT_NUM_CTX,
    temperature: env.AGENT_TEMPERATURE,
    checkCommand: env.AGENT_CHECK_COMMAND,
    models: {
      coder: env.AGENT_MODEL_CODER,
      general: env.AGENT_MODEL_GENERAL,
      vision: env.AGENT_MODEL_VISION,
      mimon1: env.AGENT_MODEL_TIER1,
      mimon2: env.AGENT_MODEL_TIER2,
      mimon3: env.AGENT_MODEL_TIER3,
      mimonMax: env.AGENT_MODEL_MAX,
    },
  });
}
