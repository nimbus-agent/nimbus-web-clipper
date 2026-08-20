# Design Review: Faithful metadata and a canonical URL you can trust (2026-08-20)

Below are comments, questions, and suggested improvements for the `2026-08-20-faithful-metadata-and-canonical-url-design.md` specification.

## Open Questions & Clarifications

1. **HTTP to HTTPS Upgrades / Same-Origin Restriction (Rung 4)**
   * **Scenario:** An HTTP page (`http://example.com/page`) specifies an HTTPS canonical URL (`https://example.com/page`) during or after a migration. 
   * **Question:** Under Rung 4, the origin must match exactly (scheme + host + port). Since the schemes differ (`http` vs `https`), this canonical URL will be rejected, falling back to the address bar. Is it desirable to reject HTTPS upgrades for canonical URLs, or should we allow same-host scheme upgrades (but still reject downgrades like HTTPS to HTTP)?
   * **Subdomain variations (e.g. www vs non-www):** Many sites canonicalize from `https://example.com` to `https://www.example.com` or vice-versa. Rung 4 will reject these as cross-origin. While fallback to the address bar is safe, it might lead to duplicate items if the user clips the same page from different entry points. Should there be a relaxed rule for matching registered/base domains?

2. **Rejection Warning Copy Customization**
   * **Question:** The spec mentions rendering: *"This page asked to be saved as another site's address; Nimbus ignored it."* This copy fits `cross-origin` rejections perfectly. However, for a `root-collapse` rejection, stating "another site's address" is misleading. Should we define user-facing warning strings tailored to each specific `CanonicalRejection` reason (e.g., *"This page asked to be saved as the site's homepage; Nimbus ignored it."* for root collapse)?

3. **`leadImage` Same-Origin and Validation**
   * **Question:** The spec states that `leadImage` runs through "the same absolutise-and-validate rungs as the canonical URL". If this includes Rung 4 (Same-Origin), it will reject images hosted on CDNs (e.g., `https://cdn.example.com`, `https://images.unsplash.com`, or AWS S3), which are extremely common for modern websites. Can we clarify that `leadImage` skips the same-origin origin check, or applies a different validation policy?

## Suggested Improvements

1. **Pre-send Preview Extensibility**
   * **Suggestion:** When a canonical URL is rejected, displaying the warning is great. To make the preview even more helpful, we could show the actually resolved fallback URL (i.e. the address bar URL that will be sent) so the user knows exactly what address is being used for their clip identity.
