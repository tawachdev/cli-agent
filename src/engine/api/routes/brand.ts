import { Hono } from "hono";
import { z } from "zod";
import type { AuditWriter } from "../../core/audit/audit";
import { BRAND_PALETTE } from "../../../shared/brand";
import { validColors, validName, type BrandStore } from "../../brand";

const brandBody = z.object({
  name: z.string().optional(),
  colors: z.array(z.string()).min(1).max(12).optional(),
  reset: z.boolean().optional(),
});

export function createBrandRoute(store: BrandStore, audit: AuditWriter): Hono {
  const route = new Hono();
  route.get("/", (c) => {
    return c.json({ ok: true, palette: Object.keys(BRAND_PALETTE), ...store.effective() });
  });
  route.put("/", async (c) => {
    const parsed = brandBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ ok: false, error: "name (2-12 letters) and/or colors [name, name] required" }, 400);
    }
    const { name, colors, reset } = parsed.data;
    if (name !== undefined && !validName(name)) {
      return c.json({ ok: false, error: "name must be 2-12 letters" }, 400);
    }
    if (colors !== undefined && !validColors(colors)) {
      return c.json({ ok: false, error: "colors must be palette names or #rrggbb hex — see GET /brand" }, 400);
    }
    if (reset) {
      await store.reset();
    } else {
      await store.write(name, colors);
    }
    audit.write("brand.updated", { name, colors, reset: reset === true });
    return c.json({ ok: true, ...store.effective() });
  });
  return route;
}
