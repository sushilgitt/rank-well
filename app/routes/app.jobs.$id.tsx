import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { adminContext } from "../lib/context.server";
import { cancelJob, jobView } from "../lib/jobs.server";

/** GET: a job's progress (polled by JobProgress). POST: cancel it. */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shop } = await adminContext(request);
  const job = await prisma.job.findFirst({ where: { id: params.id, shopId: shop.id } });
  return { job: jobView(job) };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { shop } = await adminContext(request);
  await cancelJob(shop.id, params.id!);
  const job = await prisma.job.findFirst({ where: { id: params.id, shopId: shop.id } });
  return { job: jobView(job) };
};
