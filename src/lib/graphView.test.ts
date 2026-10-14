import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import type { Ontology, Relationship } from '../data/ontology';
import {
  createGraphView,
  DEFAULT_OVERVIEW_NODE_LIMIT,
  graphScaleTier,
  MAX_RENDERED_EDGES,
  MAX_RENDERED_NODES,
} from './graphView';

function createTreeOntology(
  nodeCount: number,
  relationshipCount = nodeCount - 1,
): Ontology {
  const entityTypes = Array.from({ length: nodeCount }, (_, index) => ({
    id: `node-${index}`,
    name: `Node ${index}`,
    description: `Taxonomy node ${index}`,
    properties: [],
    icon: 'N',
    color: '#0078D4',
  }));
  const relationships: Relationship[] = [];

  for (let index = 1; index < entityTypes.length; index += 1) {
    relationships.push({
      id: `parent-${index}`,
      name: 'subClassOf',
      from: entityTypes[index].id,
      to: entityTypes[Math.floor((index - 1) / 3)].id,
      cardinality: 'many-to-one',
      kind: 'subclass',
    });
  }
  for (let index = 0; relationships.length < relationshipCount; index += 1) {
    relationships.push({
      id: `related-${index}`,
      name: 'relatedTo',
      from: entityTypes[index % entityTypes.length].id,
      to: entityTypes[(index + 17) % entityTypes.length].id,
      cardinality: 'many-to-many',
    });
  }

  return {
    name: 'Taxonomy fixture',
    description: 'Graph projection fixture',
    entityTypes,
    relationships,
  };
}

describe('adaptive graph views', () => {
  it('keeps small ontologies complete', () => {
    const ontology = createTreeOntology(12);
    const view = createGraphView(ontology);

    expect(view.mode).toBe('full');
    expect(view.tier).toBe('standard');
    expect(view.entities).toBe(ontology.entityTypes);
    expect(view.relationships).toBe(ontology.relationships);
    expect(view.truncated).toBe(false);
  });

  it('keeps dense ontologies complete while selecting the dense visual tier', () => {
    const ontology = createTreeOntology(86, 312);
    const view = createGraphView(ontology);

    expect(graphScaleTier(ontology)).toBe('dense');
    expect(view.mode).toBe('dense');
    expect(view.visibleNodeCount).toBe(86);
    expect(view.visibleEdgeCount).toBe(312);
    expect(view.hiddenNodeCount).toBe(0);
  });

  it('projects Brick-scale graphs into a bounded hierarchy overview', () => {
    const ontology = createTreeOntology(1_518, 1_736);
    const startedAt = performance.now();
    const view = createGraphView(ontology);

    expect(performance.now() - startedAt).toBeLessThan(200);
    expect(view.mode).toBe('bounded');
    expect(view.tier).toBe('massive');
    expect(view.rootIds).toContain('node-0');
    expect(view.visibleNodeCount).toBeGreaterThan(1);
    expect(view.visibleNodeCount).toBeLessThanOrEqual(
      DEFAULT_OVERVIEW_NODE_LIMIT,
    );
    expect(view.visibleEdgeCount).toBeLessThanOrEqual(MAX_RENDERED_EDGES);
    expect(view.hiddenNodeCount).toBeGreaterThan(1_000);
    expect(view.hiddenNeighborCounts.size).toBeGreaterThan(0);
  });

  it('uses hierarchy semantics instead of relationship names when finding roots', () => {
    const ontology = createTreeOntology(1_000, 1_100);
    ontology.relationships.forEach((relationship) => {
      if (relationship.kind === 'subclass') relationship.name = 'inherits';
    });

    const view = createGraphView(ontology);

    expect(view.rootIds).toContain('node-0');
    expect(view.entities.some((entity) => entity.id === 'node-0')).toBe(true);
  });

  it('ranks exact search matches and opens their neighborhood', () => {
    const ontology = createTreeOntology(1_000, 1_100);
    const view = createGraphView(ontology, {
      search: 'Node 700',
      depth: 1,
    });

    expect(view.searchMatchCount).toBe(1);
    expect(view.entities.some((entity) => entity.id === 'node-700')).toBe(true);
    expect(view.visibleNodeCount).toBeLessThanOrEqual(MAX_RENDERED_NODES);
  });

  it('falls back to roots when search has no matches', () => {
    const ontology = createTreeOntology(1_000, 1_100);
    const view = createGraphView(ontology, { search: 'not-present' });

    expect(view.searchMatchCount).toBe(0);
    expect(view.entities.some((entity) => entity.id === 'node-0')).toBe(true);
  });

  it('prioritizes explicitly expanded hidden neighborhoods', () => {
    const ontology = createTreeOntology(1_000, 1_100);
    const view = createGraphView(ontology, {
      expandedNodeIds: ['node-900'],
    });

    expect(view.entities.some((entity) => entity.id === 'node-900')).toBe(true);
    expect(view.entities.some((entity) => entity.id === 'node-299')).toBe(true);
    expect(view.visibleNodeCount).toBeLessThanOrEqual(MAX_RENDERED_NODES);
  });

  it('always includes a selected relationship and its endpoints', () => {
    const ontology = createTreeOntology(20, 700);
    const selectedRelationship = ontology.relationships[
      ontology.relationships.length - 1
    ];
    const view = createGraphView(ontology, {
      priorityRelationshipIds: [selectedRelationship.id],
    });
    const visibleIds = new Set(view.entities.map((entity) => entity.id));

    expect(view.relationships[0]).toBe(selectedRelationship);
    expect(visibleIds.has(selectedRelationship.from)).toBe(true);
    expect(visibleIds.has(selectedRelationship.to)).toBe(true);
    expect(view.visibleEdgeCount).toBeLessThanOrEqual(MAX_RENDERED_EDGES);
  });

  it('never emits relationships with hidden endpoints', () => {
    const ontology = createTreeOntology(1_518, 1_736);
    const view = createGraphView(ontology, { depth: 4 });
    const visibleIds = new Set(view.entities.map((entity) => entity.id));

    expect(view.relationships.every((relationship) => (
      visibleIds.has(relationship.from) && visibleIds.has(relationship.to)
    ))).toBe(true);
  });
});
