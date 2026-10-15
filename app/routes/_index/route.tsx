import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>Rank Well: AI SEO &amp; Blog</h1>
        <p className={styles.text}>
          Get found on Google and in AI answers: audits, meta tags, structured data, speed and AI blog posts for your
          Shopify store.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
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
