import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CataloguePayloadManifest } from '../src/types/catalogue';
import { restoreCataloguePayloads } from './restore-catalogue-payloads';

const temporaryDirectories: string[] = [];

function createOutputDirectory(): string {
  const directory = mkdtempSync(
    join(tmpdir(), 'ontology-payload-restore-test-'),
  );
  temporaryDirectories.push(directory);
  return directory;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('published catalogue payload restoration', () => {
  it('restores verified payload history into a clean output directory', async () => {
    const content = '{"schemaVersion":1,"id":"official/previous"}\n';
    const hash = createHash('sha256').update(content).digest('hex');
    const payloadUrl = `catalogue-payloads/official/previous/${hash}.json`;
    const manifest: CataloguePayloadManifest = {
      schemaVersion: 1,
      payloads: [{
        payloadUrl,
        payloadHash: `sha256:${hash}`,
      }],
    };
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = input.toString();
      if (url.endsWith('/catalogue.json')) {
        return jsonResponse({
          schemaVersion: 2,
          entries: manifest.payloads,
        });
      }
      if (url.endsWith('/catalogue-payloads-manifest.json')) {
        return jsonResponse(manifest);
      }
      if (url.endsWith(payloadUrl)) {
        return new Response(content, { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });
    const outputDirectory = createOutputDirectory();

    await expect(restoreCataloguePayloads(
      'https://example.com/playground/',
      outputDirectory,
      fetchMock,
    )).resolves.toBe(1);

    const restoredPath = join(outputDirectory, payloadUrl);
    expect(readFileSync(restoredPath, 'utf-8')).toBe(content);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await restoreCataloguePayloads(
      'https://example.com/playground/',
      outputDirectory,
      fetchMock,
    );
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('rejects schema-v2 deployments without a complete payload manifest', async () => {
    const fetchMock = vi.fn(async (input: string | URL) =>
      input.toString().endsWith('/catalogue.json')
        ? jsonResponse({ schemaVersion: 2, entries: [] })
        : new Response('not found', { status: 404 }));

    await expect(restoreCataloguePayloads(
      'https://example.com/playground/',
      createOutputDirectory(),
      fetchMock,
    )).rejects.toThrow(
      'Could not read the published payload manifest (404)',
    );
  });

  it('starts fresh when the deployed catalogue predates lazy payloads', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([]));
    const outputDirectory = createOutputDirectory();

    await expect(restoreCataloguePayloads(
      'https://example.com/playground/',
      outputDirectory,
      fetchMock,
    )).resolves.toBe(0);
    expect(existsSync(join(
      outputDirectory,
      'catalogue-payloads',
    ))).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
