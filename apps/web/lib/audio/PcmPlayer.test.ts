import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PcmPlayer } from './PcmPlayer';

/**
 * Card-gating timing (Task 24, R10.3/R16.2).
 *
 * The card surface must render only AFTER the turn's spoken audio finishes, and never
 * for an utterance that was interrupted. Both edges live in the player's `onIdle`
 * signal: it fires once when the scheduled queue fully drains, and is suppressed after
 * a `flush()` (barge-in). These tests drive that contract with a fake Web Audio graph
 * so the pure scheduling/idle logic is exercised without a real AudioContext.
 */

/** A scheduled source whose `onended` we can fire on demand (simulating drain). */
class FakeBufferSource {
  onended: (() => void) | null = null;
  buffer: { duration: number } | null = null;
  started = false;
  stopped = false;
  connect() {}
  disconnect() {}
  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
  /** Simulate playback completing for this chunk. */
  end() {
    this.onended?.();
  }
}

class FakeAudioContext {
  currentTime = 0;
  state: AudioContextState = 'running';
  readonly sources: FakeBufferSource[] = [];
  createGain() {
    return { connect() {}, disconnect() {} } as unknown as GainNode;
  }
  createBuffer(_channels: number, length: number, sampleRate: number) {
    const data = new Float32Array(length);
    return {
      duration: length / sampleRate,
      getChannelData: () => data,
    } as unknown as AudioBuffer;
  }
  createBufferSource() {
    const s = new FakeBufferSource();
    this.sources.push(s);
    return s as unknown as AudioBufferSourceNode;
  }
  async resume() {
    this.state = 'running';
  }
  async close() {
    this.state = 'closed';
  }
}

/** One 16-bit sample chunk (2 bytes) is enough — content is irrelevant to scheduling. */
function chunk(): ArrayBuffer {
  return new ArrayBuffer(4);
}

describe('PcmPlayer — end-of-utterance idle signal (card gating)', () => {
  let ctx: FakeAudioContext;

  beforeEach(() => {
    ctx = new FakeAudioContext();
    // Stub the constructor path used by ensureContext().
    (globalThis as unknown as { window: unknown }).window = {
      AudioContext: undefined,
      webkitAudioContext: undefined,
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  it('fires onIdle exactly once when the whole queue drains', () => {
    const onIdle = vi.fn();
    const player = new PcmPlayer({ context: ctx as unknown as AudioContext, onIdle });

    player.enqueue(chunk());
    player.enqueue(chunk());
    expect(player.isIdle()).toBe(false);
    expect(onIdle).not.toHaveBeenCalled();

    // First chunk finishes: queue not yet empty → no idle.
    ctx.sources[0].end();
    expect(onIdle).not.toHaveBeenCalled();

    // Last chunk finishes: queue empty → idle fires once.
    ctx.sources[1].end();
    expect(onIdle).toHaveBeenCalledTimes(1);
    expect(player.isIdle()).toBe(true);
  });

  it('does NOT fire onIdle after a flush (barge-in) — interrupted speech never surfaces a card', () => {
    const onIdle = vi.fn();
    const player = new PcmPlayer({ context: ctx as unknown as AudioContext, onIdle });

    player.enqueue(chunk());
    player.enqueue(chunk());

    // Barge-in: flush stops sources and invalidates the stream.
    player.flush();
    expect(player.isIdle()).toBe(true);

    // A late `onended` from a stopped source must not fire idle for a dead stream.
    ctx.sources[0].end();
    ctx.sources[1].end();
    expect(onIdle).not.toHaveBeenCalled();
  });

  it('starts a fresh stream after flush and fires idle on the new stream draining', () => {
    const onIdle = vi.fn();
    const player = new PcmPlayer({ context: ctx as unknown as AudioContext, onIdle });

    player.enqueue(chunk());
    player.flush();

    // Next turn: a new chunk schedules and, on completion, fires idle normally.
    player.enqueue(chunk());
    const fresh = ctx.sources[ctx.sources.length - 1];
    fresh.end();
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('reports idle when nothing has been enqueued', () => {
    const player = new PcmPlayer({ context: ctx as unknown as AudioContext });
    expect(player.isIdle()).toBe(true);
  });
});
