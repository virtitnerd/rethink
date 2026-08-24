# Contributing to rethink

## Adding support for a new device

See the [wiki guide](https://github.com/anszom/rethink/wiki/Adding-support-for-a-new-device) - it covers the full workflow, including the ThinQ1 `modelJson` technique and the ThinQ2 TLV/AABB packet-decoding tools.

When you open the PR, add `?template=device_support.md` to the end of the "Open a pull request" page's URL to get the right template (GitHub doesn't auto-select between multiple templates, you have to ask for one explicitly).

## Everything else

Add `?template=general.md` to the "Open a pull request" page's URL, or just open a PR without a template and describe the change and how you tested it.

## Before submitting

- `npm test` - the full test suite
- `npx tsc --noEmit` - typecheck
- `npx prettier . --check` - formatting (CI enforces this)

These are exactly what [CI](.github/workflows/ci.yml) runs, so a clean local pass means CI should pass too.

## Guidelines

- The primary goal is to map device protocols to Home Assistant with little or no extra logic. Expose what the device reports and accepts, faithfully.
- Do not implement behaviour such as timers, schedules, or safety locks - that belongs in Home Assistant, not in a device class.
- Do not intentionally circumvent a device's own safety features.
- LLM-generated code is fine, as long as you understand it and can explain the reasoning behind it. Unreviewed or unexplained generated code will not be accepted.
