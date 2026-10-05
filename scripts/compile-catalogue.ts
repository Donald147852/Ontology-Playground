/**
 * Build-time catalogue compiler.
 *
 * Reads all catalogue/**\/*.rdf files, parses each via the RDF parser,
 * reads associated metadata.json, and emits a lightweight catalogue index
 * plus one content-addressed payload per ontology.
 *
 * Usage: npx tsx scripts/compile-catalogue.ts
 */
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { join, basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { parseRDF } from '../src/lib/rdf/parser.js';
import { serializeToRDF } from '../src/lib/rdf/serializer.js';
import { validateOntologyStyle } from './style-validator.js';
import type {
  CatalogueEntry,
  Catalogue,
  CatalogueEntryPayload,
} from '../src/types/catalogue.js';

// Provide DOMParser for the RDF parser (browser API not available in Node)
const dom = new JSDOM('');
globalThis.DOMParser = dom.window.DOMParser;

const ROOT = join(import.meta.dirname, '..');
const CATALOGUE_DIR = join(ROOT, 'catalogue');
const OUTPUT_PATH = join(ROOT, 'public', 'catalogue.json');
const CATALOGUE_TIERS = ['official', 'community', 'external'] as const;
const PAYLOAD_DIR = join(ROOT, 'public', 'catalogue-payloads');

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

interface CatalogueMetadata {
  name: string;
  description: string;
  icon?: string;
  category: string;
  tags?: string[];
  author?: string;
  license?: string;
  sourceUrl?: string;
  version?: string;
}

interface CataloguePathIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface DiscoveredOntologyFiles {
  directoryIdentity: CataloguePathIdentity;
  fileIdentities: Map<string, CataloguePathIdentity>;
  rdfFiles: string[];
}

export interface CatalogueCompilerDependencies {
  beforeFileOpen?: (path: string) => void;
}

interface CompiledPayload {
  relativePath: string;
  content: string;
}

interface CompiledCatalogue {
  catalogue: Catalogue;
  payloads: CompiledPayload[];
}

// ------------------------------------------------------------------
// Validation helpers
// ------------------------------------------------------------------

const REQUIRED_METADATA_FIELDS = ['name', 'description', 'category'] as const;
const VALID_CATEGORIES = ['retail', 'healthcare', 'finance', 'manufacturing', 'education', 'food', 'media', 'events', 'technology', 'general', 'iq-lab', 'school', 'fibo'];

function validateMetadata(
  meta: unknown,
  filePath: string,
  source: CatalogueEntry['source'],
): CatalogueMetadata {
  if (typeof meta !== 'object' || meta === null) {
    throw new Error(`${filePath}: metadata.json must be a JSON object`);
  }
  const obj = meta as Record<string, unknown>;
  for (const field of REQUIRED_METADATA_FIELDS) {
    if (typeof obj[field] !== 'string' || (obj[field] as string).length === 0) {
      throw new Error(`${filePath}: metadata.json missing required field "${field}"`);
    }
  }
  if (!VALID_CATEGORIES.includes(obj['category'] as string)) {
    throw new Error(
      `${filePath}: invalid category "${obj['category']}". Must be one of: ${VALID_CATEGORIES.join(', ')}`,
    );
  }
  for (const field of ['icon', 'author'] as const) {
    if (obj[field] !== undefined && typeof obj[field] !== 'string') {
      throw new Error(`${filePath}: metadata.json field "${field}" must be a string`);
    }
  }
  if (
    obj['tags'] !== undefined
    && (!Array.isArray(obj['tags']) || obj['tags'].some((tag) => typeof tag !== 'string'))
  ) {
    throw new Error(`${filePath}: metadata.json field "tags" must be an array of strings`);
  }
  for (const field of ['license', 'sourceUrl', 'version'] as const) {
    if (
      obj[field] !== undefined
      && (typeof obj[field] !== 'string' || obj[field].trim().length === 0)
    ) {
      throw new Error(`${filePath}: metadata.json field "${field}" must be a non-empty string`);
    }
  }
  if (source === 'external') {
    for (const field of ['license', 'sourceUrl'] as const) {
      if (typeof obj[field] !== 'string' || obj[field].trim().length === 0) {
        throw new Error(`${filePath}: external catalogue metadata requires "${field}"`);
      }
    }
  }
  if (typeof obj['sourceUrl'] === 'string') {
    try {
      const sourceUrl = new URL(obj['sourceUrl']);
      if (
        sourceUrl.protocol !== 'https:'
        || sourceUrl.username.length > 0
        || sourceUrl.password.length > 0
      ) {
        throw new Error('unsafe URL');
      }
    } catch {
      throw new Error(
        `${filePath}: metadata.json field "sourceUrl" must be an HTTPS URL without embedded credentials`,
      );
    }
  }
  return meta as CatalogueMetadata;
}

// ------------------------------------------------------------------
// Discover ontology directories
// ------------------------------------------------------------------

// Validate that a directory name is a safe slug (no traversal, no special chars)
const SAFE_SLUG_RE = /^[a-z0-9][a-z0-9\-_]*[a-z0-9]$|^[a-z0-9]$/;

export class CatalogueDiscoveryError extends Error {
  constructor(path: string, reason: string) {
    super(`${path}: ${reason}`);
    this.name = 'CatalogueDiscoveryError';
  }
}

function assertDiscoveryDirectory(path: string): Stats {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CatalogueDiscoveryError(path, 'directory does not exist');
    }
    throw error;
  }

  if (stat.isSymbolicLink()) {
    throw new CatalogueDiscoveryError(
      path,
      'symlinks are not allowed in the catalogue',
    );
  }
  if (!stat.isDirectory()) {
    throw new CatalogueDiscoveryError(path, 'expected a directory');
  }
  return stat;
}

