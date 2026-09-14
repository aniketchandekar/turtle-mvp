import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { ModeOutput } from '@turtle/shared';
import { SCHEMA_SQL } from '../store/schema.js';
import { createCipher } from '../store/crypto.js';
import { createRepositories, type Repositories } from '../store/repositories.js';
import type { LlmMessage, LlmProvider, LlmStreamChunk } from '../services/llm/index.js';
import { MODES, type Mode } from './index.js';
import {
  createModeRouter,
  resolveMode,
  routeByRules,
  parseClassifiedMode,
  recordMode,
  isAppointmentCreation,
  isVisitSummaryDictation,
  isSummaryRetrievalQuery,
  DEFAULT_MODE,
} from './mode-router.js';

/**
 * Mode router (Task 18, R6.1).
 *
 * The router runs AFTER the safety classifier; crisis/medical bypass routing, so it
 * only handles the non-safety `none` case and returns one of checkin / qa / log /
 * prep. Coverage:
 *   1. Rules-first hits — log dictation, appointment/prep retrieval, diagnosis Q&A.
 *   2. Classifier fallback — ambiguous text is routed by the small intent classifier.
 *   3. Zero-key graceful degradation — no live LLM → default to `checkin` (R16.4).
 *   4. Range invariant — the router only ever returns a valid Mode, never
 *      crisis/medical (those bypass routing entirely).
 *   5. mode_transitions recording — the chosen mode is appended to the session
 *      through the existing repository seam.
 *
 * The deterministic rules run with no network. The classifier path uses a FAKE
 * LlmProvider (mirroring llm.test.ts), and the persistence test uses an in-memory
 * SQLite store (matching store.test.ts / contract-validator.test.ts). No real LLM.
 */

/** A fake LlmProvider whose `complete().say` carries a canned classifier reply. */
function fakeLlm(reply: string, opts: { live?: boolean } = {}): LlmProvider {
  return {
    id: 'fake',
    live: opts.live ?? true,
    async complete(_messages: LlmMessage[]): Promise<ModeOutput> {
      return { say: reply, cards: [], memory_ops: [], flags: ['none'] };
    },
    stream(_messages: LlmMessage[]): AsyncIterable<LlmStreamChunk> {
      return (async function* () {
        yield { text: reply, done: true };
      })();
    },
  };
}

/** A fake LlmProvider whose `complete` rejects (drives the error → default path). */
function throwingLlm(): LlmProvider {
  return {
    id: 'boom',
    live: true,
    async complete(): Promise<ModeOutput> {
      throw new Error('classifier boom');
    },
    stream(): AsyncIterable<LlmStreamChunk> {
      return (async function* () {
        throw new Error('classifier boom');
      })();
    },
  };
}

describe('routeByRules — deterministic rules-first (design.md §Mode router)', () => {
  it('routes log dictation to `log`', () => {
    expect(routeByRules('I gave the 2pm meds')).toBe('log');
    expect(routeByRules('He took his morning pills')).toBe('log');
    expect(routeByRules('She slept badly last night')).toBe('log');
    expect(routeByRules("He didn't sleep at all")).toBe('log');
    expect(routeByRules('He barely ate today')).toBe('log');
    expect(routeByRules('New cough this morning')).toBe('log');
    expect(routeByRules('The nausea is worse today')).toBe('log');
    expect(routeByRules('Just to note, we were up all night')).toBe('log');
  });

  it('routes appointment retrieval / prep to `prep`', () => {
    expect(routeByRules('What were the questions for Tuesday?')).toBe('prep');
    expect(routeByRules('When is the appointment?')).toBe('prep');
    expect(routeByRules('When is the next appointment')).toBe('prep');
    expect(routeByRules('What did the doctor say?')).toBe('prep');
    expect(routeByRules('Remind me what the oncologist said')).toBe('prep');
    expect(routeByRules('What should I ask at the visit?')).toBe('prep');
  });

  it('routes appointment CREATION to `prep` (Task 28, R12.1)', () => {
    expect(routeByRules('Add an appointment with Dr. Lee on Tuesday at 2pm')).toBe('prep');
    expect(routeByRules('Schedule oncology next Friday')).toBe('prep');
    expect(routeByRules('Book a follow-up with Dr. Chen')).toBe('prep');
    expect(routeByRules('Set up a scan appointment')).toBe('prep');
    expect(routeByRules('Make an appointment for Monday')).toBe('prep');
  });

  it('routes diagnosis questions to `qa`', () => {
    expect(routeByRules('What is metastatic cancer?')).toBe('qa');
    expect(routeByRules('Why does he feel so tired?')).toBe('qa');
    expect(routeByRules('How does chemotherapy work?')).toBe('qa');
    expect(routeByRules('What should I expect next?')).toBe('qa');
  });

  it('routes explicit caregiver-resource requests to `resources`', () => {
    expect(routeByRules('Find caregiver support groups near me')).toBe('resources');
    expect(routeByRules('I need financial assistance resources')).toBe('resources');
    expect(routeByRules('Can you find transportation help?')).toBe('resources');
  });

  it('returns null for ambiguous text the rules do not confidently catch', () => {
    expect(routeByRules("I'm feeling really overwhelmed")).toBeNull();
    expect(routeByRules('It was a hard day')).toBeNull();
    expect(routeByRules('Hi')).toBeNull();
  });

  it('prioritizes log dictation over a trailing question mark', () => {
    // A dictation statement wins even if punctuated oddly; genuine questions phrased
    // as understanding ("what is …") still reach qa in the case above.
    expect(routeByRules('I gave the meds already?')).toBe('log');
  });
});

