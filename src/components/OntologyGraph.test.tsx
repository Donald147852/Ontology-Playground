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
  Object.assign(collection, {
    addClass: chain,
    removeClass: chain,
    unselect: chain,
    select: chain,
    style: chain,
    not: chain,
    connectedEdges: chain,
    connectedNodes: chain,
    closedNeighborhood: chain,
    toggleClass: chain,
    forEach: vi.fn(),
  });

  const cy = {
    on: vi.fn(),
    destroy: vi.fn(),
    container: vi.fn(() => ({})),
    elements: vi.fn(() => collection),
    edges: vi.fn(() => collection),
    nodes: vi.fn(() => collection),
    $: vi.fn(() => collection),
    getElementById: vi.fn(() => collection),
    layout: vi.fn(() => ({ run: vi.fn() })),
    zoom: vi.fn(() => 1),
    center: vi.fn(),
    fit: vi.fn(),
    png: vi.fn(() => 'data:image/png;base64,test'),
  };
  const cytoscape = vi.fn(() => cy);
  return { cy, cytoscape };
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

    act(() => {
      useAppStore.getState().selectEntity(boundaryId);
    });

    const expandButton = await screen.findByRole('button', {
      name: `Show ${hiddenNeighborCount} hidden ${
        hiddenNeighborCount === 1 ? 'neighbor' : 'neighbors'
      } for ${ontology.entityTypes.find(({ id }) => id === boundaryId)?.name}`,
    });
    expect(graphMocks.cytoscape).toHaveBeenCalledTimes(1);

    fireEvent.click(expandButton);
    await waitFor(() => {
      expect(graphMocks.cytoscape).toHaveBeenCalledTimes(2);
    });
    expect(
      screen.getByRole('button', { name: 'Neighbors already shown' }),
    ).toBeDisabled();
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
