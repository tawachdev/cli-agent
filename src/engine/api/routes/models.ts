import { Hono } from "hono";
import { z } from "zod";
import type { AuditWriter } from "../../core/audit/audit";
import { RUNNABLE_ROLES, type BindingsStore, type RunnableRole } from "../../models/bindings";
import type { ProviderRegistry } from "../../models/registry";

const bindingBody = z.object({ binding: z.string().min(1).max(200) });

export function createModelsRoute(
  bindings: BindingsStore,
  registry: ProviderRegistry,
  audit: AuditWriter,
): Hono {
  const route = new Hono();
  route.get("/", (c) => {
    const all = bindings.all();
    const display = (binding: string): string => (registry.splitBinding(binding).def ? binding : "not connected (/setup)");
    const roles = RUNNABLE_ROLES.map((role) => ({
      role,
      model: display(all[role]),
      source: bindings.source(role),
    }));
    return c.json({ ok: true, roles, active: display(all.mimon2) });
  });
  route.put("/:role", async (c) => {
    const role = c.req.param("role") as RunnableRole;
    if (!RUNNABLE_ROLES.includes(role)) return c.json({ ok: false, error: "unknown role" }, 404);
    const body = bindingBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ ok: false, error: "binding required" }, 400);
    const parts = registry.splitBinding(body.data.binding);
    if (!parts.def && body.data.binding.includes("/")) {
      return c.json({ ok: false, error: "unknown provider in binding" }, 400);
    }
    if (parts.def && !registry.hasKey(parts.def.name)) {
      return c.json(
        { ok: false, error: `no API key for "${parts.def.name}" — open /providers, set its key, then bind` },
        400,
      );
    }
    await bindings.set(role, body.data.binding);
    audit.write("model.binding_set", { role, binding: body.data.binding });
    return c.json({ ok: true });
  });
  return route;
}
