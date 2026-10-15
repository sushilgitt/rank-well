import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

import styles from "./styles.module.css";

/**
 * Public landing page. Installs start from the Shopify App Store or admin,
 * never from a shop-domain form here (App Store requirement 2.3.1).
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return null;
};

export default function App() {
  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>Rank Well: AI SEO</h1>
        <p className={styles.text}>
          Get found on Google and in AI answers: audits, meta tags, structured data, image optimization and speed for your
          Shopify store. Install Rank Well from the Shopify App Store, then open it from your Shopify admin.
        </p>
        <ul className={styles.list}>
          <li>
            <strong>Full-site SEO &amp; GEO audit</strong>. Checks every page the way search engines and AI crawlers see it.
          </li>
          <li>
            <strong>Meta tags, alt text &amp; structured data</strong>. Fix them in bulk with templates or AI.
          </li>
          <li>
            <strong>Broken links &amp; 404s</strong>. Found, redirected and monitored automatically.
          </li>
        </ul>
      </div>
    </div>
  );
}
