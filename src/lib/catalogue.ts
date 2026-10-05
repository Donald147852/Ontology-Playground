import type { DataBinding, Ontology } from '../data/ontology';
import type {
  Catalogue,
  CatalogueEntry,
  CatalogueEntryPayload,
  LoadedCatalogueEntry,
} from '../types/catalogue';

export class CatalogueLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogueLoadError';
  }
}

const indexRequests = new Map<string, Promise<Catalogue>>();
const entryRequests = new Map<string, Promise<LoadedCatalogueEntry>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every((item) => typeof item === 'string');
}

function optionalString(
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new CatalogueLoadError(`Catalogue entry has invalid ${field}`);
  }
  return value;
}

function parseCatalogueEntry(value: unknown): CatalogueEntry {
  if (!isRecord(value)) {
    throw new CatalogueLoadError('Catalogue contains an invalid entry');
  }

  const source = value.source;
  if (
    source !== 'official'
    && source !== 'community'
    && source !== 'external'
  ) {
    throw new CatalogueLoadError('Catalogue entry has invalid source');
  }

  const requiredStrings = [
    'id',
    'name',
    'description',
    'category',
    'author',
    'payloadUrl',
    'payloadHash',
  ] as const;
  for (const field of requiredStrings) {
    if (typeof value[field] !== 'string' || value[field].length === 0) {
      throw new CatalogueLoadError(
        `Catalogue entry has invalid ${field}`,
      );
    }
  }

  if (
    !Number.isInteger(value.entityCount)
    || (value.entityCount as number) < 0
    || !Number.isInteger(value.relationshipCount)
    || (value.relationshipCount as number) < 0
  ) {
    throw new CatalogueLoadError('Catalogue entry has invalid graph counts');
  }
  if (!isStringArray(value.tags)) {
    throw new CatalogueLoadError('Catalogue entry has invalid tags');
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(value.payloadHash as string)) {
    throw new CatalogueLoadError('Catalogue entry has invalid payload hash');
  }

  return {
    id: value.id as string,
    name: value.name as string,
    description: value.description as string,
    icon: optionalString(value.icon, 'icon'),
    category: value.category as string,
    tags: value.tags,
    author: value.author as string,
    source,
    entityCount: value.entityCount as number,
    relationshipCount: value.relationshipCount as number,
    payloadUrl: value.payloadUrl as string,
    payloadHash: value.payloadHash as string,
    license: optionalString(value.license, 'license'),
    sourceUrl: optionalString(value.sourceUrl, 'sourceUrl'),
    version: optionalString(value.version, 'version'),
  };
}

function parseCatalogue(value: unknown): Catalogue {
  if (!isRecord(value) || value.schemaVersion !== 2) {
    throw new CatalogueLoadError('Unsupported or malformed catalogue index');
  }
  if (
    typeof value.generatedAt !== 'string'
    || !Number.isInteger(value.count)
    || !Array.isArray(value.entries)
  ) {
    throw new CatalogueLoadError('Malformed catalogue index');
  }

  const entries = value.entries.map(parseCatalogueEntry);
  if (value.count !== entries.length) {
    throw new CatalogueLoadError('Catalogue entry count does not match index');
  }

  return {
    schemaVersion: 2,
    generatedAt: value.generatedAt,
    count: value.count as number,
    entries,
  };
}

function isOntology(value: unknown): value is Ontology {
  return isRecord(value)
    && typeof value.name === 'string'
    && typeof value.description === 'string'
    && Array.isArray(value.entityTypes)
    && Array.isArray(value.relationships);
}

function isDataBinding(value: unknown): value is DataBinding {
  if (
    !isRecord(value)
    || typeof value.entityTypeId !== 'string'
    || typeof value.source !== 'string'
    || typeof value.table !== 'string'
    || !isRecord(value.columnMappings)
  ) {
    return false;
  }

  return Object.values(value.columnMappings)
    .every((column) => typeof column === 'string');
}

function parsePayload(
  value: unknown,
  expectedId: string,
): CatalogueEntryPayload {
  if (
    !isRecord(value)
    || value.schemaVersion !== 1
    || value.id !== expectedId
    || !isOntology(value.ontology)
    || !Array.isArray(value.bindings)
    || !value.bindings.every(isDataBinding)
  ) {
    throw new CatalogueLoadError(
      `Malformed catalogue payload for "${expectedId}"`,
    );
  }

  return {
    schemaVersion: 1,
    id: expectedId,
    ontology: value.ontology,
    bindings: value.bindings,
  };
}

