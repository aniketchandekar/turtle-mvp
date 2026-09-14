import type { Config } from '../../config.js';

const GEMINI_INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';

export interface TrustedResource {
  title: string;
  url: string;
}

export interface ResourceSearchService {
  readonly live: boolean;
  search(query: string): Promise<TrustedResource[]>;
}

export type FetchLike = typeof fetch;

interface GroundingResponse {
  steps?: Array<{
    type?: string;
    content?: Array<{
      type?: string;
      text?: string;
      annotations?: Array<{ type?: string; title?: string; url?: string }>;
    }>;
  }>;
}

/**
 * Gemini Google Search grounding adapter. It intentionally returns only trusted,
 * cited links—not model prose—so Turtle never turns unverified web material into
 * medical guidance. The raw caregiver message is not sent: callers build a minimal,
 * purpose-specific query before reaching this boundary.
 */
export function createGeminiResourceSearch(
  cfg: Pick<Config, 'webSearch'>,
  fetchImpl: FetchLike = fetch,
): ResourceSearchService {
  const { apiKey, model } = cfg.webSearch;
  return {
    live: Boolean(apiKey),
    async search(query: string): Promise<TrustedResource[]> {
      if (!apiKey) return [];
      const res = await fetchImpl(GEMINI_INTERACTIONS_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          model,
          input:
            `${query}\n\nPrioritize official U.S. cancer and caregiver organizations. ` +
            'Provide source citations for every recommendation. Do not provide medical, treatment, dosing, prognosis, or emergency-triage advice.',
          tools: [{ type: 'google_search' }],
        }),
      });
      if (!res.ok) throw new Error(`Gemini web search failed: ${res.status}`);
      return extractTrustedResources((await res.json()) as GroundingResponse);
    },
  };
}

/** Pull, de-duplicate, and policy-filter citations returned from Gemini grounding. */
export function extractTrustedResources(response: GroundingResponse): TrustedResource[] {
  const results: TrustedResource[] = [];
  const seen = new Set<string>();
  for (const step of response.steps ?? []) {
    if (step.type !== 'model_output') continue;
    for (const content of step.content ?? []) {
      for (const annotation of content.annotations ?? []) {
        if (annotation.type !== 'url_citation' || !annotation.url || !isTrustedResourceUrl(annotation.url)) continue;
        const normalized = normalizeUrl(annotation.url);
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        results.push({
          title: cleanTitle(annotation.title, normalized),
          url: normalized,
        });
        if (results.length === 3) return results;
      }
    }
  }
  return results;
}

/** The MVP's approved US caregiver-resource source policy. */
export function isTrustedResourceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    return (
      host === 'cancer.gov' ||
      host.endsWith('.cancer.gov') ||
      host === 'cancer.org' ||
      host.endsWith('.cancer.org') ||
      host === 'cancercare.org' ||
      host.endsWith('.cancercare.org') ||
      host === '211.org' ||
      host.endsWith('.211.org') ||
      host.endsWith('.gov') ||
      host === 'mdanderson.org' ||
      host.endsWith('.mdanderson.org') ||
      host === 'mskcc.org' ||
      host.endsWith('.mskcc.org') ||
      host === 'dana-farber.org' ||
      host.endsWith('.dana-farber.org')
    );
  } catch {
    return false;
  }
}

function normalizeUrl(value: string): string | null {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function cleanTitle(value: string | undefined, url: string): string {
  const fallback = new URL(url).hostname.replace(/^www\./, '');
  const title = value?.replace(/\s+/g, ' ').trim();
  return title && title.length <= 120 ? title : fallback;
}
