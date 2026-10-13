import { useEffect, useRef } from "react";
import { useFetcher, useRevalidator } from "react-router";
import type { JobView } from "../lib/jobs.server";

/**
 * Shows a background job's progress and polls it until it finishes, then
 * reloads the page's data so results appear without a refresh.
 */
export function JobProgress({ job, label, onDone }: { job: JobView | null; label: string; onDone?: (job: JobView) => void }) {
  const fetcher = useFetcher<{ job: JobView | null }>();
  const revalidator = useRevalidator();
  const current = fetcher.data?.job ?? job;
  const running = current && (current.status === "QUEUED" || current.status === "RUNNING");
  const finished = useRef<string | null>(null);

  useEffect(() => {
    if (!running || !current) return;
    const timer = setInterval(() => {
      if (fetcher.state === "idle") fetcher.load(`/app/jobs/${current.id}`);
    }, 2000);
    return () => clearInterval(timer);
  }, [running, current, fetcher]);

  useEffect(() => {
    if (!current || running || finished.current === current.id) return;
    // Only react to a job that finished while this page watched it.
    if (fetcher.data?.job) {
      finished.current = current.id;
      onDone?.(current);
      revalidator.revalidate();
    }
  }, [current, running, fetcher.data, onDone, revalidator]);

  if (!current) return null;
  if (current.status === "FAILED") {
    return <s-banner tone="critical" heading={`${label} failed`}>{current.error ?? "Something went wrong."}</s-banner>;
  }
  if (!running) return null;

  const pct = current.total ? Math.min(100, Math.round((current.progress / current.total) * 100)) : 0;
  return (
    <s-banner tone="info" heading={current.status === "QUEUED" ? `${label} is queued…` : `${label} in progress…`}>
      <s-stack gap="small-200">
        <Bar pct={pct} />
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-text color="subdued">
            {current.total ? `${current.progress} of ${current.total}` : "Starting…"}
          </s-text>
          <fetcher.Form method="post" action={`/app/jobs/${current.id}`}>
            <s-button variant="tertiary" type="submit">
              Cancel
            </s-button>
          </fetcher.Form>
        </s-stack>
      </s-stack>
    </s-banner>
  );
}

export function Bar({ pct, tone }: { pct: number; tone?: "critical" | "warning" | "success" }) {
  const color = tone === "critical" ? "#c70a24" : tone === "warning" ? "#b98900" : tone === "success" ? "#047b5d" : "#303030";
  return (
    <div style={{ height: 8, borderRadius: 4, background: "#e3e3e3", overflow: "hidden" }}>
      <div style={{ width: `${pct}%`, height: "100%", background: color, transition: "width .4s" }} />
    </div>
  );
}

export function ScoreRing({ score, size = 96 }: { score: number | null; size?: number }) {
  const value = score ?? 0;
  const color = score === null ? "#8a8a8a" : value >= 80 ? "#047b5d" : value >= 50 ? "#b98900" : "#c70a24";
  const r = size / 2 - 8;
  const c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`SEO score ${score ?? "not measured"}`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#e3e3e3" strokeWidth="8" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth="8"
        strokeDasharray={`${(value / 100) * c} ${c}`}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle" fontSize={size / 3.6} fontWeight="650" fill={color}>
        {score ?? "–"}
      </text>
    </svg>
  );
}
