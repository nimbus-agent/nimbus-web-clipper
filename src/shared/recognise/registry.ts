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
 * Order is not load-bearing today — no two products claim the same host — and it
 * becomes load-bearing the first time two do (Confluence under `*.atlassian.net`,
 * slice 4). When that lands, the sharing pair needs an explicit ordering test
 * rather than a reliance on this object's key order.
 */
export const PRODUCT_RULES: readonly ProductRule[] = Object.values(RULE_BY_PRODUCT);
