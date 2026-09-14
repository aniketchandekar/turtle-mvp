import { describe, expect, it, vi } from 'vitest';
import {
  createGeminiResourceSearch,
  extractTrustedResources,
  isTrustedResourceUrl,
  type FetchLike,
} from './gemini-grounding.js';

describe('Gemini trusted resource search', () => {
  it('keeps only approved, cited HTTPS sources and de-duplicates them', () => {
    const links = extractTrustedResources({
      steps: [
        {
          type: 'model_output',
          content: [
            {
              annotations: [
                { type: 'url_citation', title: 'NCI caregiver support', url: 'https://www.cancer.gov/caregiver#top' },
                { type: 'url_citation', title: 'Duplicate', url: 'https://www.cancer.gov/caregiver#again' },
                { type: 'url_citation', title: 'Untrusted', url: 'https://example.com/advice' },
                { type: 'url_citation', title: 'CancerCare', url: 'https://www.cancercare.org/support' },
              ],
            },
          ],
        },
      ],
    });
    expect(links).toEqual([
      { title: 'NCI caregiver support', url: 'https://www.cancer.gov/caregiver' },
      { title: 'CancerCare', url: 'https://www.cancercare.org/support' },
    ]);
  });

  it('uses Gemini Search grounding server-side and does not return untrusted citations', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          steps: [
            {
              type: 'model_output',
              content: [
                {
                  annotations: [
                    { type: 'url_citation', title: 'American Cancer Society', url: 'https://www.cancer.org/caregivers' },
                    { type: 'url_citation', title: 'Nope', url: 'https://untrusted.example.org' },
                  ],
                },
              ],
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const search = createGeminiResourceSearch(
      { webSearch: { apiKey: 'secret', model: 'gemini-test' } },
      fetchMock as unknown as FetchLike,
    );

    await expect(search.search('Find caregiver support')).resolves.toEqual([
      { title: 'American Cancer Society', url: 'https://www.cancer.org/caregivers' },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/v1beta/interactions'),
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-goog-api-key': 'secret' }),
        body: expect.stringContaining('google_search'),
      }),
    );
  });

  it('accepts only the MVP trusted-source policy', () => {
    expect(isTrustedResourceUrl('https://supportorgs.cancer.gov/home')).toBe(true);
    expect(isTrustedResourceUrl('https://www.211.org/help')).toBe(true);
    expect(isTrustedResourceUrl('http://www.cancer.org')).toBe(false);
    expect(isTrustedResourceUrl('https://example.com/cancer')).toBe(false);
  });
});
