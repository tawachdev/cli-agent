import { z } from "zod";

const configSchema = z.object({
  port: z.coerce.number().int().min(1).max(65535).default(7800),
  hostname: z.string().default("127.0.0.1"),
  dbPath: z.string().default("./data/agent.db"),
  ollamaUrl: z.string().default("http://127.0.0.1:11434"),
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
      coder: z.string().default("qwen2.5-coder:14b"),
      general: z.string().default("qwen3:14b"),
      vision: z.string().default("qwen2.5vl:7b"),
      mimon1: z.string().default("qwen3:14b"),
      mimon2: z.string().default("qwen2.5-coder:14b"),
      mimon3: z.string().default("qwen3:14b"),
      mimonMax: z.string().default("qwen2.5-coder:14b"),
    })
    .default({
      coder: "qwen2.5-coder:14b",
      general: "qwen3:14b",
      vision: "qwen2.5vl:7b",
      mimon1: "qwen3:14b",
      mimon2: "qwen2.5-coder:14b",
      mimon3: "qwen3:14b",
      mimonMax: "qwen2.5-coder:14b",
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
    ollamaUrl: env.AGENT_OLLAMA_URL,
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
