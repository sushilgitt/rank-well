import type { ActionFunctionArgs } from "react-router";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { hasFeature } from "../lib/plans";
import { bestMatch, createRedirect, matchCandidates, recordNotFound } from "../lib/redirects.server";
import { readSettings } from "../lib/settings";

/**
 * POST /apps/ranklift/404 (app proxy) — the storefront embed reports a page
 * that rendered the 404 template. With auto-redirect on, the closest live page
 * becomes a permanent Shopify redirect, and the answer tells the embed where
 * to send this visitor right now.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.public.appProxy(request);
  const shop = session ? await prisma.shop.findUnique({ where: { domain: session.shop } }) : null;
  if (!shop) return Response.json({ ok: false });

  const body = (await request.json().catch(() => ({}))) as { path?: string; referrer?: string };
  if (typeof body.path !== "string") return Response.json({ ok: false }, { status: 400 });
  const row = await recordNotFound(shop.id, body.path, typeof body.referrer === "string" ? body.referrer : null);
  if (!row) return Response.json({ ok: true });

  const settings = readSettings(shop.settings);
  if (row.redirectTo) return Response.json({ ok: true, redirect: row.redirectTo });
  if (!admin || !settings.autoRedirect404 || !hasFeature(shop.plan, "autoRedirect")) return Response.json({ ok: true });

  try {
    const target = bestMatch(row.path, await matchCandidates(shop.domain, admin)) ?? settings.fallbackRedirect;
    if (!target || target === row.path) return Response.json({ ok: true });
    await createRedirect(admin, row.path, target);
    await prisma.notFound.update({ where: { id: row.id }, data: { redirectTo: target } });
    return Response.json({ ok: true, redirect: target });
  } catch (error) {
    // Usually "path already taken" — a redirect exists; nothing to do.
    console.error("Auto redirect failed", shop.domain, row.path, error);
    return Response.json({ ok: true });
  }
};

export const loader = () => new Response("Method not allowed", { status: 405 });
