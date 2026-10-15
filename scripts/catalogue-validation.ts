import type { Ontology } from '../src/data/ontology';
import { validateOntology } from '../src/store/designerStore';

export const CATALOGUE_TIERS = [
  'official',
  'community',
  'external',
] as const;

export type CatalogueTier = (typeof CATALOGUE_TIERS)[number];
export type ValidationProfile = 'authored' | 'external';

export interface CatalogueMetadata {
  name: string;
  description: string;
  category: string;
  icon?: string;
  tags?: string[];
  author?: string;
  license?: string;
  sourceUrl?: string;
  version?: string;
}

export interface ValidationIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
}

export interface ValidationReport {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export interface RdfSourceValidationReport extends ValidationReport {
  text?: string;
}

export interface ValidationLimits {
  maxSourceBytes: number;
  maxEntities: number;
  maxRelationships: number;
  maxProperties: number;
  maxImports: number;
}

export const DEFAULT_VALIDATION_LIMITS: ValidationLimits = {
  maxSourceBytes: 8 * 1024 * 1024,
  maxEntities: 5_000,
  maxRelationships: 20_000,
  maxProperties: 50_000,
  maxImports: 1_000,
};

const FABRIC_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const ACTIVE_XML_PATTERN = /<!\s*(?:DOCTYPE|ENTITY)\b/i;
const VALID_CATEGORIES = new Set([
  'retail',
  'healthcare',
  'finance',
  'manufacturing',
  'education',
  'food',
  'media',
  'events',
  'technology',
  'general',
  'iq-lab',
  'school',
  'fibo',
]);

const SOURCE_ONLY_PATTERNS = [
  {
    label: 'OWL restrictions',
    pattern: /<(?:[A-Za-z_][\w.-]*:)?Restriction\b/gi,
  },
  {
    label: 'OWL set expressions',
    pattern:
      /<(?:[A-Za-z_][\w.-]*:)?(?:unionOf|intersectionOf|complementOf|oneOf)\b/gi,
  },
  {
    label: 'OWL property chains',
    pattern: /<(?:[A-Za-z_][\w.-]*:)?propertyChainAxiom\b/gi,
  },
  {
    label: 'OWL keys',
    pattern: /<(?:[A-Za-z_][\w.-]*:)?hasKey\b/gi,
  },
  {
    label: 'OWL disjointness axioms',
    pattern:
      /<(?:[A-Za-z_][\w.-]*:)?(?:disjointWith|AllDisjointClasses|AllDisjointProperties)\b/gi,
  },
] as const;

function issue(
  severity: ValidationIssue['severity'],
  code: string,
  message: string,
): ValidationIssue {
  return { severity, code, message };
}

function emptyReport(): ValidationReport {
  return { errors: [], warnings: [] };
}

function appendIssue(
  report: ValidationReport,
  candidate: ValidationIssue,
): void {
  report[candidate.severity === 'error' ? 'errors' : 'warnings'].push(candidate);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasSafeText(value: string): boolean {
  return value === value.trim()
    && value.length > 0
    && !Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    });
}

function isSafeHttpsUrl(value: string): boolean {
  if (!hasSafeText(value) || /\s/.test(value)) {
    return false;
  }

  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && Boolean(url.hostname)
      && url.username === ''
      && url.password === '';
  } catch {
    return false;
  }
}

function countMatches(source: string, pattern: RegExp): number {
  return Array.from(source.matchAll(pattern)).length;
}

function profileForTier(tier: CatalogueTier): ValidationProfile {
  return tier === 'external' ? 'external' : 'authored';
}