function toPathIdentity(stat: Stats): CataloguePathIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function hasPathIdentity(
  stat: Stats,
  expected: CataloguePathIdentity,
): boolean {
  return stat.dev === expected.dev
    && stat.ino === expected.ino
    && stat.size === expected.size
    && stat.mtimeMs === expected.mtimeMs
    && stat.ctimeMs === expected.ctimeMs;
}

function assertDirectoryIdentity(
  path: string,
  expected: CataloguePathIdentity,
): void {
  const stat = assertDiscoveryDirectory(path);
  if (!hasPathIdentity(stat, expected)) {
    throw new CatalogueDiscoveryError(
      path,
      'filesystem entry changed during catalogue compilation',
    );
  }
}

function assertFileIdentity(
  path: string,
  expected: CataloguePathIdentity,
): Stats {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CatalogueDiscoveryError(
        path,
        'filesystem entry changed during catalogue compilation',
      );
    }
    throw error;
  }

  if (stat.isSymbolicLink()) {
    throw new CatalogueDiscoveryError(
      path,
      'symlinks are not allowed in the catalogue',
    );
  }
  if (!stat.isFile()) {
    throw new CatalogueDiscoveryError(path, 'expected a regular file');
  }
  if (!hasPathIdentity(stat, expected)) {
    throw new CatalogueDiscoveryError(
      path,
      'filesystem entry changed during catalogue compilation',
    );
  }
  return stat;
}

function validateCatalogueRoot(path: string): void {
  assertDiscoveryDirectory(path);
  const discoveredTiers = new Set<string>();

  for (const entry of readdirSync(path)) {
    const full = join(path, entry);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) {
      throw new CatalogueDiscoveryError(
        full,
        'symlinks are not allowed in the catalogue',
      );
    }
    if (stat.isFile()) continue;
    if (!stat.isDirectory()) {
      throw new CatalogueDiscoveryError(
        full,
        'unsupported filesystem entry; only directories and regular files are allowed',
      );
    }
    if (!(CATALOGUE_TIERS as readonly string[]).includes(entry)) {
      throw new CatalogueDiscoveryError(
        full,
        `unexpected catalogue root directory (expected only ${CATALOGUE_TIERS.join(', ')})`,
      );
    }
    discoveredTiers.add(entry);
  }

  for (const tier of CATALOGUE_TIERS) {
    if (!discoveredTiers.has(tier)) {
      throw new CatalogueDiscoveryError(
        join(path, tier),
        'required catalogue tier directory does not exist',
      );
    }
  }
}

