import { gql, type AdminGraphql } from "./shop.server";

/**
 * Listing the store's online-store resources: products, collections, pages
 * and articles, with their SEO fields. Used by the audit, the meta editor,
 * llms.txt and the sitemap.
 */

export type ResourceType = "product" | "collection" | "page" | "article";

export interface Resource {
  id: string;
  type: ResourceType;
  title: string;
  handle: string;
  /** Storefront URL; null when not published to the online store. */
  url: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  /** Plain text of the body, trimmed — context for AI and thin-content hints. */
  text: string;
  image: string | null;
  updatedAt: string;
  extra?: Record<string, unknown>;
}

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

/** Walks a connection to the end, or until `limit` nodes. */
export async function paginate<N>(
  fetchPage: (after: string | null) => Promise<{ nodes: N[]; pageInfo: PageInfo }>,
  limit = Infinity,
): Promise<N[]> {
  const all: N[] = [];
  let after: string | null = null;
  for (;;) {
    const page = await fetchPage(after);
    all.push(...page.nodes);
    if (all.length >= limit || !page.pageInfo.hasNextPage) break;
    after = page.pageInfo.endCursor;
  }
  return all.slice(0, limit);
}

const stripHtml = (html: string | null | undefined) =>
  (html ?? "")
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 4000);

export async function listProducts(admin: AdminGraphql, limit = Infinity, query?: string): Promise<Resource[]> {
  type Node = {
    id: string;
    title: string;
    handle: string;
    onlineStoreUrl: string | null;
    descriptionHtml: string;
    vendor: string;
    productType: string;
    tags: string[];
    updatedAt: string;
    seo: { title: string | null; description: string | null };
    featuredMedia: { preview: { image: { url: string } | null } | null } | null;
  };
  const nodes = await paginate<Node>(async (after) => {
    const data = await gql<{ products: { nodes: Node[]; pageInfo: PageInfo } }>(
      admin,
      `#graphql
        query rankliftProducts($after: String, $query: String) {
          products(first: 100, after: $after, query: $query, sortKey: UPDATED_AT, reverse: true) {
            nodes {
              id title handle onlineStoreUrl descriptionHtml vendor productType tags updatedAt
              seo { title description }
              featuredMedia { preview { image { url } } }
            }
            pageInfo { hasNextPage endCursor }
          }
        }`,
      { after, query: query ?? null },
    );
    return data.products;
  }, limit);
  return nodes.map((node) => ({
    id: node.id,
    type: "product",
    title: node.title,
    handle: node.handle,
    url: node.onlineStoreUrl,
    seoTitle: node.seo.title,
    seoDescription: node.seo.description,
    text: stripHtml(node.descriptionHtml),
    image: node.featuredMedia?.preview?.image?.url ?? null,
    updatedAt: node.updatedAt,
    extra: { vendor: node.vendor, productType: node.productType, tags: node.tags },
  }));
}

export async function listCollections(admin: AdminGraphql, limit = Infinity): Promise<Resource[]> {
  type Node = {
    id: string;
    title: string;
    handle: string;
    descriptionHtml: string;
    updatedAt: string;
    seo: { title: string | null; description: string | null };
    image: { url: string } | null;
  };
  const nodes = await paginate<Node>(async (after) => {
    const data = await gql<{ collections: { nodes: Node[]; pageInfo: PageInfo } }>(
      admin,
      `#graphql
        query rankliftCollections($after: String) {
          collections(first: 100, after: $after, sortKey: UPDATED_AT, reverse: true) {
            nodes { id title handle descriptionHtml updatedAt seo { title description } image { url } }
            pageInfo { hasNextPage endCursor }
          }
        }`,
      { after },
    );
    return data.collections;
  }, limit);
  return nodes.map((node) => ({
    id: node.id,
    type: "collection",
    title: node.title,
    handle: node.handle,
    // Collections have no onlineStoreUrl; the path is fixed.
    url: `/collections/${node.handle}`,
    seoTitle: node.seo.title,
    seoDescription: node.seo.description,
    text: stripHtml(node.descriptionHtml),
    image: node.image?.url ?? null,
    updatedAt: node.updatedAt,
  }));
}

type MetafieldNode = { value: string } | null;

export async function listPages(admin: AdminGraphql, limit = Infinity): Promise<Resource[]> {
  type Node = {
    id: string;
    title: string;
    handle: string;
    body: string;
    isPublished: boolean;
    updatedAt: string;
    seoTitle: MetafieldNode;
    seoDescription: MetafieldNode;
  };
  const nodes = await paginate<Node>(async (after) => {
    const data = await gql<{ pages: { nodes: Node[]; pageInfo: PageInfo } }>(
      admin,
      `#graphql
        query rankliftPages($after: String) {
          pages(first: 100, after: $after) {
            nodes {
              id title handle body isPublished updatedAt
              seoTitle: metafield(namespace: "global", key: "title_tag") { value }
              seoDescription: metafield(namespace: "global", key: "description_tag") { value }
            }
            pageInfo { hasNextPage endCursor }
          }
        }`,
      { after },
    );
    return data.pages;
  }, limit);
  return nodes.map((node) => ({
    id: node.id,
    type: "page",
    title: node.title,
    handle: node.handle,
    url: node.isPublished ? `/pages/${node.handle}` : null,
    seoTitle: node.seoTitle?.value ?? null,
    seoDescription: node.seoDescription?.value ?? null,
    text: stripHtml(node.body),
    image: null,
    updatedAt: node.updatedAt,
  }));
}

export async function listArticles(admin: AdminGraphql, limit = Infinity): Promise<Resource[]> {
  type Node = {
    id: string;
    title: string;
    handle: string;
    body: string;
    isPublished: boolean;
    updatedAt: string;
    blog: { handle: string; title: string };
    image: { url: string } | null;
    seoTitle: MetafieldNode;
    seoDescription: MetafieldNode;
  };
  const nodes = await paginate<Node>(async (after) => {
    const data = await gql<{ articles: { nodes: Node[]; pageInfo: PageInfo } }>(
      admin,
      `#graphql
        query rankliftArticles($after: String) {
          articles(first: 100, after: $after, sortKey: UPDATED_AT, reverse: true) {
            nodes {
              id title handle body isPublished updatedAt
              blog { handle title }
              image { url }
              seoTitle: metafield(namespace: "global", key: "title_tag") { value }
              seoDescription: metafield(namespace: "global", key: "description_tag") { value }
            }
            pageInfo { hasNextPage endCursor }
          }
        }`,
      { after },
    );
    return data.articles;
  }, limit);
  return nodes.map((node) => ({
    id: node.id,
    type: "article",
    title: node.title,
    handle: node.handle,
    url: node.isPublished ? `/blogs/${node.blog.handle}/${node.handle}` : null,
    seoTitle: node.seoTitle?.value ?? null,
    seoDescription: node.seoDescription?.value ?? null,
    text: stripHtml(node.body),
    image: node.image?.url ?? null,
    updatedAt: node.updatedAt,
    extra: { blog: node.blog.title },
  }));
}

export async function listResources(admin: AdminGraphql, type: ResourceType, limit = Infinity) {
  switch (type) {
    case "product":
      return listProducts(admin, limit);
    case "collection":
      return listCollections(admin, limit);
    case "page":
      return listPages(admin, limit);
    case "article":
      return listArticles(admin, limit);
  }
}

/** Makes a resource URL absolute against the storefront. */
export function absolute(url: string, base: string) {
  return new URL(url, base.endsWith("/") ? base : `${base}/`).toString();
}
