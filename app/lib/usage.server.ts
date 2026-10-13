import type { Shop } from "@prisma/client";
import prisma from "../db.server";
import { PLANS, type Meter } from "./plans";

const PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

/** A limit was hit; the message is for the merchant. */
export class LimitError extends Error {}

/** Rolls the 30-day period forward when it has ended. */
async function currentPeriod(shop: Shop): Promise<Date> {
  const ended = Date.now() - shop.periodStart.getTime() >= PERIOD_MS;
  if (!ended) return shop.periodStart;
  const periods = Math.floor((Date.now() - shop.periodStart.getTime()) / PERIOD_MS);
  const start = new Date(shop.periodStart.getTime() + periods * PERIOD_MS);
  await prisma.shop.update({ where: { id: shop.id }, data: { periodStart: start } });
  return start;
}

export async function usageFor(shop: Shop) {
  const since = await currentPeriod(shop);
  const rows = await prisma.usage.groupBy({
    by: ["meter"],
    where: { shopId: shop.id, createdAt: { gte: since } },
    _sum: { amount: true },
  });
  const used: Record<Meter, number> = { ai: 0, images: 0, auditPages: 0 };
  for (const row of rows) used[row.meter as Meter] = row._sum.amount ?? 0;
  const limits = PLANS[shop.plan].limits;
  return {
    since,
    resetsAt: new Date(since.getTime() + PERIOD_MS),
    used,
    limits,
    left: (meter: Meter) => Math.max(0, limits[meter] - used[meter]),
  };
}

/**
 * Takes `amount` from a meter, or throws LimitError when the plan has run out
 * and overage is off. Charge before the work, refund() when the work fails, so
 * two parallel requests can't both spend the last credit unnoticed.
 */
export async function spend(shop: Shop, meter: Meter, amount: number, reason?: string) {
  if (amount <= 0) return;
  const usage = await usageFor(shop);
  if (usage.left(meter) < amount && !shop.overage) {
    throw new LimitError(limitMessage(meter, usage.left(meter), amount));
  }
  await prisma.usage.create({ data: { shopId: shop.id, meter, amount, reason } });
}

export async function refund(shop: Shop, meter: Meter, amount: number, reason?: string) {
  if (amount <= 0) return;
  await prisma.usage.create({ data: { shopId: shop.id, meter, amount: -amount, reason: reason ?? "refund" } });
}

function limitMessage(meter: Meter, left: number, wanted: number) {
  const what = { ai: "AI credits", images: "image compressions", auditPages: "audit pages" }[meter];
  return left > 0
    ? `This needs ${wanted} ${what}, and ${left} are left this period. Upgrade your plan or try fewer items.`
    : `You've used all your ${what} for this period. Upgrade your plan to continue.`;
}