export function discoverOntologyDirs(baseDir: string): string[] {
  const dirs: string[] = [];
  assertDiscoveryDirectory(baseDir);
  for (const entry of readdirSync(baseDir)) {
    const full = join(baseDir, entry);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) {
      throw new CatalogueDiscoveryError(
        full,
        'symlinks are not allowed in the catalogue',
      );
    }
    if (stat.isFile()) continue;
    if (!stat.isDirectory()) {
      throw new CatalogueDiscoveryError(
        full,
        'unsupported filesystem entry; only directories and regular files are allowed',
      );
    }
    if (!SAFE_SLUG_RE.test(entry)) {
      throw new CatalogueDiscoveryError(
        full,
        'directory name contains unsafe characters (only lowercase alphanumeric, hyphens, underscores allowed)',
      );
    }
    dirs.push(full);
  }
  return dirs;
}

function discoverOntologyFiles(directory: string): DiscoveredOntologyFiles {
  const directoryIdentity = toPathIdentity(
    assertDiscoveryDirectory(directory),
  );
  const fileIdentities = new Map<string, CataloguePathIdentity>();
  const rdfFiles: string[] = [];

  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) {
      throw new CatalogueDiscoveryError(
        full,
        'symlinks are not allowed in the catalogue',
      );
    }
    if (stat.isDirectory()) {
      throw new CatalogueDiscoveryError(
        full,
        'nested directories are not allowed inside an ontology entry',
      );
    }
    if (!stat.isFile()) {
      throw new CatalogueDiscoveryError(
        full,
        'unsupported filesystem entry; only regular files are allowed inside an ontology entry',
      );
    }
    fileIdentities.set(full, toPathIdentity(stat));
    if (entry.endsWith('.rdf') || entry.endsWith('.owl')) {
      rdfFiles.push(entry);
    }
  }

  return {
    directoryIdentity,
    fileIdentities,
    rdfFiles,
  };
}

function readRegularCatalogueFile(
  path: string,
  directory: string,
  expectedDirectory: CataloguePathIdentity,
  expectedFile: CataloguePathIdentity,
  dependencies: CatalogueCompilerDependencies,
): string {
  dependencies.beforeFileOpen?.(path);
  assertDirectoryIdentity(directory, expectedDirectory);
  assertFileIdentity(path, expectedFile);

  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new CatalogueDiscoveryError(
        path,
        'symlinks are not allowed in the catalogue',
      );
    }
    throw error;
  }

  try {
    const openedStat = fstatSync(descriptor);
    if (!openedStat.isFile() || !hasPathIdentity(openedStat, expectedFile)) {
      throw new CatalogueDiscoveryError(
        path,
        'filesystem entry changed during catalogue compilation',
      );
    }
    assertFileIdentity(path, expectedFile);
    assertDirectoryIdentity(directory, expectedDirectory);
    const content = readFileSync(descriptor, 'utf-8');
    if (!hasPathIdentity(fstatSync(descriptor), expectedFile)) {
      throw new CatalogueDiscoveryError(
        path,
        'filesystem entry changed during catalogue compilation',
      );
    }
    return content;
  } finally {
    closeSync(descriptor);
  }
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------

