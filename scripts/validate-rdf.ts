/**
 * Validates authored and externally sourced RDF/OWL using tier-aware profiles.
 *
 * Usage:
 *   npm run validate
 *   npm run validate -- path/to/file.rdf
 *   npm run validate -- --profile external path/to/file.rdf
 */
import {
  lstatSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import {
  dirname,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { sampleOntologies } from '../src/data/sampleOntologies.js';
import {
  cosmicCoffeeOntology,
  type Ontology,
} from '../src/data/ontology.js';
import { parseRDF } from '../src/lib/rdf/parser.js';
import {
  type CatalogueTier,
  type ValidationIssue,
  type ValidationReport,
  mergeValidationReports,
  validateCatalogueMetadata,
  validateOntologyForTier,
  validateRdfSource,
} from './catalogue-validation.js';
import {
  CatalogueDiscoveryError,
  discoverCatalogueSources,
} from './compile-catalogue.js';

const dom = new JSDOM('');
globalThis.DOMParser = dom.window.DOMParser;

type CliProfile = CatalogueTier | 'authored';

export interface RdfFileValidation extends ValidationReport {
  ontology?: Ontology;
}

interface ParsedArguments {
  files: string[];
  profile?: CliProfile;
  showHelp: boolean;
}

function validationIssue(
  code: string,
  message: string,
): ValidationIssue {
  return { severity: 'error', code, message };
}

function decodeUtf8(bytes: Uint8Array, path: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${path}: file must be valid UTF-8`);
  }
}

function validateRdfBytes(
  sourceBytes: Uint8Array,
  tier: CatalogueTier,
): RdfFileValidation {
  const sourceReport = validateRdfSource(sourceBytes);
  if (sourceReport.errors.length > 0 || sourceReport.text === undefined) {
    return sourceReport;
  }

  try {
    const { ontology } = parseRDF(sourceReport.text);
    const report = mergeValidationReports(
      sourceReport,
      validateOntologyForTier(ontology, tier),
    );
    return { ...report, ontology };
  } catch (error) {
    return {
      errors: [
        ...sourceReport.errors,
        validationIssue('rdf-parse', (error as Error).message),
      ],
      warnings: sourceReport.warnings,
    };
  }
}

function readStandaloneFile(path: string): Buffer {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    throw new Error(`${path}: symlinks are not accepted for RDF validation`);
  }
  if (!stat.isFile()) {
    throw new Error(`${path}: expected a regular file`);
  }
  return readFileSync(path);
}

export function validateRdfFile(
  filePath: string,
  tier: CatalogueTier = 'official',
): RdfFileValidation {
  try {
    return validateRdfBytes(readStandaloneFile(filePath), tier);
  } catch (error) {
    return {
      errors: [validationIssue('file-read', (error as Error).message)],
      warnings: [],
    };
  }
}

function parseArguments(args: string[]): ParsedArguments {
  const parsed: ParsedArguments = {
    files: [],
    showHelp: false,
  };

  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') {
      parsed.showHelp = true;
      continue;
    }
    if (argument === '--profile') {
      const profile = args[++index];
      if (
        profile !== 'authored'
        && profile !== 'official'
        && profile !== 'community'
        && profile !== 'external'
      ) {
        throw new Error(
          '--profile must be one of: authored, official, community, external',
        );
      }
      parsed.profile = profile;
      continue;
    }
    if (argument.startsWith('-')) {
      throw new Error(`Unknown option "${argument}".`);
    }
    parsed.files.push(argument);
  }

  return parsed;
}

function tierForFile(
  filePath: string,
  cwd: string,
  profile?: CliProfile,
): CatalogueTier {
  if (profile !== undefined) {
    return profile === 'authored' ? 'official' : profile;
  }

  const relativePath = relative(cwd, filePath).split(sep).join('/');
  const match = /^catalogue\/(official|community|external)\//.exec(
    relativePath,
  );
  if (
    match?.[1] === 'official'
    || match?.[1] === 'community'
    || match?.[1] === 'external'
  ) {
    return match[1];
  }
  return 'official';
}

function findAuthoredRdfFiles(directory: string): string[] {
  const files: string[] = [];
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return files;
    }
    throw error;
  }

  for (const entry of entries) {
    const fullPath = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(
        `${fullPath}: symlinks are not accepted for RDF validation`,
      );
    }
    if (entry.isDirectory()) {
      files.push(...findAuthoredRdfFiles(fullPath));
    } else if (
      entry.isFile()
      && (entry.name.endsWith('.rdf') || entry.name.endsWith('.owl'))
    ) {
      files.push(fullPath);
    }
  }

  return files.sort();
}

function metadataReportForFile(
  filePath: string,
  tier: CatalogueTier,
): ValidationReport | undefined {
  const metadataPath = join(dirname(filePath), 'metadata.json');
  try {
    const metadata = JSON.parse(
      decodeUtf8(readStandaloneFile(metadataPath), metadataPath),
    ) as unknown;
    return validateCatalogueMetadata(metadata, tier);
  } catch (error) {
    if (
      tier !== 'external'
      && (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return undefined;
    }
    return {
      errors: [
        validationIssue('metadata-read', (error as Error).message),
      ],
      warnings: [],
    };
  }
}

function printResult(
  label: string,
  report: ValidationReport,
): boolean {
  if (report.errors.length === 0) {
    console.log(`  OK  ${label}`);
  } else {
    console.log(`FAIL  ${label}`);
  }
  for (const error of report.errors) {
    console.log(`        ERROR [${error.code}] ${error.message}`);
  }
  for (const warning of report.warnings) {
    console.log(`        WARN  [${warning.code}] ${warning.message}`);
  }
  return report.errors.length === 0;
}

function printUsage(): void {
  console.log(
    'Usage: npm run validate -- [--profile authored|official|community|external] [file.rdf ...]',
  );
}

export function runValidationCli(
  args: string[] = process.argv.slice(2),
  cwd: string = process.cwd(),
): number {
  let parsedArguments: ParsedArguments;
  try {
    parsedArguments = parseArguments(args);
  } catch (error) {
    console.error((error as Error).message);
    printUsage();
    return 1;
  }

  if (parsedArguments.showHelp) {
    printUsage();
    return 0;
  }

  let failed = 0;

  if (parsedArguments.files.length > 0) {
    for (const argument of parsedArguments.files) {
      const filePath = resolve(cwd, argument);
      const tier = tierForFile(
        filePath,
        cwd,
        parsedArguments.profile,
      );
      const rdfReport = validateRdfFile(filePath, tier);
      const metadataReport = metadataReportForFile(filePath, tier);
      const report = metadataReport === undefined
        ? rdfReport
        : mergeValidationReports(metadataReport, rdfReport);
      if (!printResult(relative(cwd, filePath) || filePath, report)) {
        failed++;
      }
    }
  } else {
    const cosmicCoffeeReport = validateOntologyForTier(
      cosmicCoffeeOntology,
      'official',
    );
    if (!printResult('Fourth Coffee (built-in)', cosmicCoffeeReport)) {
      failed++;
    }

    for (const sample of sampleOntologies) {
      const report = validateOntologyForTier(sample.ontology, 'official');
      if (!printResult(`${sample.name} (built-in)`, report)) {
        failed++;
      }
    }

    try {
      for (const directory of [
        join(cwd, 'src', 'data', 'rdf'),
        join(cwd, 'content', 'learn'),
      ]) {
        for (const filePath of findAuthoredRdfFiles(directory)) {
          const report = validateRdfFile(filePath, 'official');
          if (!printResult(relative(cwd, filePath), report)) {
            failed++;
          }
        }
      }

      const discovery = discoverCatalogueSources(
        join(cwd, 'catalogue'),
      );
      for (const discoveryError of discovery.errors) {
        if (!printResult(discoveryError, {
          errors: [
            validationIssue('catalogue-discovery', discoveryError),
          ],
          warnings: [],
        })) {
          failed++;
        }
      }

      for (const source of discovery.sources) {
        let report: ValidationReport;
        try {
          const metadata = JSON.parse(decodeUtf8(
            source.readMetadata(),
            source.metadataPath,
          )) as unknown;
          report = mergeValidationReports(
            validateCatalogueMetadata(metadata, source.tier),
            validateRdfBytes(source.readRdf(), source.tier),
          );
        } catch (error) {
          if (error instanceof CatalogueDiscoveryError) throw error;
          report = {
            errors: [
              validationIssue('catalogue-read', (error as Error).message),
            ],
            warnings: [],
          };
        }
        if (!printResult(relative(cwd, source.rdfPath), report)) {
          failed++;
        }
      }
    } catch (error) {
      console.error((error as Error).message);
      failed++;
    }
  }

  if (failed > 0) {
    console.log(`\n✘ ${failed} file(s) failed validation`);
    return 1;
  }

  console.log('\n✔ All files valid');
  return 0;
}

if (
  process.argv[1]
  && fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  process.exitCode = runValidationCli();
}
