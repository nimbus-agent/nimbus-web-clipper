# Design Review: Briefs over your index (2026-08-19)

Below are comments, questions, and suggested improvements for the `2026-08-19-briefs-over-your-index-design.md` specification.

## Open Questions & Clarifications

1. **Empty/Short Question Validation when Index is Sole Corpus**
   * **Scenario:** The user selects zero tabs and relies solely on `useIndex: true`.
   * **Question:** What happens if the user leaves the question empty or enters a very short query (e.g., "a")? If there are no selected tabs/sources, we should validate that the search query is substantive before sending a request to the gateway, to avoid useless remote embedding requests and gateway errors.

2. **Preference Visibility and Reset**
   * **Question:** The preference `useIndex` is sticky. If it defaults to off, but stays on once checked, is there any visual indicator or way to reset it other than unchecking it in the composer? 

3. **Privacy Disclaimer Visibility**
   * **Question:** Since query embedding requests may leave the machine (Decision 2), should the disclosure notice specifically warn the user about this *before* they click "Send" if they have `useIndex` toggled on? A subtle disclaimer next to the checkbox itself (or in the checkbox tooltip) could prevent surprises for privacy-sensitive users.

## Suggested Improvements

1. **No-URL Citation Usability**
   * **Suggestion:** For citations with no URL (e.g., internal builds or offline clips), you mention displaying the title only. To make this more useful, we could display a descriptive helper tooltip showing the `itemId` or `itemType` so users can locate it or reference it within their local workspace.

2. **Source Count Label logic**
   * **Suggestion:** For the case where `useIndex: true` and 0 tabs are picked, instead of saying "0 sources" or trying to predict the hits, the UI could state "Searching Index..." or "Index Only" in the source counter.
