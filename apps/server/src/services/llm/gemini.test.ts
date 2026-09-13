import { describe, expect, it, vi } from 'vitest';
import { createGeminiChatStream } from './gemini.js';

describe('createGeminiChatStream', () => {
  it('sends a JSON-constrained Gemini request and returns the generated text', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"say":"Hi","flags":["none"]}' }] } }] }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    try {
      const chunks = [];
      for await (const chunk of createGeminiChatStream({
        apiKey: 'test-key',
        model: 'gemini-3-flash-preview',
        signal: new AbortController().signal,
        messages: [
          { role: 'system', content: 'Reply as JSON.' },
          { role: 'user', content: 'Hello' },
        ],
      })) {
        chunks.push(chunk);
      }

      expect(chunks).toEqual([{ text: '{"say":"Hi","flags":["none"]}', done: true }]);
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toContain('/v1beta/models/gemini-3-flash-preview:generateContent?key=test-key');
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(JSON.parse(init.body)).toEqual({
        systemInstruction: { parts: [{ text: 'Reply as JSON.' }] },
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.3, maxOutputTokens: 512 },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