function compileCatalogueArtifacts(
  catalogueDir: string = CATALOGUE_DIR,
  dependencies: CatalogueCompilerDependencies = {},
): CompiledCatalogue {
  const entries: CatalogueEntry[] = [];
  const payloads: CompiledPayload[] = [];
  const seenIds = new Set<string>();
  let errors = 0;

  validateCatalogueRoot(catalogueDir);

  for (const tier of CATALOGUE_TIERS) {
    const tierDir = join(catalogueDir, tier);
    // For community and external, ontologies are nested one level deeper:
    // community/<user>/<slug>/  or  external/<source-name>/<slug>/
    const ontologyDirs: { dir: string; source: typeof tier }[] = [];

    if (tier === 'official') {
      for (const dir of discoverOntologyDirs(tierDir)) {
        ontologyDirs.push({ dir, source: tier });
      }
    } else {
      // community/<username>/<ontology-slug>/  or  external/<source>/<ontology-slug>/
      for (const userDir of discoverOntologyDirs(tierDir)) {
        for (const dir of discoverOntologyDirs(userDir)) {
          ontologyDirs.push({ dir, source: tier });
        }
      }
    }

    for (const { dir, source } of ontologyDirs) {
      const slug = basename(dir);
      const metadataPath = join(dir, 'metadata.json');
      const discoveredFiles = discoverOntologyFiles(dir);
      const { rdfFiles } = discoveredFiles;

      if (rdfFiles.length === 0) {
        console.error(`✘ ${dir}: no .rdf or .owl file found`);
        errors++;
        continue;
      }
      const metadataIdentity = discoveredFiles.fileIdentities.get(metadataPath);
      if (!metadataIdentity) {
        console.error(`✘ ${dir}: missing metadata.json`);
        errors++;
        continue;
      }

      // Parse metadata
      let metadata: CatalogueMetadata;
      try {
        const raw = JSON.parse(readRegularCatalogueFile(
          metadataPath,
          dir,
          discoveredFiles.directoryIdentity,
          metadataIdentity,
          dependencies,
        ));
        metadata = validateMetadata(raw, metadataPath, source);
      } catch (e) {
        if (e instanceof CatalogueDiscoveryError) throw e;
        console.error(`✘ ${metadataPath}: ${(e as Error).message}`);
        errors++;
        continue;
      }

      // Derive a stable ID from the filesystem path: <source>/<slug>
      // For community ontologies the path is deeper: community/<user>/<slug>
      const relPath = dir.slice(tierDir.length + 1).replace(/\\/g, '/'); // e.g. "cosmic-coffee" or "alice/my-ontology"
      const entryId = `${source}/${relPath}`;

      if (seenIds.has(entryId)) {
        console.error(`✘ ${dir}: duplicate catalogue path "${entryId}"`);
        errors++;
        continue;
      }

      // Parse RDF
      const rdfPath = join(dir, rdfFiles[0]);
      const rdfIdentity = discoveredFiles.fileIdentities.get(rdfPath);
      if (!rdfIdentity) {
        throw new CatalogueDiscoveryError(
          rdfPath,
          'filesystem entry changed during catalogue compilation',
        );
      }
      let ontology: Ontology;
      let bindings: DataBinding[];
      try {
        const rdfXml = readRegularCatalogueFile(
          rdfPath,
          dir,
          discoveredFiles.directoryIdentity,
          rdfIdentity,
          dependencies,
        );
        const parsed = parseRDF(rdfXml);
        ontology = parsed.ontology;
        bindings = parsed.bindings;
      } catch (e) {
        if (e instanceof CatalogueDiscoveryError) throw e;
        console.error(`✘ ${rdfPath}: ${(e as Error).message}`);
        errors++;
        continue;
      }

      // Round-trip check: serialize back and re-parse to verify fidelity
      try {
        const reserialized = serializeToRDF(ontology, bindings);
        parseRDF(reserialized);
      } catch (e) {
        console.error(`✘ ${rdfPath}: round-trip verification failed — ${(e as Error).message}`);
        errors++;
        continue;
      }

      // Style validation: check naming conventions and spelling
      const styleErrors = validateOntologyStyle(ontology);
      if (styleErrors.length > 0) {
        for (const styleError of styleErrors) {
          if (styleError.severity === 'error') {
            console.error(`✘ ${rdfPath}: ${styleError.message} (in "${styleError.label}")`);
            errors++;
          } else {
            console.warn(`⚠ ${rdfPath}: ${styleError.message} (in "${styleError.label}")`);
          }
        }
        if (styleErrors.some(e => e.severity === 'error')) {
          continue;
        }
      }

      const payload: CatalogueEntryPayload = {
        schemaVersion: 1,
        id: entryId,
        ontology,
        bindings,
      };
      const payloadContent = JSON.stringify(payload, null, 2) + '\n';
      const payloadHash = createHash('sha256')
        .update(payloadContent)
        .digest('hex');
      const relativePayloadPath = `${entryId}/${payloadHash}.json`;

      seenIds.add(entryId);
      entries.push({
        id: entryId,
        name: metadata.name,
        description: metadata.description,
        icon: metadata.icon,
        category: metadata.category,
        tags: metadata.tags ?? [],
        author: metadata.author ?? 'unknown',
        source,
        entityCount: ontology.entityTypes.length,
        relationshipCount: ontology.relationships.length,
        payloadUrl: `catalogue-payloads/${relativePayloadPath}`,
        payloadHash: `sha256:${payloadHash}`,
        license: metadata.license,
        sourceUrl: metadata.sourceUrl,
        version: metadata.version,
      });
      payloads.push({
        relativePath: relativePayloadPath,
        content: payloadContent,
      });

      console.log(`✔ ${source}/${slug}`);
    }
  }

  if (errors > 0) {
    throw new Error(`Catalogue compilation failed with ${errors} error(s)`);
  }

  return {
    catalogue: {
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      count: entries.length,
      entries,
    },
    payloads,
  };
}

