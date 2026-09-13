import { test, expect, type Page, request as playwrightRequest } from '@playwright/test';

const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? 'http://127.0.0.1:8799';

/**
 * Reset the E2E backend to a clean slate before each test. The E2E server uses a
 * throwaway local store shared across the run, and onboarding state (consent + profile)
 * persists in it; wiping it between tests makes each test start at first-run onboarding
 * deterministically (one active caregiver, no consent, no profile), matching the
 * one-click delete-everything privacy control (R16.7).
 */
test.beforeEach(async () => {
  const ctx = await playwrightRequest.newContext();
  await ctx.delete(`${SERVER_URL}/everything`);
  await ctx.dispose();
});

/**
 * Turtle browser E2E — scripted session through all modes incl. interrupt, crisis,
 * refusal, recap (Task 38; design.md §Testing "E2E").
 *
 * Drives the REAL Next.js client in a browser over the TEXT path, against a backend
 * booted with the zero-key deterministic orchestrator (TURTLE_E2E_PROCESSOR=1). No
 * microphone, no audio, no API keys — deterministic and provider-free (R1.2 / R16.4).
 *
 * The client renders ONLY the contract's `say` (into the transcript) and `cards` (on the
 * single card surface), so these assertions verify the full spine end-to-end from the
 * user's seat: typed turn → WS → gateway → orchestrator → validated contract → rendered
 * transcript + card.
 *
 * The barge-in / interrupt path is a voice-only behavior (client VAD halts TTS playback);
 * with no audio in the text path there is nothing to interrupt, so the deterministic
 * barge-in guarantees (halt < 300ms, never penalized, partial discarded) are asserted at
 * the gateway level in apps/server/src/gateway/{barge-in,e2e,latency-targets}.test.ts.
 * This browser spec covers the remaining modes + crisis + refusal + recap from the UI.
 */

/** Complete first-run onboarding (AI disclosure + minimal profile + consent) and Start. */
async function completeOnboarding(page: Page): Promise<void> {
  await page.goto('/');
  // The onboarding dialog is the first thing shown (R16.10).
  const dialog = page.getByRole('dialog', { name: /welcome to turtle/i });
  await expect(dialog).toBeVisible();

  await page.locator('#ob-name').fill('Sam');
  // A care-team contact so the medical refusal names a dialable number.
  await page.locator('#ob-nurse').fill('+1 (555) 123-4567');
  // Explicit consent, then Start.
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: /^start$/i }).click();

  // The main app shell replaces onboarding (the Voice/Text tab switch appears).
  await expect(page.getByRole('tab', { name: /^text$/i })).toBeVisible();
}

/** Switch to the Text tab and return the input + send affordances. */
async function openTextMode(page: Page): Promise<void> {
  await page.getByRole('tab', { name: /^text$/i }).click();
  await expect(page.locator('#text-input')).toBeVisible();
}

/** Type a turn and send it. */
async function say(page: Page, text: string): Promise<void> {
  await page.locator('#text-input').fill(text);
  await page.getByRole('button', { name: /^send$/i }).click();
}

test.describe('Turtle E2E — scripted session over the text path', () => {
  test('runs check-in, care-log, Q&A, crisis, refusal, and recap end to end', async ({ page }) => {
    await completeOnboarding(page);
    await openTextMode(page);

    // The first-run greeting is shown in the transcript. (In dev, React StrictMode may
    // double-invoke the mount effect, rendering the greeting twice; assert the first.)
    await expect(page.getByText(/turtle is software/i).first()).toBeVisible();

    // CHECK-IN — a supportive turn. The assistant replies (contract `say` rendered).
    await say(page, "I'm exhausted and I don't know how much longer I can keep this up.");
    // The user's line echoes into the transcript…
    await expect(page.getByText("I'm exhausted and I don't know how much longer I can keep this up.")).toBeVisible();
    // …and an assistant reply lands (any non-empty assistant line beyond the greeting).
    await expect(page.locator('text=/holding up|here with you|hear you|tell me/i').first()).toBeVisible();

    // CARE LOG — a dictation surfaces a retained log card ("Logged").
    await say(page, 'I gave him his 2pm meds.');
    const logCard = page.getByRole('dialog', { name: /logged/i });
    await expect(logCard).toBeVisible();
    // Dismiss it so the surface is clear for the next assertion (one active card, R10.6).
    await logCard.getByRole('button', { name: /dismiss/i }).click();
    await expect(logCard).toBeHidden();

    // Q&A — a diagnosis question with no KB wired declines rather than guessing (R8.3).
    await say(page, 'What does metastatic mean?');
    await expect(page.getByText(/this is one for your care team/i)).toBeVisible();

    // CRISIS — the protocol speaks 988 and shows a safety card (R13). The 988 line is
    // spoken (in the transcript) AND shown on the card — spoken AND shown (R13.5). The
    // safety card is one-tap dialable (its Call action targets tel:988). The specific
    // tel: target is asserted deterministically at the gateway level
    // (apps/server/src/gateway/e2e.test.ts); here we verify the card + Call from the UI.
    await say(page, "I can't do this anymore, I just want it to be over.");
    const crisisCard = page.getByRole('dialog', { name: /988/i });
    await expect(crisisCard).toBeVisible();
    await expect(page.getByText(/988/).first()).toBeVisible();
    await expect(crisisCard.getByRole('button', { name: /call/i })).toBeVisible();
    await crisisCard.getByRole('button', { name: /dismiss/i }).click();

    // MEDICAL REFUSAL — refuse + redirect with an actionable care-team card (R5.3/R5.4).
    // The card carries a single action button; whether it is a dialable "Call" depends on
    // the resolved care-team contact (asserted precisely at the gateway level). Here we
    // assert the actionable card appears and that NO dosing was given (never a partial
    // answer — the refuse+redirect invariant seen from the UI).
    await say(page, 'How much morphine can I give him?');
    const refusalCard = page.getByRole('dialog', { name: /ask your care team/i });
    await expect(refusalCard).toBeVisible();
    // No dosing was given (never a partial answer).
    await expect(page.getByText(/\bmg\b|milligram/i)).toHaveCount(0);
    await refusalCard.getByRole('button', { name: /dismiss/i }).click();

    // RECAP / CLOSE — a closing phrase speaks a recap and shows a recap card (R14).
    await say(page, 'I have to go now.');
    const recapCard = page.getByRole('dialog', { name: /session recap/i });
    await expect(recapCard).toBeVisible();
  });

  test('a no-card conversational turn leaves only the transcript (R10.5)', async ({ page }) => {
    await completeOnboarding(page);
    await openTextMode(page);

    // A plain check-in produces no card, so the card surface stays empty.
    await say(page, 'I just needed to vent for a minute.');
    await expect(page.getByText('I just needed to vent for a minute.')).toBeVisible();
    // No card dialog is present on the surface (safety/actionable/retained all absent).
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});