export function validateCatalogueMetadata(
  metadata: unknown,
  tier: CatalogueTier,
): ValidationReport {
  const report = emptyReport();
  if (!isRecord(metadata)) {
    report.errors.push(issue(
      'error',
      'metadata-object',
      'Metadata must be a JSON object.',
    ));
    return report;
  }

  for (const field of ['name', 'description', 'category'] as const) {
    const value = metadata[field];
    if (typeof value !== 'string' || !hasSafeText(value)) {
      report.errors.push(issue(
        'error',
        `metadata-${field}`,
        `Metadata field "${field}" must be a non-empty string without control characters.`,
      ));
    }
  }

  if (
    typeof metadata.category === 'string'
    && hasSafeText(metadata.category)
    && !VALID_CATEGORIES.has(metadata.category)
  ) {
    report.errors.push(issue(
      'error',
      'metadata-category',
      `Metadata field "category" must be one of: ${Array.from(VALID_CATEGORIES).join(', ')}.`,
    ));
  }

  for (const field of [
    'icon',
    'author',
    'license',
    'sourceUrl',
    'version',
  ] as const) {
    const value = metadata[field];
    if (
      value !== undefined
      && (typeof value !== 'string' || !hasSafeText(value))
    ) {
      report.errors.push(issue(
        'error',
        `metadata-${field}`,
        `Metadata field "${field}" must be a non-empty string without control characters when provided.`,
      ));
    }
  }

  if (metadata.tags !== undefined) {
    if (
      !Array.isArray(metadata.tags)
      || metadata.tags.some(
        (tag) => typeof tag !== 'string' || !hasSafeText(tag),
      )
    ) {
      report.errors.push(issue(
        'error',
        'metadata-tags',
        'Metadata field "tags" must be an array of non-empty strings without control characters.',
      ));
    }
  }

  if (tier === 'external') {
    for (const field of ['license', 'sourceUrl'] as const) {
      const value = metadata[field];
      if (typeof value !== 'string' || !hasSafeText(value)) {
        report.errors.push(issue(
          'error',
          'external-provenance',
          `External metadata requires "${field}".`,
        ));
      }
    }

  }

  if (
    typeof metadata.sourceUrl === 'string'
    && !isSafeHttpsUrl(metadata.sourceUrl)
  ) {
    report.errors.push(issue(
      'error',
      'metadata-source-url',
      'Metadata "sourceUrl" must be a safe HTTPS URL.',
    ));
  }

  return report;
}

export function validateRdfSource(
  sourceBytes: Uint8Array,
  limits: ValidationLimits = DEFAULT_VALIDATION_LIMITS,
): RdfSourceValidationReport {
  const report: RdfSourceValidationReport = emptyReport();

  if (sourceBytes.byteLength > limits.maxSourceBytes) {
    report.errors.push(issue(
      'error',
      'source-size-limit',
      `RDF source is ${sourceBytes.byteLength.toLocaleString()} bytes; the limit is ${limits.maxSourceBytes.toLocaleString()} bytes.`,
    ));
    return report;
  }

  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(sourceBytes);
  } catch {
    report.errors.push(issue(
      'error',
      'source-utf8',
      'RDF source must be valid UTF-8.',
    ));
    return report;
  }
  report.text = source;

  if (ACTIVE_XML_PATTERN.test(source)) {
    report.errors.push(issue(
      'error',
      'source-active-xml',
      'DOCTYPE and ENTITY declarations are not allowed in catalogue RDF.',
    ));
    return report;
  }

  const importCount = countMatches(
    source,
    /<(?:[A-Za-z_][\w.-]*:)?imports\b/gi,
  );
  if (importCount > limits.maxImports) {
    report.errors.push(issue(
      'error',
      'resource-imports',
      `Ontology declares ${importCount.toLocaleString()} imports; the limit is ${limits.maxImports.toLocaleString()}.`,
    ));
  }

  const sourceOnlySemantics: { label: string; count: number }[] =
    SOURCE_ONLY_PATTERNS
    .map(({ label, pattern }) => ({
      label,
      count: countMatches(source, pattern),
    }))
    .filter(({ count }) => count > 0);

  if (importCount > 0) {
    sourceOnlySemantics.push({
      label: 'OWL imports',
      count: importCount,
    });
  }

  if (sourceOnlySemantics.length > 0) {
    report.warnings.push(issue(
      'warning',
      'source-only-semantics',
      `Source-only semantics are preserved in the original RDF but are not expanded in the visual model: ${sourceOnlySemantics.map(({ label, count }) => `${label} (${count.toLocaleString()})`).join(', ')}.`,
    ));
  }

  return report;
}

function validateResourceLimits(
  ontology: Ontology,
  limits: ValidationLimits,
): ValidationReport {
  const report = emptyReport();
  const propertyCount = ontology.entityTypes.reduce(
    (sum, entity) => sum + entity.properties.length,
    0,
  );
  const checks = [
    ['entities', ontology.entityTypes.length, limits.maxEntities],
    [
      'relationships',
      ontology.relationships.length,
      limits.maxRelationships,
    ],
    ['properties', propertyCount, limits.maxProperties],
  ] as const;

  for (const [label, count, limit] of checks) {
    if (count > limit) {
      report.errors.push(issue(
        'error',
        `resource-${label}`,
        `Ontology contains ${count.toLocaleString()} ${label}; the limit is ${limit.toLocaleString()}.`,
      ));
    }
  }

  return report;
}

