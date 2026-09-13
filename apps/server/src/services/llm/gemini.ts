import type { ChatStreamFactory, LlmMessage, LlmStreamChunk } from './index.js';

const GEMINI_HOST = 'https://generativelanguage.googleapis.com';

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
  }>;
}

/**
 * Gemini REST adapter for the provider-neutral LLM seam.
 *
 * The gateway consumes a stream, but each Turtle mode currently needs a complete
 * JSON contract before it can safely speak or persist anything. Gemini therefore
 * returns one complete JSON chunk through the common stream interface.
 */
export const createGeminiChatStream: ChatStreamFactory = (opts) => {
  return (async function* (): AsyncIterable<LlmStreamChunk> {
    const system = opts.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');
    const contents = opts.messages
      .filter((message) => message.role !== 'system')
      .map(toGeminiContent);

    if (contents.length === 0) throw new Error('Gemini needs at least one non-system message');

    const model = opts.model.replace(/^models\//, '');
    const url = `${GEMINI_HOST}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(opts.apiKey)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: opts.signal,
      body: JSON.stringify({
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents,
        generationConfig: {
          // Existing mode runners validate this contract before anything is sent to
          // the browser. Asking Gemini for JSON avoids markdown wrappers and prose.
          responseMimeType: 'application/json',
          temperature: 0.3,
          maxOutputTokens: 512,
        },
      }),
    });

    if (!res.ok) throw new Error(`Gemini generateContent failed: ${res.status}`);
    const json = (await res.json()) as GeminiResponse;
    const text = json.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? '')
      .join('')
      .trim();
    if (!text) throw new Error('Gemini returned no text candidate');

    yield { text, done: true };
  })();
};

function toGeminiContent(message: LlmMessage): { role: 'user' | 'model'; parts: Array<{ text: string }> } {
  return {
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: message.content }],
  };
}
