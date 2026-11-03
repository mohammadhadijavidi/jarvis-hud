# Contributing

Thanks for helping. Keep changes small and focused.

1. `npm install`
2. `npm run mock` in one terminal, `npm run dev` in another, open http://localhost:5173
3. Make your change. Logic that can be pure (protocol parsing, reducer, geometry, adapters) should be, and should have a test in `tests/`.
4. `npm run typecheck && npm test && npm run build` must pass.
5. If you change the look of the HUD, regenerate `assets/hero.png` with `npm run screenshot` (see `scripts/screenshot.py`) and include it in the PR.

Protocol changes: add new event types rather than changing existing ones, and update `parseServerEvent` / `parseClientEvent`, the README protocol table, and the tests together.

Please do not commit API keys. Use `.env` (ignored) and `.env.example` for documentation.
