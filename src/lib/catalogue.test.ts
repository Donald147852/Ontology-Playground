import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Catalogue, CatalogueEntryPayload } from '../types/catalogue';
import {
  CatalogueLoadError,
  clearCatalogueCache,
  loadCatalogueEntry,
  loadCatalogueIndex,
} from './catalogue';

const payload: CatalogueEntryPayload = {
  schemaVersion: 1,
  id: 'official/test',
  ontology: {
    name: 'Test Ontology',
    description: 'Test description',
    entityTypes: [],
    relationships: [],
  },
  bindings: [],
};

function payloadContent(value: unknown = payload): string {
  return JSON.stringify(value, null, 2) + '\n';
}

function payloadHash(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function createCatalogue(content = payloadContent()): Catalogue {
  const hash = payloadHash(content);
  return {
    schemaVersion: 2,
    generatedAt: '2026-01-01T00:00:00.000Z',
    count: 1,
    entries: [{
      id: 'official/test',
      name: 'Test Ontology',
      description: 'Test description',
      category: 'general',
      tags: ['test'],
      author: 'test-author',
      source: 'official',
      entityCount: 0,
      relationshipCount: 0,
      payloadUrl:
        `catalogue-payloads/official/test/${hash.slice('sha256:'.length)}.json`,
      payloadHash: hash,
    }],
  };
}

function response(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  clearCatalogueCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('catalogue loader', () => {
  it('loads only the lightweight index when browsing the catalogue', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      response(JSON.stringify(createCatalogue())),
    );

    const catalogue = await loadCatalogueIndex('/playground/');

    expect(catalogue.entries[0]).not.toHaveProperty('ontology');
    expect(catalogue.entries[0]).not.toHaveProperty('bindings');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0].toString()).toMatch(
      /\/playground\/catalogue\.json$/,
    );
  });

  it('treats a base URL without a trailing slash as a directory', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      response(JSON.stringify(createCatalogue())),
    );

    await loadCatalogueIndex('/published-catalogue');

    expect(fetchMock.mock.calls[0][0].toString()).toMatch(
      /\/published-catalogue\/catalogue\.json$/,
    );
  });

  it('loads only the requested entry payload', async () => {
    const content = payloadContent();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (input) => input.toString().endsWith('/catalogue.json')
        ? response(JSON.stringify(createCatalogue(content)))
        : response(content),
    );

    const loaded = await loadCatalogueEntry('official/test', '/playground/');

    expect(loaded.ontology.name).toBe('Test Ontology');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0].toString()).toContain(
      '/catalogue-payloads/official/test/',
    );
  });

  it('deduplicates concurrent requests and caches successful entries', async () => {
    const content = payloadContent();
    let indexRequests = 0;
    let payloadRequests = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (input) => {
        if (input.toString().endsWith('/catalogue.json')) {
          indexRequests++;
          return response(JSON.stringify(createCatalogue(content)));
        }
        payloadRequests++;
        return response(content);
      },
    );

    const [first, second] = await Promise.all([
      loadCatalogueEntry('official/test', '/playground/'),
      loadCatalogueEntry('official/test', '/playground/'),
    ]);
    const third = await loadCatalogueEntry('official/test', '/playground/');

    expect(first).toBe(second);
    expect(second).toBe(third);
    expect(indexRequests).toBe(1);
    expect(payloadRequests).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports a missing payload and allows a later retry', async () => {
    const content = payloadContent();
    let payloadRequests = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (input.toString().endsWith('/catalogue.json')) {
        return response(JSON.stringify(createCatalogue(content)));
      }
      payloadRequests++;
      return response('not found', 404);
    });

    await expect(
      loadCatalogueEntry('official/test', '/playground/'),
    ).rejects.toThrow('Failed to load ontology "official/test" (404)');
    await expect(
      loadCatalogueEntry('official/test', '/playground/'),
    ).rejects.toThrow(CatalogueLoadError);

    expect(payloadRequests).toBe(2);
  });

  it('reports an index failure and allows a later retry', async () => {
    let indexRequests = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      indexRequests++;
      return indexRequests === 1
        ? response('unavailable', 503)
        : response(JSON.stringify(createCatalogue()));
    });

    await expect(loadCatalogueIndex('/playground/')).rejects.toThrow(
      'Failed to load catalogue (503)',
    );
    await expect(loadCatalogueIndex('/playground/')).resolves.toMatchObject({
      count: 1,
    });
    expect(indexRequests).toBe(2);
  });

  it('rejects malformed payload JSON after verifying its hash', async () => {
    const content = '{not-json';
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (input) => input.toString().endsWith('/catalogue.json')
        ? response(JSON.stringify(createCatalogue(content)))
        : response(content),
    );

    await expect(
      loadCatalogueEntry('official/test', '/playground/'),
    ).rejects.toThrow(
      'Catalogue payload for "official/test" is not valid JSON',
    );
  });

  it('rejects a payload with malformed ontology structures', async () => {
    const content = payloadContent({
      ...payload,
      ontology: {
        ...payload.ontology,
        entityTypes: [{
          id: 42,
          name: 'Invalid ID',
          description: '',
          properties: [],
          icon: 'I',
          color: '#000000',
        }],
      },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (input) => input.toString().endsWith('/catalogue.json')
        ? response(JSON.stringify(createCatalogue(content)))
        : response(content),
    );

    await expect(
      loadCatalogueEntry('official/test', '/playground/'),
    ).rejects.toThrow(
      'Malformed catalogue payload for "official/test": entityTypes[0].id must be a string.',
    );
  });

  it('rejects payload counts that do not match the index', async () => {
    const content = payloadContent();
    const catalogue = createCatalogue(content);
    catalogue.entries[0].entityCount = 1;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (input) => input.toString().endsWith('/catalogue.json')
        ? response(JSON.stringify(catalogue))
        : response(content),
    );

    await expect(
      loadCatalogueEntry('official/test', '/playground/'),
    ).rejects.toThrow(
      'Catalogue payload counts do not match the index for "official/test"',
    );
  });

  it('rejects a payload whose content does not match the index hash', async () => {
    const expectedContent = payloadContent();
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (input) => input.toString().endsWith('/catalogue.json')
        ? response(JSON.stringify(createCatalogue(expectedContent)))
        : response(payloadContent({ ...payload, id: 'official/tampered' })),
    );

    await expect(
      loadCatalogueEntry('official/test', '/playground/'),
    ).rejects.toThrow(
      'Catalogue payload integrity check failed for "official/test"',
    );
  });

  it('does not request a payload for an unknown catalogue ID', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      response(JSON.stringify(createCatalogue())),
    );

    await expect(
      loadCatalogueEntry('official/missing', '/playground/'),
    ).rejects.toThrow(
      'Ontology "official/missing" not found in catalogue',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects payload URLs that are not content-addressed for their entry', async () => {
    const catalogue = createCatalogue();
    catalogue.entries[0].payloadUrl =
      'catalogue-payloads/official/test/not-the-payload-hash.json';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      response(JSON.stringify(catalogue)),
    );

    await expect(loadCatalogueIndex('/playground/')).rejects.toThrow(
      'Catalogue entry has invalid payload URL',
    );
  });

  it('rejects duplicate entry IDs in the catalogue index', async () => {
    const catalogue = createCatalogue();
    catalogue.entries.push({ ...catalogue.entries[0] });
    catalogue.count = catalogue.entries.length;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      response(JSON.stringify(catalogue)),
    );

    await expect(loadCatalogueIndex('/playground/')).rejects.toThrow(
      'Catalogue index contains duplicate entry IDs',
    );
  });

  it('rejects malformed catalogue indexes explicitly', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      response(JSON.stringify({ entries: [] })),
    );

    await expect(loadCatalogueIndex('/playground/')).rejects.toThrow(
      'Unsupported or malformed catalogue index',
    );
  });
});