function validateExternalCore(ontology: Ontology): ValidationReport {
  const report = emptyReport();
  const entityIds = new Set<string>();
  const relationshipIds = new Set<string>();

  if (ontology.entityTypes.length === 0) {
    report.errors.push(issue(
      'error',
      'ontology-empty',
      'Ontology must contain at least one class.',
    ));
  }

  for (const entity of ontology.entityTypes) {
    if (!entity.id.trim()) {
      report.errors.push(issue(
        'error',
        'entity-id-empty',
        `External class "${entity.name}" must have a stable identifier.`,
      ));
    } else if (entityIds.has(entity.id)) {
      report.errors.push(issue(
        'error',
        'entity-id-duplicate',
        `Duplicate external class identifier "${entity.id}".`,
      ));
    } else {
      entityIds.add(entity.id);
    }

    const propertyNames = new Set<string>();
    for (const property of entity.properties) {
      if (!property.name.trim()) {
        report.errors.push(issue(
          'error',
          'property-name-empty',
          `Properties on "${entity.name}" must have a stable name.`,
        ));
      } else if (propertyNames.has(property.name)) {
        report.errors.push(issue(
          'error',
          'property-name-duplicate',
          `Duplicate property name "${property.name}" on "${entity.name}".`,
        ));
      } else {
        propertyNames.add(property.name);
      }
    }
  }

  for (const relationship of ontology.relationships) {
    if (!relationship.id.trim()) {
      report.errors.push(issue(
        'error',
        'relationship-id-empty',
        `Relationship "${relationship.name}" must have a stable identifier.`,
      ));
    } else if (relationshipIds.has(relationship.id)) {
      report.errors.push(issue(
        'error',
        'relationship-id-duplicate',
        `Duplicate relationship identifier "${relationship.id}".`,
      ));
    } else {
      relationshipIds.add(relationship.id);
    }

    if (!entityIds.has(relationship.from)) {
      report.errors.push(issue(
        'error',
        'relationship-source',
        `Relationship "${relationship.name}" references missing source "${relationship.from}".`,
      ));
    }
    if (!entityIds.has(relationship.to)) {
      report.errors.push(issue(
        'error',
        'relationship-target',
        `Relationship "${relationship.name}" references missing target "${relationship.to}".`,
      ));
    }
  }

  return report;
}

function externalCompatibilityWarnings(
  ontology: Ontology,
): ValidationIssue[] {
  const warnings: ValidationIssue[] = [];
  const missingIdentifierCount = ontology.entityTypes.filter(
    (entity) => !entity.properties.some((property) => property.isIdentifier),
  ).length;
  const incompatibleNameCount = ontology.entityTypes.filter(
    (entity) =>
      entity.name.length > 26 || !FABRIC_NAME_PATTERN.test(entity.name),
  ).length;

  if (missingIdentifierCount > 0) {
    warnings.push(issue(
      'warning',
      'designer-identifiers',
      `${missingIdentifierCount.toLocaleString()} external classes do not define Designer identifier properties; catalogue browsing remains supported.`,
    ));
  }
  if (incompatibleNameCount > 0) {
    warnings.push(issue(
      'warning',
      'designer-entity-names',
      `${incompatibleNameCount.toLocaleString()} external class labels do not meet Designer naming conventions; their source labels are preserved.`,
    ));
  }

  return warnings;
}

export function validateOntologyForTier(
  ontology: Ontology,
  tier: CatalogueTier,
  limits: ValidationLimits = DEFAULT_VALIDATION_LIMITS,
): ValidationReport {
  const report = validateResourceLimits(ontology, limits);

  if (profileForTier(tier) === 'authored') {
    const designerReport = validateOntology(ontology);
    for (const validationError of designerReport) {
      appendIssue(
        report,
        issue('error', 'designer-validation', validationError.message),
      );
    }
    return report;
  }

  const coreReport = validateExternalCore(ontology);
  report.errors.push(...coreReport.errors);
  report.warnings.push(
    ...coreReport.warnings,
    ...externalCompatibilityWarnings(ontology),
  );
  return report;
}

export function mergeValidationReports(
  ...reports: ValidationReport[]
): ValidationReport {
  return {
    errors: reports.flatMap((report) => report.errors),
    warnings: reports.flatMap((report) => report.warnings),
  };
}
