# Review & Suggestions: Panel Page Context Design

This document contains open questions, suggestions, and potential improvements for the proposed design in [2026-08-11-panel-page-context-design.md](file:///C:/gitrep/nimbus-web-clipper/docs/superpowers/specs/2026-08-11-panel-page-context-design.md).

## 1. Performance & Lifecycle Optimization
* **Interval Polling when Panel is Minimized/Closed:**
  * **Question:** Should the 500ms `setInterval` continue running if the panel is minimized (collapsed) or closed by the user?
  * **Suggestion:** We should pause/clear the interval when the panel is not visible or active to save CPU cycles and battery on user devices. The polling can be resumed when the panel is expanded/re-opened, triggering an immediate check.

## 2. Race Conditions on `recognise` Messages
* **Out-of-order Responses:**
  * **Scenario:** If a user navigates rapidly through multiple pages (e.g., `A` -> `B` -> `C`) within a short duration, the panel script will fire multiple async `recognise` messages to the background worker.
  * **Suggestion:** To prevent out-of-order responses from applying incorrect/stale states, the panel script should:
    * Keep track of the last sent URL for the `recognise` request.
    * Ignore responses if the current page URL does not match the URL associated with the response.
    * Alternatively, associate a local request counter/generation with each `recognise` message.

## 3. DOM Dependency vs. Pure URL Recognition
* **Question:** Does the recogniser for any supported platform (GitHub, GitLab, Jira) rely on DOM parsing/content scraping to determine identity, or is identity always derivable purely from the URL string?
  * **Context:** The design states `handleRecognise` is a pure function taking `req.pageUrl` and `origins` list. If any page types require reading DOM metadata (e.g., scraping Jira issue IDs from the page title or elements when URLs are ambiguous), a background-only URL recogniser might fail or be incomplete.
  * **Recommendation:** Double-check if the recogniser is entirely URL-based across all targets. If not, the DOM state must be passed along with the message or parsed in the content script.

## 4. User Interaction and UX while Banner is Shown
* **Question:** When the "navigated away" banner is visible, are the lanes for the pinned (old) page still interactive?
  * **Suggestion:** If the user can still trigger actions or read old lane answers, we should make sure the UI clearly reflects that these actions apply to the *pinned* page (e.g., visually styling the lanes slightly differently or adding context to the run buttons). If they are not meant to be interactive, we should consider putting a disabled state or overlay on the lanes until "Re-read page" is clicked.

## 5. Transition between Unrecognised Pages
* **Question:** If a user opens the panel on an unrecognised page, navigates to another unrecognised page, and then clicks "Re-read page", does the state pin correctly?
  * Since `sameItem` evaluates both as equal (both `ok: false`), no banner will show between two unrecognised pages. This behaves correctly as per the spec, but we should make sure that if the user manually re-reads an unrecognised page, the pinned URL/identity is updated to the current one so that subsequent navigation to a *recognised* page correctly fires the banner.
