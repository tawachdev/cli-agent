import { Hono } from "hono";
import { z } from "zod";
import type { AuditWriter } from "../../core/audit/audit";
import { extraProviderSchema, type ProviderRegistry } from "../../models/registry";

const keyBody = z.object({ key: z.string().min(1).max(4096) });
const testBody = z.object({ model: z.string().min(1).optional() });

export function createProvidersRoute(registry: ProviderRegistry, audit: AuditWriter): Hono {
  const route = new Hono();
  route.get("/", (c) => {
    return c.json({ ok: true, providers: registry.list() });
  });
  route.post("/", async (c) => {
    const body = await extraProviderSchema.safeParseAsync(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ ok: false, error: "name, kind and a https baseUrl are required" }, 400);
    }
    try {
      await registry.addProvider(body.data);
    } catch (error) {
      return c.json({ ok: false, error: (error as Error).message }, 400);
    }
    audit.write("provider.added", { provider: body.data.name, baseUrl: body.data.baseUrl });
    return c.json({ ok: true });
  });
  route.delete("/:name", async (c) => {
    const name = c.req.param("name");
    if (!registry.has(name)) return c.json({ ok: false, error: "unknown provider" }, 404);
    try {
      await registry.removeProvider(name);
    } catch (error) {
      return c.json({ ok: false, error: (error as Error).message }, 400);
    }
    audit.write("provider.removed", { provider: name });
    return c.json({ ok: true });
  });
  route.put("/:name/key", async (c) => {
    const name = c.req.param("name");
    if (!registry.has(name)) return c.json({ ok: false, error: "unknown provider" }, 404);
    const body = keyBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ ok: false, error: "key required" }, 400);
    try {
      registry.setKey(name, body.data.key);
    } catch (error) {
      return c.json({ ok: false, error: (error as Error).message }, 400);
    }
    audit.write("provider.key_set", { provider: name });
    return c.json({ ok: true });
  });
  route.delete("/:name/key", (c) => {
    const name = c.req.param("name");
    if (!registry.has(name)) return c.json({ ok: false, error: "unknown provider" }, 404);
    try {
      registry.deleteKey(name);
    } catch (error) {
      return c.json({ ok: false, error: (error as Error).message }, 400);
    }
    audit.write("provider.key_deleted", { provider: name });
    return c.json({ ok: true });
  });
  route.post("/:name/test", async (c) => {
    const name = c.req.param("name");
    if (!registry.has(name)) return c.json({ ok: false, error: "unknown provider" }, 404);
    const body = testBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ ok: false, error: "invalid body" }, 400);
    const def = registry.list().find((provider) => provider.name === name);
    const model = body.data.model ?? def?.models[0];
    if (!model) return c.json({ ok: false, error: "no model to test" }, 400);
    const result = await registry.test(name, model);
    audit.write("provider.test", { provider: name, model, ok: result.ok });
    return c.json({ ok: result.ok, error: result.error });
  });
  return route;
}
