import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ontology, Relationship } from '../data/ontology';
import {
  createGraphView,
  MAX_RENDERED_EDGES,
  MAX_RENDERED_NODES,
} from '../lib/graphView';
import { useAppStore } from '../store/appStore';
import { OntologyGraph } from './OntologyGraph';

const graphMocks = vi.hoisted(() => {
  const collection: Record<string, unknown> & { length: number } = { length: 1 };
  const chain = vi.fn(() => collection);
  const addClass = vi.fn(() => collection);
  const removeClass = vi.fn(() => collection);
  const connectedEdges = vi.fn(() => collection);
  Object.assign(collection, {
    addClass,
    removeClass,
    unselect: chain,
    select: chain,
    style: chain,
    not: chain,
    connectedEdges,
    connectedNodes: chain,
    closedNeighborhood: chain,
    toggleClass: chain,
    forEach: vi.fn(),
    renderedBoundingBox: vi.fn(() => ({
      x1: 200,
      y1: 200,
      x2: 240,
      y2: 240,
      w: 40,
      h: 40,
    })),
  });

  const cy = {
    on: vi.fn(),
    off: vi.fn(),
    destroy: vi.fn(),
    container: vi.fn(() => ({})),
    elements: vi.fn(() => collection),
    edges: vi.fn(() => collection),
    nodes: vi.fn(() => collection),
    $: vi.fn(() => collection),
    getElementById: vi.fn(() => collection),
    layout: vi.fn(() => ({ run: vi.fn() })),
    zoom: vi.fn(() => 1),
    width: vi.fn(() => 800),
    height: vi.fn(() => 600),
    center: vi.fn(),
    fit: vi.fn(),
    png: vi.fn(() => 'data:image/png;base64,test'),
  };
  const cytoscape = vi.fn(() => cy);
  return { addClass, connectedEdges, cy, cytoscape };
});

vi.mock('cytoscape', () => {
  Object.assign(graphMocks.cytoscape, { use: vi.fn() });
  return { default: graphMocks.cytoscape };
});

vi.mock('cytoscape-fcose', () => ({ default: vi.fn() }));

function createLargeFixture(): Ontology {
  const entityTypes = Array.from({ length: 350 }, (_, index) => ({
    id: `node-${index}`,
    name: `Node ${index}`,
    description: `Taxonomy node ${index}`,
    properties: [],
    icon: 'N',
    color: '#0078D4',
  }));
  const relationships: Relationship[] = entityTypes.slice(1).map((entity, index) => ({
    id: `parent-${index + 1}`,
    name: 'subClassOf',
    from: entity.id,
    to: entityTypes[Math.floor(index / 3)].id,
    cardinality: 'many-to-one',
    kind: 'subclass',
  }));

  return {
    name: 'Large Taxonomy Fixture',
    description: 'Large rendering fixture',
    entityTypes,
    relationships,
  };
}

function createDenseFixture(): Ontology {
  const entityTypes = Array.from({ length: 90 }, (_, index) => ({
    id: `dense-${index}`,
    name: `Dense ${index}`,
    description: `Dense node ${index}`,
    properties: [],
    icon: 'D',
    color: '#0078D4',
  }));
  const relationships: Relationship[] = entityTypes.slice(1).map((entity) => ({
    id: `dense-edge-${entity.id}`,
    name: 'connectedTo',
    from: entity.id,
    to: entityTypes[0].id,
    cardinality: 'many-to-one',
  }));

  return {
    name: 'Dense Graph Fixture',
    description: 'Dense rendering fixture',
    entityTypes,
    relationships,
  };
}

interface CapturedConfig {
  elements: Array<{ data: { id: string } }>;
  layout: { name: string; quality?: string };
  style: Array<{
    selector: string;
    style: Record<string, unknown>;
  }>;
}

