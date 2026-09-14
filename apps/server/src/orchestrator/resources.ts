import { modeOutputSchema, type ModeOutput } from '@turtle/shared';
import type { ResourceSearchService } from '../services/resources/gemini-grounding.js';

export interface ResourceRequest {
  topic: string;
  local: boolean;
}

export interface ResourceRunResult {
  output: ModeOutput;
  pending: ResourceRequest | null;
}

/**
 * Build a privacy-minimized web query from an explicit request. The raw utterance
 * never leaves the server; only the resource topic and one temporary city/ZIP do.
 */
export async function runResources(
  userText: string,
  search: ResourceSearchService | undefined,
  pending: ResourceRequest | null = null,
): Promise<ResourceRunResult> {
  const location = locationFromText(userText) ?? (pending ? standaloneLocation(userText) : null);
  const request = pending ?? requestFromText(userText);
  if (!request) return unavailableResult();

  if (request.local && !location) {
    return {
      output: modeOutputSchema.parse({
        say: 'I can look for trusted local help. What city or ZIP code should I use? I will use it only for this search.',
        cards: [],
        memory_ops: [],
        flags: ['none'],
      }),
      pending: request,
    };
  }

  if (!search?.live) return unavailableResult();

  try {
    const query = buildSearchQuery(request, location);
    const links = await search.search(query);
    if (links.length === 0) return unavailableResult();
    return {
      output: modeOutputSchema.parse({
        say: 'I found a few trusted resources and added them to the card below.',
        cards: [
          {
            type: 'actionable',
            title: 'Trusted caregiver resources',
            body: location
              ? `Trusted resources for ${location}. These are references, not medical advice.`
              : 'Trusted caregiver references. These are not a replacement for the care team.',
            links,
          },
        ],
        memory_ops: [],
        flags: ['none'],
      }),
      pending: null,
    };
  } catch {
    return unavailableResult();
  }
}

export function requestFromText(value: string): ResourceRequest | null {
  const lower = value.toLowerCase();
  const topic =
    /financial|cost|copay|bill/.test(lower)
      ? 'financial assistance for cancer caregivers'
      : /transport|ride|travel|lodging|hotel/.test(lower)
        ? 'transportation and lodging help for cancer caregivers'
        : /respite/.test(lower)
          ? 'respite care for cancer caregivers'
          : /support group|caregiver support|counsel|talk to someone/.test(lower)
            ? 'caregiver support groups and counseling for cancer caregivers'
            : /resource|help/.test(lower)
              ? 'caregiver support resources for metastatic cancer'
              : null;
  if (!topic) return null;
  return {
    topic,
    local: /near me|nearby|local|in my area|around here/.test(lower),
  };
}

export function locationFromText(value: string): string | null {
  const zip = value.match(/\b\d{5}(?:-\d{4})?\b/)?.[0];
  if (zip) return zip;
  const city = value.match(/\b(?:in|near|around)\s+([a-z]+(?:[ -][a-z]+){0,2})\b/i)?.[1];
  if (!city || /^(my area|here|me)$/i.test(city)) return null;
  return city.replace(/\s+/g, ' ').trim();
}

function standaloneLocation(value: string): string | null {
  const cleaned = value.replace(/[^a-z0-9,\s-]/gi, '').replace(/\s+/g, ' ').trim();
  if (!/^[a-z]+(?:[ ,'-]+[a-z]+){0,3}$/i.test(cleaned)) return null;
  return cleaned;
}

function buildSearchQuery(request: ResourceRequest, location: string | null): string {
  return `Find ${request.topic} in the United States${location ? ` near ${location}` : ''}.`;
}

function unavailableResult(): ResourceRunResult {
  return {
    output: modeOutputSchema.parse({
      say: 'I could not find a trusted resource right now. Your oncology social worker or care team can help connect you with local support.',
      cards: [],
      memory_ops: [],
      flags: ['none'],
    }),
    pending: null,
  };
}
