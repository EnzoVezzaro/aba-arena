# release.md — Release Checklist

A generic checklist for cutting a release of an ACC-enhanced project.

## Before release

- [ ] `acc check` passes with zero `error`-level diagnostics.
- [ ] Every functionality directory changed since the last release has its
      `AGENTS.md` updated (purpose, ownership, dependencies, constraints).
- [ ] `.acc-memory.md` records exist for the boundaries you worked in, with
      the durable lessons of this cycle.
- [ ] The project's own tests/build pass from a clean checkout.

## During release

- [ ] Tag the release from a clean revision.
- [ ] Confirm the changelog describes user-visible changes.

## After release

- [ ] Record the release in the root memory:
      `acc memory add . "Released <version> — <summary> on <date>."`
