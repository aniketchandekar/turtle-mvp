import { describe, expect, it, vi } from 'vitest';
import { locationFromText, requestFromText, runResources } from './resources.js';

describe('trusted resource mode', () => {
  it('requests a city or ZIP for a local search without invoking the provider', async () => {
    const search = { live: true, search: vi.fn() };
    const result = await runResources('Find a caregiver support group near me', search);
    expect(result.pending).toMatchObject({ local: true });
    expect(result.output.say).toContain('city or ZIP');
    expect(search.search).not.toHaveBeenCalled();
  });

  it('uses a temporary location to return a single resource card with cited links', async () => {
    const search = {
      live: true,
      search: vi.fn(async () => [{ title: 'NCI caregiver support', url: 'https://www.cancer.gov/caregiver' }]),
    };
    const pending = requestFromText('Find caregiver support near me')!;
    const result = await runResources('Austin, Texas', search, pending);
    expect(result.pending).toBeNull();
    expect(search.search).toHaveBeenCalledWith(expect.stringContaining('Austin, Texas'));
    expect(result.output.cards).toHaveLength(1);
    expect(result.output.cards[0]?.links).toEqual([
      { title: 'NCI caregiver support', url: 'https://www.cancer.gov/caregiver' },
    ]);
  });

  it('does not build a search query from a raw non-resource message', () => {
    expect(requestFromText('My mom is Eleanor and she is having a hard day')).toBeNull();
    expect(locationFromText('near Austin')).toBe('Austin');
  });
});
