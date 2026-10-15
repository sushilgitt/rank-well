/**
 * Registers every job handler, then starts the worker. Imported once from
 * entry.server.tsx; each module below calls registerJob() when loaded.
 */
import "./audit/audit.server";
import "./meta.server";
import "./alt.server";
import "./auto.server";
import "./images.server";
import "./speed.server";
import { startWorker } from "./jobs.server";

startWorker();