export function compileCatalogue(
  catalogueDir: string = CATALOGUE_DIR,
  dependencies: CatalogueCompilerDependencies = {},
): Catalogue {
  return compileCatalogueArtifacts(catalogueDir, dependencies).catalogue;
}

export function runCatalogueCompiler(
  catalogueDir: string = CATALOGUE_DIR,
  outputPath: string = OUTPUT_PATH,
  dependencies: CatalogueCompilerDependencies = {},
): Catalogue {
  const { catalogue, payloads } = compileCatalogueArtifacts(
    catalogueDir,
    dependencies,
  );
  const payloadDirectory = outputPath === OUTPUT_PATH
    ? PAYLOAD_DIR
    : join(dirname(outputPath), 'catalogue-payloads');
  const stagingDirectory = `${payloadDirectory}.tmp-${process.pid}`;

  rmSync(stagingDirectory, { recursive: true, force: true });
  mkdirSync(stagingDirectory, { recursive: true });

  try {
    for (const payload of payloads) {
      const payloadPath = join(stagingDirectory, payload.relativePath);
      mkdirSync(dirname(payloadPath), { recursive: true });
      writeFileSync(payloadPath, payload.content, 'utf-8');
    }

    rmSync(payloadDirectory, { recursive: true, force: true });
    renameSync(stagingDirectory, payloadDirectory);
    writeFileSync(
      outputPath,
      JSON.stringify(catalogue, null, 2) + '\n',
      'utf-8',
    );
  } catch (error) {
    rmSync(stagingDirectory, { recursive: true, force: true });
    throw error;
  }

  console.log(
    `\n✔ Wrote ${catalogue.count} index entries and ${payloads.length} payloads`,
  );
  return catalogue;
}

// ------------------------------------------------------------------
// Run
// ------------------------------------------------------------------

const isMainModule =
  process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMainModule) {
  try {
    runCatalogueCompiler();
  } catch (e) {
    console.error(`\n${(e as Error).message}`);
    process.exitCode = 1;
  }
}
