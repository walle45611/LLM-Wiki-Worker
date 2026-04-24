# LLMWikiWorker

## Commands
- Install exactly as CI does: `bun install --frozen-lockfile`
- Run tests: `bun run test`
- Run one test file: `node --test --test-concurrency=1 test/query-agent.test.js`
- Run a named test: `node --test --test-concurrency=1 --test-name-pattern="..."`
- Deploy uses Wrangler through the package script: `bun run deploy`
- `README.md` mentions `bun run dev`, but `package.json` has no `dev` script. Do not assume a local dev shortcut exists without adding it.

## Repo Shape
- This is a single-package Cloudflare Worker repo, not a monorepo.
- Runtime entrypoint is `src/index.js`; `wrangler.jsonc` points `main` at `src/index.js`.
- `src/index.js` owns all three execution paths: Hono HTTP app, `scheduled` handler, and queue consumer.
- Queue jobs are limited to `telegram_text_query` and `scheduled_summary`.
- Tests are split by responsibility under `test/*.test.js`; many internals are still re-exported from `src/index.js` for black-box coverage.

## Runtime Wiring
- The worker reads and writes a separate GitHub knowledge repo, not this code repo. Defaults in `wrangler.jsonc`: `GITHUB_OWNER=walle4561`, `GITHUB_REPO=LLM-Wiki`, `GITHUB_REF=main`.
- The query agent is instructed to read repo-root `AGENTS.md` and then `wiki/rules/router-rules.md` from that GitHub knowledge repo. In this repo, `templates/AGENTS.md` is the template source for that external repo workflow.
- Query-agent write tools are hard-limited to paths under `wiki/`; changing tool behavior requires updating both code and tests.
- `get_file_tree` advertises `max_depth` up to 4, but the implementation clamps it to 2.

## Verification Priorities
- If you change webhook, queue, or scheduled flow, run `bun run test`; there is good coverage for secret validation, queue enqueueing, fallback replies, GitHub tool behavior, and date handling.
- If you change AI output handling, preserve the Telegram safety contract: structured `blocks` are preferred, and plain-text fallback must reject Markdown-like formatting.

## Env And Deploy
- `getRuntimeConfig()` requires `TELEGRAM_BOT_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO`, and `GITHUB_TOKEN` for normal runtime startup.
- `TELEGRAM_WEBHOOK_SECRET` is enforced by `POST /webhook`.
- `TELEGRAM_CHAT_ID` is only required for the scheduled-summary path.
- `APP_TIMEZONE` defaults to `Asia/Taipei`; `AI_MODEL` defaults in code to `@cf/openai/gpt-oss-20b`, but `wrangler.jsonc` currently overrides it to `@cf/google/gemma-4-26b-a4b-it`.
- CI deploys only on pushes to `main`: install, test, then `bun run deploy`.

## Editing Conventions
- Follow `.editorconfig`: 4-space indentation, LF endings, UTF-8, no forced final newline, and trailing whitespace is not trimmed automatically.
