## Summary

<!-- What does this change and why? -->

## Checklist

- [ ] `bun run typecheck` passes
- [ ] `bun run lint` passes
- [ ] `bun run test` passes (tests added/updated for behavior changes)
- [ ] `bun run build` succeeds and `bun run check-build` passes
- [ ] No network calls or `host_permissions` beyond `127.0.0.1` / `localhost`
- [ ] The bearer token and pairing code are never logged or written to the page DOM
