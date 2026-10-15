import type { DataBinding } from '../data/ontology';
import type {
  Catalogue,
  CatalogueEntry,
  CatalogueEntryPayload,
  LoadedCatalogueEntry,
} from '../types/catalogue';
import { isValidCatalogueId } from './catalogueId';
import { parseOntologyValue } from './ontologySchema';

export class CatalogueLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogueLoadError';
  }
}

const indexRequests = new Map<string, Promise<Catalogue>>();
const indexRefreshRequests = new Map<string, Promise<Catalogue>>();
const entryRequests = new Map<string, Promise<LoadedCatalogueEntry>>();

class StaleCataloguePayloadError extends CatalogueLoadError {}

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
  if (!isValidCatalogueId(value.id as string)) {
    throw new CatalogueLoadError('Catalogue entry has invalid id');
  }

  const payloadHash = value.payloadHash as string;
  const expectedPayloadUrl =
    `catalogue-payloads/${value.id}/${payloadHash.slice('sha256:'.length)}.json`;
  if (value.payloadUrl !== expectedPayloadUrl) {
    throw new CatalogueLoadError('Catalogue entry has invalid payload URL');
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
    payloadHash,
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
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
    throw new CatalogueLoadError('Catalogue index contains duplicate entry IDs');
  }

  return {
    schemaVersion: 2,
    generatedAt: value.generatedAt,
    count: value.count as number,
    entries,
  };
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
    || !Array.isArray(value.bindings)
    || !value.bindings.every(isDataBinding)
  ) {
    throw new CatalogueLoadError(
      `Malformed catalogue payload for "${expectedId}"`,
    );
  }

  const parsedOntology = parseOntologyValue(value.ontology);
  if (!parsedOntology.ontology) {
    const firstIssue = parsedOntology.issues[0]?.message;
    throw new CatalogueLoadError(
      `Malformed catalogue payload for "${expectedId}"${
        firstIssue ? `: ${firstIssue}` : ''
      }`,
    );
  }

  return {
    schemaVersion: 1,
    id: expectedId,
    ontology: parsedOntology.ontology,
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

async function fetchCatalogueIndex(
  indexUrl: string,
  bypassBrowserCache = false,
): Promise<Catalogue> {
  let response: Response;
  try {
    response = bypassBrowserCache
      ? await fetch(indexUrl, { cache: 'no-store' })
      : await fetch(indexUrl);
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

function requestCatalogueIndex(
  indexUrl: string,
  bypassBrowserCache = false,
): Promise<Catalogue> {
  const request: Promise<Catalogue> = fetchCatalogueIndex(
    indexUrl,
    bypassBrowserCache,
  )
    .catch((error) => {
      if (indexRequests.get(indexUrl) === request) {
        indexRequests.delete(indexUrl);
      }
      throw error;
    });
  indexRequests.set(indexUrl, request);
  return request;
}

export function loadCatalogueIndex(
  baseUrl: string = import.meta.env.BASE_URL,
): Promise<Catalogue> {
  const indexUrl = getCatalogueIndexUrl(baseUrl);
  const cached = indexRequests.get(indexUrl);
  if (cached) return cached;

  return requestCatalogueIndex(indexUrl);
}

function refreshCatalogueIndex(indexUrl: string): Promise<Catalogue> {
  const activeRefresh = indexRefreshRequests.get(indexUrl);
  if (activeRefresh) return activeRefresh;

  const request = requestCatalogueIndex(indexUrl, true);
  indexRefreshRequests.set(indexUrl, request);
  const clearRefresh = () => {
    if (indexRefreshRequests.get(indexUrl) === request) {
      indexRefreshRequests.delete(indexUrl);
    }
  };
  request.then(clearRefresh, clearRefresh);
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
    const ErrorType = response.status === 404 || response.status === 410
      ? StaleCataloguePayloadError
      : CatalogueLoadError;
    throw new ErrorType(
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
    throw new StaleCataloguePayloadError(
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
  if (
    payload.ontology.entityTypes.length !== entry.entityCount
    || payload.ontology.relationships.length !== entry.relationshipCount
  ) {
    throw new CatalogueLoadError(
      `Catalogue payload counts do not match the index for "${entry.id}"`,
    );
  }
  return {
    ...entry,
    ontology: payload.ontology,
    bindings: payload.bindings,
  };
}

function findCatalogueEntry(
  catalogue: Catalogue,
  id: string,
): CatalogueEntry | undefined {
  return catalogue.entries.find((candidate) => candidate.id === id);
}

async function loadCatalogueEntryUncached(
  id: string,
  baseUrl: string,
  indexUrl: string,
): Promise<LoadedCatalogueEntry> {
  let catalogue = await loadCatalogueIndex(baseUrl);
  let entry = findCatalogueEntry(catalogue, id);

  if (!entry) {
    catalogue = await refreshCatalogueIndex(indexUrl);
    entry = findCatalogueEntry(catalogue, id);
    if (!entry) {
      throw new CatalogueLoadError(
        `Ontology "${id}" not found in catalogue`,
      );
    }
  }

  try {
    return await fetchCatalogueEntry(entry, indexUrl);
  } catch (error) {
    if (!(error instanceof StaleCataloguePayloadError)) throw error;

    const refreshedCatalogue = await refreshCatalogueIndex(indexUrl);
    const refreshedEntry = findCatalogueEntry(refreshedCatalogue, id);
    if (
      !refreshedEntry
      || (
        refreshedEntry.payloadHash === entry.payloadHash
        && refreshedEntry.payloadUrl === entry.payloadUrl
      )
    ) {
      throw error;
    }
    return fetchCatalogueEntry(refreshedEntry, indexUrl);
  }
}

export async function loadCatalogueEntry(
  id: string,
  baseUrl: string = import.meta.env.BASE_URL,
): Promise<LoadedCatalogueEntry> {
  const indexUrl = getCatalogueIndexUrl(baseUrl);
  const cacheKey = `${indexUrl}#${id}`;
  const cached = entryRequests.get(cacheKey);
  if (cached) return cached;

  const request = loadCatalogueEntryUncached(id, baseUrl, indexUrl)
    .catch((error) => {
      entryRequests.delete(cacheKey);
      throw error;
    });

  entryRequests.set(cacheKey, request);
  return request;
}

export function clearCatalogueCache(): void {
  indexRequests.clear();
  indexRefreshRequests.clear();
  entryRequests.clear();
}
