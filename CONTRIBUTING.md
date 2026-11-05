# Contributing to FQD

Thanks for helping. Bug reports, provider fixes and documentation improvements are all welcome.

## Before you start

- For anything larger than a small fix, open an issue first so we can agree on the approach.
- Read [docs/architecture.md](docs/architecture.md) for how the server, shared code and web panel fit together.
- FQD's core rule is **no invented numbers**: if a provider does not report a value, show it as missing rather than estimating or filling in a default. Changes that display placeholder or sample data in the product will not be merged.

## Development setup

Requires Node.js 22 or 24.

```bash
git clone https://github.com/piyushkumarjiit/FQD.git
cd FQD
npm ci
npm run build
cp .env.example .env   # set ADMIN_PASSWORD and APP_SECRET (openssl rand -hex 32)
set -a && . ./.env && set +a && DATA_DIR=./data npm run server
```

The panel is then at `http://localhost:1455`. Rebuild with `npm run build:web` or `npm run build:server` after changes.

## Checks

Run these before opening a pull request; CI runs the same on Node 22 and 24:

```bash
npm run typecheck:all
npm test
```

`tests/security_tests.ts` and `tests/final_hardening_tests.ts` check Unix file permissions and fail on Windows; run them on Linux, macOS or WSL.

Add or update tests for behaviour you change. Tests are plain `tsx` scripts in `tests/`; new files must be added to the `test` script in `package.json`.

## Pull requests

- Keep each pull request to one change, and describe what changed and why.
- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages, for example `fix(web): …` or `feat(telemetry): …`.
- Include a screenshot for visible UI changes. Anonymise account emails and any other personal data.
- Never commit secrets, `.env` files, database files or provider tokens.
- Do not change the key-derivation salts in `server/src/store.ts`; doing so makes every existing installation's stored credentials unreadable.

## Adding a provider

Provider adapters live in `src/services/providers/` and implement `UsageProvider`. Simple services can be added as a recipe in `recipes.ts` instead. Each adapter must report only what the provider's usage endpoint returns, mark failures with an explicit error status, and come with parser tests using recorded (anonymised) responses.

## Reporting security issues

Please do not open a public issue for vulnerabilities. Use GitHub's private reporting instead: **Security → Report a vulnerability** on this repository. Include the affected version or commit, reproduction steps and impact.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
