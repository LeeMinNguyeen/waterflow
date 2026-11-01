## What and why

<!-- One concern per PR. What changed, and why. -->

## How I tested it

<!-- Commands run, or the steps clicked through. -->

## Risk

<!-- Low, medium or high (CLAUDE.md, "Risk and review"), and why. Medium and high: the /code-review result; high: the /security-review result too. Any default from the issue's plan that this builds on. -->

## How to revert

<!-- High risk only: how to undo it once released, migrations included. -->

## Checklist

- [ ] The API only adds within `/v1` (mobile apps will talk to older and newer servers).
- [ ] Vietnamese and English strings both updated.
- [ ] No route, setting, error code, command or setup step changed, **or** the paired docs PR (waterflow-landing, `src/content/docs/`) is: <!-- link -->
