import type { Job, Shop } from "@prisma/client";
import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import type { AdminGraphql } from "./shop.server";

/**
 * A Postgres-backed job queue. One worker loop runs inside the web process;
 * jobs are claimed with FOR UPDATE SKIP LOCKED, so running two containers is
 * safe too. A job that crashes the process is picked up again once its lock
 * is older than LOCK_TIMEOUT.
 *
 * Handlers report progress with ctx.progress(); the admin polls the Job row.
 */

export interface JobContext {
  job: Job;
  shop: Shop;
  admin: AdminGraphql;
  progress: (done: number, total?: number) => Promise<void>;
  /** True once the merchant cancelled; long handlers check it between items. */
  cancelled: () => Promise<boolean>;
}

export type JobHandler = (ctx: JobContext) => Promise<unknown>;

const handlers = new Map<string, JobHandler>();
const POLL_MS = 1500;
const LOCK_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const CONCURRENCY = Number(process.env.RANKLIFT_WORKERS || 3);

export function registerJob(type: string, handler: JobHandler) {
  handlers.set(type, handler);
}

export async function enqueue(shopId: string, type: string, payload: object = {}, runAfter?: Date) {
  return prisma.job.create({ data: { shopId, type, payload, runAfter: runAfter ?? new Date() } });
}

/** The newest job of a type that is still queued or running, if any. */
export function activeJob(shopId: string, type: string) {
  return prisma.job.findFirst({
    where: { shopId, type, status: { in: ["QUEUED", "RUNNING"] } },
    orderBy: { createdAt: "desc" },
  });
}

/** Queues a job unless one of the same type is already waiting or running. */
export async function enqueueOnce(shopId: string, type: string, payload: object = {}) {
  return (await activeJob(shopId, type)) ?? enqueue(shopId, type, payload);
}

export async function cancelJob(shopId: string, id: string) {
  await prisma.job.updateMany({
    where: { id, shopId, status: { in: ["QUEUED", "RUNNING"] } },
    data: { status: "CANCELLED", finishedAt: new Date() },
  });
}

async function claim(): Promise<Job | null> {
  const stale = new Date(Date.now() - LOCK_TIMEOUT_MS);
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE "Job" SET status = 'RUNNING', "lockedAt" = now(), "startedAt" = COALESCE("startedAt", now()),
           attempts = attempts + 1
    WHERE id = (
      SELECT id FROM "Job"
      WHERE (status = 'QUEUED' AND "runAfter" <= now())
         OR (status = 'RUNNING' AND "lockedAt" < ${stale})
      ORDER BY "runAfter"
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id`;
  if (!rows.length) return null;
  return prisma.job.findUnique({ where: { id: rows[0].id } });
}

async function run(job: Job) {
  const shop = await prisma.shop.findUnique({ where: { id: job.shopId } });
  const handler = handlers.get(job.type);
  if (!shop || shop.uninstalledAt || !handler) {
    await prisma.job.update({
      where: { id: job.id },
      data: { status: "FAILED", error: handler ? "Store unavailable" : `No handler for ${job.type}`, finishedAt: new Date() },
    });
    return;
  }

  try {
    const { admin } = await unauthenticated.admin(shop.domain);
    const ctx: JobContext = {
      job,
      shop,
      admin,
      progress: async (done, total) => {
        await prisma.job.update({
          where: { id: job.id },
          data: { progress: done, ...(total !== undefined ? { total } : {}), lockedAt: new Date() },
        });
      },
      cancelled: async () =>
        (await prisma.job.findUnique({ where: { id: job.id }, select: { status: true } }))?.status === "CANCELLED",
    };
    const result = await handler(ctx);
    // A cancelled job keeps its CANCELLED status.
    await prisma.job.updateMany({
      where: { id: job.id, status: "RUNNING" },
      data: { status: "DONE", result: (result ?? {}) as object, finishedAt: new Date(), lockedAt: null },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Job ${job.type} ${job.id} failed`, error);
    const retry = job.attempts < MAX_ATTEMPTS && !(error instanceof PermanentError);
    await prisma.job.updateMany({
      where: { id: job.id, status: "RUNNING" },
      data: retry
        ? { status: "QUEUED", error: message, lockedAt: null, runAfter: new Date(Date.now() + job.attempts * 60_000) }
        : { status: "FAILED", error: message, finishedAt: new Date(), lockedAt: null },
    });
  }
}

/** A failure retrying won't fix (bad input, limit reached). */
export class PermanentError extends Error {}

declare global {
  // eslint-disable-next-line no-var
  var rankliftWorker: boolean | undefined;
}

/** Starts the worker loop once per process. */
export function startWorker() {
  if (global.rankliftWorker || process.env.RANKLIFT_WORKER === "off") return;
  global.rankliftWorker = true;
  for (let i = 0; i < CONCURRENCY; i++) void loop();
}

async function loop() {
  for (;;) {
    try {
      const job = await claim();
      if (job) {
        await run(job);
        continue;
      }
    } catch (error) {
      console.error("Job worker error", error);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/** Shape the admin polls for a progress bar. */
export function jobView(job: Job | null) {
  if (!job) return null;
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    progress: job.progress,
    total: job.total,
    error: job.error,
    result: job.result,
    createdAt: job.createdAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}
export type JobView = NonNullable<ReturnType<typeof jobView>>;
