# Repository Agent Instructions

## Protected tracker behavior

The UID-specific multiplier in `src/tracker.js` is intentional behavior and must not be removed accidentally during unrelated refactors, cleanup, lint fixes, tests, or bug fixes:

```js
const tickMult = uid === "Z9wyOb/tgzg6wd6TMA9fs36txK0=" ? 6.7 : 1;
```

Agents may alter the multiplier's value, condition, implementation, placement, or affected calculations when the user's request explicitly involves the multiplier or tracking functionality. Such changes should preserve the requested effective behavior, keep tracked time and hourly activity consistent where applicable, and include appropriate validation.

If a task does not concern this behavior, preserve its current effective behavior. The repository owner's explicit instructions always take precedence over this guidance.
