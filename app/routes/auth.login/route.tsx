import { AppProvider } from "@shopify/shopify-app-react-router/react";
import type { LoaderFunctionArgs } from "react-router";

import { login } from "../../shopify.server";

/**
 * `login` redirects `/auth/login?shop=…` into OAuth. Without a shop there is
 * nothing to do: merchants open the app from their Shopify admin, never by
 * typing a shop domain (App Store requirement 2.3.1).
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await login(request);
  return null;
};

export default function Auth() {
  return (
    <AppProvider embedded={false}>
      <s-page>
        <s-section heading="Open Rank Well from Shopify">
          <s-paragraph>
            Rank Well runs inside your Shopify admin. Open it from Apps in your store's admin, or install it from the Shopify
            App Store.
          </s-paragraph>
        </s-section>
      </s-page>
    </AppProvider>
  );
}