describe('OntologyGraph adaptive rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.getState().resetToDefault();
    delete window.__ONTOLOGY_PREVIEW_CY__;
  });

  it('preserves the proof-quality layout for a small ontology', async () => {
    render(<OntologyGraph />);

    await waitFor(() => {
      expect(graphMocks.cytoscape).toHaveBeenCalledTimes(1);
    });

    const config = graphMocks.cytoscape.mock.calls[0][0] as CapturedConfig;
    expect(config.layout.name).toBe('fcose');
    expect(config.layout.quality).toBe('proof');
    expect(
      screen.queryByRole('region', { name: 'Large ontology controls' }),
    ).not.toBeInTheDocument();
  });

  it('renders a bounded semantic overview for a massive ontology', async () => {
    useAppStore.getState().loadOntology(createLargeFixture());

    render(<OntologyGraph />);

    expect(
      screen.getByRole('region', { name: 'Large ontology controls' }),
    ).toHaveTextContent('Showing');
    await waitFor(() => {
      expect(graphMocks.cytoscape).toHaveBeenCalledTimes(1);
    });

    const config = graphMocks.cytoscape.mock.calls[0][0] as CapturedConfig;
    expect(config.layout.name).toBe('breadthfirst');
    expect(config.elements.length).toBeLessThanOrEqual(
      MAX_RENDERED_NODES + MAX_RENDERED_EDGES,
    );
    expect(config.elements.length).toBeLessThan(350 + 349);
    expect(config.style).toContainEqual(expect.objectContaining({
      selector: 'edge.hovered',
      style: expect.objectContaining({ label: 'data(label)' }),
    }));
    expect(config.style).toContainEqual(expect.objectContaining({
      selector: 'edge.selected-node-edge',
      style: expect.objectContaining({
        label: 'data(label)',
        'min-zoomed-font-size': 0,
      }),
    }));
    expect(graphMocks.cy.on).toHaveBeenCalledWith(
      'mouseover',
      'edge',
      expect.any(Function),
    );
    expect(graphMocks.cy.on).toHaveBeenCalledWith(
      'mouseout',
      'edge',
      expect.any(Function),
    );

    const resetView = screen.getByRole('button', { name: 'Reset view' });
    const detailSlider = screen.getByRole('slider', { name: 'Detail: 1 hop' });
    expect(detailSlider.parentElement).toHaveClass('large-graph-options');
    expect(detailSlider.previousElementSibling).toHaveClass('large-graph-detail-header');
    expect(resetView).toBeDisabled();
    expect(
      screen.getByRole('button', {
        name: 'Select a +N entity to show neighbors',
      }),
    ).toBeDisabled();
    expect(Number(detailSlider.getAttribute('max'))).toBeGreaterThan(1);
    fireEvent.change(detailSlider, {
      target: { value: '2' },
    });
    await waitFor(() => {
      expect(graphMocks.cytoscape).toHaveBeenCalledTimes(2);
    });
    expect(screen.getByRole('slider', { name: 'Detail: 2 hops' })).toHaveValue('2');
    expect(resetView).toBeEnabled();
  });

  it('keeps relationship labels occluded for selected dense graph hubs', async () => {
    useAppStore.getState().loadOntology(createDenseFixture());
    render(<OntologyGraph />);
    await waitFor(() => {
      expect(graphMocks.cytoscape).toHaveBeenCalledTimes(1);
    });

    const config = graphMocks.cytoscape.mock.calls[0][0] as CapturedConfig;
    expect(config.style).toContainEqual(expect.objectContaining({
      selector: 'edge',
      style: expect.objectContaining({ label: '' }),
    }));

    act(() => {
      useAppStore.getState().selectEntity('dense-0');
    });

    expect(graphMocks.connectedEdges).toHaveBeenCalled();
    expect(graphMocks.addClass).not.toHaveBeenCalledWith(
      'selected-node-edge',
    );
  });

  it('keeps a visible boundary entity anchored until expansion is requested', async () => {
    const ontology = createLargeFixture();
    const initialView = createGraphView(ontology);
    const boundary = [...initialView.hiddenNeighborCounts.entries()][0];
    expect(boundary).toBeDefined();
    const [boundaryId, hiddenNeighborCount] = boundary!;

    useAppStore.getState().loadOntology(ontology);
    render(<OntologyGraph />);
    await waitFor(() => {
      expect(graphMocks.cytoscape).toHaveBeenCalledTimes(1);
    });
    const initialConfig = graphMocks.cytoscape.mock.calls[0][0] as CapturedConfig;
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));

    act(() => {
      useAppStore.getState().selectEntity(boundaryId);
    });

    const boundaryName = ontology.entityTypes.find(
      ({ id }) => id === boundaryId,
    )?.name;
    const expandButton = await screen.findByRole('button', {
      name: `Expand ${boundaryName} to show ${hiddenNeighborCount} hidden ${
        hiddenNeighborCount === 1 ? 'neighbor' : 'neighbors'
      }`,
    });
    expect(expandButton).toHaveClass(
      'graph-neighbor-action',
      'graph-neighbor-action--above',
    );
    expect(expandButton).toHaveStyle({ left: '220px', top: '190px' });
    expect(graphMocks.cytoscape).toHaveBeenCalledTimes(1);
    expect(graphMocks.connectedEdges).toHaveBeenCalled();
    expect(graphMocks.addClass).toHaveBeenCalledWith('selected-node-edge');

    graphMocks.addClass.mockClear();
    fireEvent.click(expandButton);
    await waitFor(() => {
      expect(graphMocks.cytoscape).toHaveBeenCalledTimes(2);
    });
    expect(graphMocks.addClass).toHaveBeenCalledWith('selected-node-edge');
    expect(screen.queryByRole('button', {
      name: `Expand ${boundaryName} to show ${hiddenNeighborCount} hidden ${
        hiddenNeighborCount === 1 ? 'neighbor' : 'neighbors'
      }`,
    })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(
      screen.getByRole('button', { name: 'Neighbors already shown' }),
    ).toBeDisabled();

    fireEvent.change(screen.getByRole('slider', { name: 'Detail: 1 hop' }), {
      target: { value: '2' },
    });
    await waitFor(() => {
      expect(graphMocks.cytoscape).toHaveBeenCalledTimes(3);
    });
    fireEvent.change(screen.getByRole('slider', { name: 'Detail: 2 hops' }), {
      target: { value: '1' },
    });
    await waitFor(() => {
      expect(graphMocks.cytoscape).toHaveBeenCalledTimes(4);
    });

    const collapsedConfig =
      graphMocks.cytoscape.mock.calls[3][0] as CapturedConfig;
    expect(collapsedConfig.elements).toHaveLength(initialConfig.elements.length);
    expect(screen.getByRole('button', {
      name: `Show ${hiddenNeighborCount} hidden ${
        hiddenNeighborCount === 1 ? 'neighbor' : 'neighbors'
      } for ${boundaryName}`,
    })).toBeEnabled();
  });

  it('clears a deep selection when lowering hierarchy detail', async () => {
    const ontology = createLargeFixture();
    const initialView = createGraphView(ontology, { depth: 1 });
    const detailedView = createGraphView(ontology, { depth: 2 });
    const initialIds = new Set(initialView.entities.map(({ id }) => id));
    const deepEntity = detailedView.entities.find(
      ({ id }) => !initialIds.has(id),
    );
    expect(deepEntity).toBeDefined();

    useAppStore.getState().loadOntology(ontology);
    render(<OntologyGraph />);
    await waitFor(() => {
      expect(graphMocks.cytoscape).toHaveBeenCalledTimes(1);
    });
    const initialConfig = graphMocks.cytoscape.mock.calls[0][0] as CapturedConfig;

    fireEvent.change(screen.getByRole('slider', { name: 'Detail: 1 hop' }), {
      target: { value: '2' },
    });
    await waitFor(() => {
      expect(graphMocks.cytoscape).toHaveBeenCalledTimes(2);
    });
    act(() => {
      useAppStore.getState().selectEntity(deepEntity!.id);
    });
    expect(graphMocks.cytoscape).toHaveBeenCalledTimes(2);

    fireEvent.change(screen.getByRole('slider', { name: 'Detail: 2 hops' }), {
      target: { value: '1' },
    });
    await waitFor(() => {
      expect(graphMocks.cytoscape).toHaveBeenCalledTimes(3);
    });

    const collapsedConfig =
      graphMocks.cytoscape.mock.calls[2][0] as CapturedConfig;
    expect(collapsedConfig.elements).toHaveLength(initialConfig.elements.length);
    expect(useAppStore.getState().selectedEntityId).toBeNull();
  });

  it('reveals a hidden entity selected from another navigation surface', async () => {
    useAppStore.getState().loadOntology(createLargeFixture());
    render(<OntologyGraph />);
    await waitFor(() => {
      expect(graphMocks.cytoscape).toHaveBeenCalledTimes(1);
    });

    act(() => {
      useAppStore.getState().selectEntity('node-349');
    });

    await waitFor(() => {
      expect(graphMocks.cytoscape).toHaveBeenCalledTimes(2);
    });
    const config = graphMocks.cytoscape.mock.calls[1][0] as CapturedConfig;
    expect(config.elements).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({ id: 'node-349' }),
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Reset view' }));
    await waitFor(() => {
      expect(graphMocks.cytoscape).toHaveBeenCalledTimes(3);
    });
    const resetConfig = graphMocks.cytoscape.mock.calls[2][0] as CapturedConfig;
    expect(resetConfig.elements).not.toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({ id: 'node-349' }),
      }),
    );
  });

  it('jumps to a deep entity from the semantic overview search', async () => {
    useAppStore.getState().loadOntology(createLargeFixture());
    render(<OntologyGraph />);
    await waitFor(() => {
      expect(graphMocks.cytoscape).toHaveBeenCalledTimes(1);
    });

    fireEvent.change(screen.getByLabelText('Jump to an entity'), {
      target: { value: 'Node 349' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));

    await waitFor(() => {
      expect(graphMocks.cytoscape).toHaveBeenCalledTimes(2);
    });
    const config = graphMocks.cytoscape.mock.calls[1][0] as CapturedConfig;
    expect(config.elements).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({ id: 'node-349' }),
      }),
    );
    expect(
      screen.getByText('1 matching entity.').closest('.large-graph-status'),
    ).not.toBeNull();
  });
});
