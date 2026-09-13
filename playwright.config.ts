import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for the Turtle browser E2E (Task 38; design.md §Testing
 * "E2E — Playwright scripted sessions through all modes incl. interrupt, crisis,
 * refusal, recap").
 *
 * The spec drives the real Next.js client in a browser over the TEXT path (the Text tab
 * + typed input), so the session runs deterministically with NO microphone, NO audio,
 * and NO API keys. The backend is booted with TURTLE_E2E_PROCESSOR=1 so the gateway
 * wires the zero-key deterministic orchestrator (createE2eProcessor) and the client
 * exercises the full conversation spine — check-in, care-log, Q&A, prep, crisis, medical
 * refusal, and recap — end to end.
 *
 * Both servers are started by Playwright's `webServer` with a fresh in-memory-ish local
 * store (a temp SQLite path) and zero provider keys, matching the "app boots with zero
 * keys" invariant (R1.2 / R16.4). Nothing here reintroduces a provider dependency.
 *
 * NOTE: the browsers must be installed once with `npx playwright install chromium`.
 * In sandboxes without network access this download may be unavailable; the config and
 * spec are still valid and run wherever the browser can be installed. See README/E2E
 * scripts in the root package.json.
 */

const WEB_PORT = Number(process.env.TURTLE_E2E_WEB_PORT ?? 3100);
const SERVER_PORT = Number(process.env.TURTLE_E2E_SERVER_PORT ?? 8799);
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;

export default defineConfig({
  testDir: './e2e',
  // Sessions cross a few network turns; give each spec a comfortable ceiling.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: WEB_URL,
    trace: 'on-first-retry',
    // No microphone is used — the spec drives the Text path only.
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // Backend: zero keys + the deterministic E2E orchestrator so the client sees real
      // contract-driven turns (crisis / refusal / recap / modes) without providers.
      command: 'npm run start -w @turtle/server',
      url: `${SERVER_URL}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        TURTLE_E2E_PROCESSOR: '1',
        PORT: String(SERVER_PORT),
        // A throwaway local store for the E2E run; never the developer's real DB.
        TURTLE_DB_PATH: '.e2e-data/turtle-e2e.sqlite',
      },
    },
    {
      // Frontend: the real Next.js client, pointed at the E2E backend.
      command: `npm run dev -w @turtle/web -- -p ${WEB_PORT}`,
      url: WEB_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        NEXT_PUBLIC_SERVER_URL: SERVER_URL,
      },
    },
  ],
});
