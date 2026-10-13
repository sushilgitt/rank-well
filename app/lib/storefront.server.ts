/**
 * Fetching the live storefront the way a search engine does. Stores behind a
 * password (dev stores, pre-launch) are crawled with the storefront password
 * the merchant gives in Settings.
 */

const USER_AGENT = "Mozilla/5.0 (compatible; RankLiftBot/1.0; +https://ranklift.app/bot)";
const TIMEOUT_MS = 20_000;

export interface Fetched {
  url: string;
  finalUrl: string;
  status: number;
  html: string;
  ms: number;
}

export class Storefront {
  private cookie = "";

  constructor(
    private readonly base: string,
    private readonly password?: string | null,
  ) {}

  /** Unlocks a password-protected store; true when the store is open after. */
  async unlock(): Promise<boolean> {
    if (!this.password) return false;
    const response = await fetch(new URL("/password", this.base), {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
      body: new URLSearchParams({ form_type: "storefront_password", utf8: "✓", password: this.password }),
    });
    this.cookie = response.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0])
      .join("; ");
    const home = await this.get(this.base);
    return !/\/password\/?$/.test(new URL(home.finalUrl).pathname);
  }

  async get(url: string, method: "GET" | "HEAD" = "GET"): Promise<Fetched> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method,
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml",
          ...(this.cookie && sameHost(url, this.base) ? { Cookie: this.cookie } : {}),
        },
      });
      const html = method === "GET" ? await response.text() : "";
      return { url, finalUrl: response.url || url, status: response.status, html, ms: Date.now() - started };
    } catch {
      // 0 = unreachable (DNS, TLS, timeout).
      return { url, finalUrl: url, status: 0, html: "", ms: Date.now() - started };
    } finally {
      clearTimeout(timer);
    }
  }

  /** HEAD first (cheap); some servers refuse HEAD, so fall back to GET. */
  async status(url: string): Promise<number> {
    const head = await this.get(url, "HEAD");
    if (head.status === 405 || head.status === 403 || head.status === 0) return (await this.get(url)).status;
    return head.status;
  }
}

export function sameHost(a: string, b: string) {
  try {
    return new URL(a).host.replace(/^www\./, "") === new URL(b).host.replace(/^www\./, "");
  } catch {
    return false;
  }
}

/** Runs `worker` over `items` with at most `limit` in flight. */
export async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await worker(items[index], index);
      }
    }),
  );
  return results;
}