describe('parseClassifiedMode — map a classifier reply onto a Mode', () => {
  it('accepts a bare mode word', () => {
    expect(parseClassifiedMode('checkin')).toBe('checkin');
    expect(parseClassifiedMode('qa')).toBe('qa');
    expect(parseClassifiedMode('log')).toBe('log');
    expect(parseClassifiedMode('prep')).toBe('prep');
  });

  it('tolerates surrounding prose / punctuation and casing', () => {
    expect(parseClassifiedMode('The intent is: QA.')).toBe('qa');
    expect(parseClassifiedMode('  Log  ')).toBe('log');
  });

  it('returns null when no recognizable mode is present', () => {
    expect(parseClassifiedMode('unknown')).toBeNull();
    expect(parseClassifiedMode('')).toBeNull();
  });
});

describe('isAppointmentCreation — split creation vs. retrieval within `prep` (Task 28)', () => {
  it('is true for appointment ADD statements', () => {
    expect(isAppointmentCreation('Add an appointment with Dr. Lee on Tuesday')).toBe(true);
    expect(isAppointmentCreation('Schedule oncology next Friday')).toBe(true);
    expect(isAppointmentCreation('Book a follow-up with Dr. Chen')).toBe(true);
    expect(isAppointmentCreation('Set up a scan appointment')).toBe(true);
    expect(isAppointmentCreation('Make an appointment for Monday')).toBe(true);
  });

  it('is false for appointment RETRIEVAL / prep questions (no regression)', () => {
    expect(isAppointmentCreation('When is the appointment?')).toBe(false);
    expect(isAppointmentCreation('What were the questions for Tuesday?')).toBe(false);
    expect(isAppointmentCreation('What did the doctor say?')).toBe(false);
    expect(isAppointmentCreation('When is the next appointment')).toBe(false);
  });

  it('is false for non-appointment turns', () => {
    expect(isAppointmentCreation("I'm feeling overwhelmed")).toBe(false);
    expect(isAppointmentCreation('What is metastatic cancer?')).toBe(false);
    expect(isAppointmentCreation('I gave the 2pm meds')).toBe(false);
  });
});

describe('isVisitSummaryDictation — split visit-summary write vs. retrieval (Task 30)', () => {
  it('is true for dictation of what the clinician said', () => {
    expect(
      isVisitSummaryDictation('The doctor said the scan was stable and to keep the same dose'),
    ).toBe(true);
    expect(isVisitSummaryDictation('The oncologist told me the labs look good')).toBe(true);
    expect(isVisitSummaryDictation('What the doctor said today: come back in two weeks')).toBe(true);
    expect(isVisitSummaryDictation("Here's what happened at the appointment")).toBe(true);
  });

  it('is false for RETRIEVAL questions (a bare question, not a report)', () => {
    expect(isVisitSummaryDictation('What did the doctor say?')).toBe(false);
    expect(isVisitSummaryDictation('What were the questions for Tuesday?')).toBe(false);
    expect(isVisitSummaryDictation('When is the appointment?')).toBe(false);
  });

  it('is false for non-visit turns', () => {
    expect(isVisitSummaryDictation('I gave the 2pm meds')).toBe(false);
    expect(isVisitSummaryDictation('What is chemotherapy?')).toBe(false);
  });

  it('routes dictation statements to `prep`', () => {
    expect(routeByRules('The doctor said the scan was stable')).toBe('prep');
  });
});