function documentBaseUrl(): string {
  return typeof document === 'undefined'
    ? 'http://localhost/'
    : document.baseURI;
}

export function getCatalogueIndexUrl(
  baseUrl: string = import.meta.env.BASE_URL,
): string {
  const absoluteBase = new URL(baseUrl || '/', documentBaseUrl()).href;
  const directoryBase = absoluteBase.endsWith('/')
    ? absoluteBase
    : `${absoluteBase}/`;
  return new URL('catalogue.json', directoryBase).href;
}

async function fetchCatalogueIndex(indexUrl: string): Promise<Catalogue> {
  let response: Response;
  try {
    response = await fetch(indexUrl);
  } catch (error) {
    throw new CatalogueLoadError(
      `Failed to load catalogue: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (!response.ok) {
    throw new CatalogueLoadError(
      `Failed to load catalogue (${response.status})`,
    );
  }

  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new CatalogueLoadError('Catalogue index is not valid JSON');
  }
  return parseCatalogue(value);
}

export function loadCatalogueIndex(
  baseUrl: string = import.meta.env.BASE_URL,
): Promise<Catalogue> {
  const indexUrl = getCatalogueIndexUrl(baseUrl);
  const cached = indexRequests.get(indexUrl);
  if (cached) return cached;

  const request = fetchCatalogueIndex(indexUrl).catch((error) => {
    indexRequests.delete(indexUrl);
    throw error;
  });
  indexRequests.set(indexUrl, request);
  return request;
}

async function hashPayload(content: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new CatalogueLoadError(
      'This browser cannot verify catalogue payload integrity',
    );
  }

  let digest: ArrayBuffer;
  try {
    digest = await globalThis.crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(content),
    );
  } catch {
    throw new CatalogueLoadError(
      'This browser could not verify catalogue payload integrity',
    );
  }
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `sha256:${hex}`;
}

async function fetchCatalogueEntry(
  entry: CatalogueEntry,
  indexUrl: string,
): Promise<LoadedCatalogueEntry> {
  const payloadUrl = new URL(entry.payloadUrl, indexUrl);
  const parsedIndexUrl = new URL(indexUrl);
  if (payloadUrl.origin !== parsedIndexUrl.origin) {
    throw new CatalogueLoadError(
      `Catalogue payload for "${entry.id}" must use the catalogue origin`,
    );
  }

  let response: Response;
  try {
    response = await fetch(payloadUrl);
  } catch (error) {
    throw new CatalogueLoadError(
      `Failed to load ontology "${entry.id}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (!response.ok) {
    throw new CatalogueLoadError(
      `Failed to load ontology "${entry.id}" (${response.status})`,
    );
  }

  let content: string;
  try {
    content = await response.text();
  } catch {
    throw new CatalogueLoadError(
      `Catalogue payload for "${entry.id}" could not be read`,
    );
  }
  if (await hashPayload(content) !== entry.payloadHash) {
    throw new CatalogueLoadError(
      `Catalogue payload integrity check failed for "${entry.id}"`,
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new CatalogueLoadError(
      `Catalogue payload for "${entry.id}" is not valid JSON`,
    );
  }

  const payload = parsePayload(value, entry.id);
  return {
    ...entry,
    ontology: payload.ontology,
    bindings: payload.bindings,
  };
}

export async function loadCatalogueEntry(
  id: string,
  baseUrl: string = import.meta.env.BASE_URL,
): Promise<LoadedCatalogueEntry> {
  const indexUrl = getCatalogueIndexUrl(baseUrl);
  const cacheKey = `${indexUrl}#${id}`;
  const cached = entryRequests.get(cacheKey);
  if (cached) return cached;

  const request = loadCatalogueIndex(baseUrl)
    .then((catalogue) => {
      const entry = catalogue.entries.find((candidate) => candidate.id === id);
      if (!entry) {
        throw new CatalogueLoadError(
          `Ontology "${id}" not found in catalogue`,
        );
      }
      return fetchCatalogueEntry(entry, indexUrl);
    })
    .catch((error) => {
      entryRequests.delete(cacheKey);
      throw error;
    });

  entryRequests.set(cacheKey, request);
  return request;
}

export function clearCatalogueCache(): void {
  indexRequests.clear();
  entryRequests.clear();
}
