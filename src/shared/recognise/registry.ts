// The one table. Everything else keyed by `Product` derives from it.
import type { Product } from "../types.ts";
import { bitbucketRule } from "./bitbucket.ts";
import { githubRule } from "./github.ts";
import { gitlabRule } from "./gitlab.ts";
import { jenkinsRule } from "./jenkins.ts";
import { jiraRule } from "./jira.ts";
import type { ProductRule } from "./rule.ts";

/**
 * A `Record<Product, ProductRule>` rather than an array, so a product declared
 * in `PRODUCT_IDS` without a rule here is a TYPE ERROR rather than a product
 * that silently recognises nothing.
 */
export const RULE_BY_PRODUCT: Record<Product, ProductRule> = {
  bitbucket: bitbucketRule,
  github: githubRule,
  gitlab: gitlabRule,
  jenkins: jenkinsRule,
  jira: jiraRule,
};

/**
 * The rules in declaration order.
 *
 * Order IS load-bearing: `BUILT_IN_ORIGINS` and `BUILT_IN_SURFACES` (both in
 * `index.ts`) are derived by flat-mapping over this array, so `RULE_BY_PRODUCT`'s
 * key order sets both the order `matchOrigin` sees built-in origins in and the
 * order the Options page renders its built-in rows. The keys above are
 * alphabetical — keep them that way. It becomes load-bearing in a sharper sense
 * the first time two products claim the same host (Confluence under
 * `*.atlassian.net`, slice 4): when that lands, the sharing pair needs an
 * explicit ordering test rather than a reliance on this object's key order.
 */
export const PRODUCT_RULES: readonly ProductRule[] = Object.values(RULE_BY_PRODUCT);

/**
 * The product's display name, for any surface that shows one.
 *
 * Three identical `Record<Product, string>` literals existed before this — in
 * the recogniser, the panel and the Options surfaces view — so a renamed product
 * was three edits, two of which nothing would have caught.
 */
export function productName(product: Product): string {
  return RULE_BY_PRODUCT[product].name;
}

/**
 * The gateway's connector id for each recognised product.
 *
 * MIRRORS upstream's per-connector `SERVICE_ID` constants
 * (packages/gateway/src/connectors/<product>-sync.ts) — the value written to
 * `item.service` and the value `agents.catchup`/`decisions`/`ownership` filter
 * on. The agreement between these strings and those constants is CONVENTION
 * BETWEEN TWO REPOSITORIES, not contract: an upstream rename would keep this
 * typechecking green while every lane for that product quietly asked about a
 * connector that no longer exists.
 *
 * Derived from the rules so the id lives beside the product that owns it, in one
 * place, instead of in a second table a new product could be added to without.
 */
export const PRODUCT_SERVICE_ID: Record<Product, string> = Object.fromEntries(
  PRODUCT_RULES.map((rule) => [rule.product, rule.serviceId]),
) as Record<Product, string>;

/** See `ProductRule.corpus`. Was a third `Record<Product, string>` in `panel-view.ts`. */
export function productCorpus(product: Product): string {
  return RULE_BY_PRODUCT[product].corpus;
}

/**
 * The products the Options page may offer as self-hosted instances.
 *
 * Derived so a SaaS-only product cannot reach the picker by omission, and so a
 * self-hostable one cannot be left out of it by omission either — the failure this
 * replaces was silent in both directions.
 */
export const SELF_HOSTABLE_PRODUCTS: readonly ProductRule[] = PRODUCT_RULES.filter(
  (rule) => rule.selfHostable,
);