describe('isSummaryRetrievalQuery — prep/summary retrieval within `prep` (Task 30)', () => {
  it('is true for prep/summary retrieval questions', () => {
    expect(isSummaryRetrievalQuery('What were the questions for Tuesday?')).toBe(true);
    expect(isSummaryRetrievalQuery('What did the doctor say?')).toBe(true);
    expect(isSummaryRetrievalQuery('Read me the visit summary')).toBe(true);
  });

  it('is false for a dictation statement (write path wins, mutually exclusive)', () => {
    expect(isSummaryRetrievalQuery('The doctor said the scan was stable')).toBe(false);
  });

  it('is false for unrelated turns', () => {
    expect(isSummaryRetrievalQuery("I'm feeling overwhelmed")).toBe(false);
    expect(isSummaryRetrievalQuery('I gave the 2pm meds')).toBe(false);
  });
});

describe('resolveMode — rules-first, then classifier, then default', () => {
  it('returns the ruled mode without consulting the LLM', async () => {
    const llm = fakeLlm('checkin');
    const spy = vi.spyOn(llm, 'complete');
    expect(await resolveMode('I gave the 2pm meds', llm)).toBe('log');
    expect(spy).not.toHaveBeenCalled();
  });

  it('falls back to the intent classifier for ambiguous text', async () => {
    const llm = fakeLlm('qa');
    const spy = vi.spyOn(llm, 'complete');
    // Ambiguous phrasing (no rule fires) → classifier decides.
    expect(await resolveMode('Tell me more about his condition', llm)).toBe('qa');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('defaults to checkin when the classifier reply is unusable', async () => {
    const llm = fakeLlm('no idea');
    expect(await resolveMode("I'm exhausted", llm)).toBe(DEFAULT_MODE);
  });

  it('defaults to checkin when the classifier throws (no throw mid-turn)', async () => {
    expect(await resolveMode("I'm exhausted", throwingLlm())).toBe(DEFAULT_MODE);
  });
});

describe('resolveMode — zero-key graceful degradation (R16.4)', () => {
  it('skips the classifier and defaults to checkin with no LLM at all', async () => {
    expect(await resolveMode("I'm having a hard time")).toBe('checkin');
  });

  it('skips the classifier for a non-live (canned) provider and defaults to checkin', async () => {
    const canned = fakeLlm('qa', { live: false });
    const spy = vi.spyOn(canned, 'complete');
    expect(await resolveMode('It was a long day', canned)).toBe('checkin');
    // A non-live provider would only echo; it must not be consulted for routing.
    expect(spy).not.toHaveBeenCalled();
  });

  it('still applies the deterministic rules with no LLM present', async () => {
    expect(await resolveMode('I gave the 2pm meds')).toBe('log');
    expect(await resolveMode('When is the appointment?')).toBe('prep');
    expect(await resolveMode('What is metastatic cancer?')).toBe('qa');
  });
});

describe('createModeRouter — only ever returns a valid Mode (never crisis/medical)', () => {
  it('returns a member of MODES for a spread of inputs', async () => {
    const router = createModeRouter({ llm: fakeLlm('checkin') });
    const inputs = [
      'I gave the 2pm meds',
      'When is the appointment?',
      'What is metastatic cancer?',
      "I'm scared and overwhelmed",
      'He barely ate today',
      'What did the doctor say?',
      '',
    ];
    for (const input of inputs) {
      const mode = await router.route(input);
      expect(MODES).toContain(mode);
      // The router never surfaces safety verdicts — those bypass routing entirely.
      expect(mode).not.toBe('crisis' as unknown as Mode);
      expect(mode).not.toBe('medical' as unknown as Mode);
    }
  });

  it('conforms to the ModeRouter interface (async route → Mode)', async () => {
    const router = createModeRouter();
    const mode: Mode = await router.route('hello');
    expect(MODES).toContain(mode);
  });
});

describe('createModeRouter — records the chosen mode in mode_transitions (R6.1)', () => {
  let repos: Repositories;

  beforeEach(() => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA_SQL);
    repos = createRepositories(db, createCipher('test-key'));
  });

  it('appends the routed mode to the session via the repository seam', async () => {
    const cg = repos.caregiver.create({ display_name: 'Alex' });
    const session = repos.session.create(cg.id);

    const router = createModeRouter({ record: recordMode(repos, session.id) });

    expect(await router.route('I gave the 2pm meds')).toBe('log');
    expect(await router.route("I'm feeling low today")).toBe('checkin');

    const after = repos.session.get(session.id);
    expect(after?.mode_transitions).toEqual(['mode:log', 'mode:checkin']);
  });

  it('invokes the injected record hook with the chosen mode', async () => {
    const record = vi.fn();
    const router = createModeRouter({ record });
    const mode = await router.route('When is the appointment?');
    expect(mode).toBe('prep');
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith('prep');
  });

  it('routes fine with no record hook (recording is opt-in)', async () => {
    const router = createModeRouter();
    await expect(router.route('What is metastatic cancer?')).resolves.toBe('qa');
  });
});
