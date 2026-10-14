import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EmbedWidget } from './EmbedWidget';
import type { EmbedConfig } from './EmbedWidget';
import type { Ontology } from '../data/ontology';
import type { Catalogue } from '../types/catalogue';

// Minimal ontology for testing (ASCII-only icons to avoid btoa encoding issues in jsdom)
const testOntology: Ontology = {
  name: 'Test Ontology',
  description: 'A test ontology',
  entityTypes: [
    { id: 'e1', name: 'Customer', description: 'A customer', icon: 'C', color: '#0078D4', properties: [{ name: 'id', type: 'string', isIdentifier: true }, { name: 'name', type: 'string' }] },
    { id: 'e2', name: 'Order', description: 'An order', icon: 'O', color: '#107C10', properties: [{ name: 'orderId', type: 'string', isIdentifier: true }] },
  ],
  relationships: [
    { id: 'r1', name: 'places', from: 'e1', to: 'e2', cardinality: 'one-to-many', description: 'Customer places order' },
  ],
};

const fakeCatalogue: Catalogue = {
  generatedAt: '2025-01-01T00:00:00Z',
  count: 1,
  entries: [{
    id: 'official/test',
    name: 'Test Ontology',
    description: 'A test',
    icon: '📦',
    category: 'general',
    tags: [],
    author: 'Test',
    source: 'official',
    ontology: testOntology,
    bindings: [],
  }],
};

function createLargeOntology(): Ontology {
  const entityTypes = Array.from({ length: 350 }, (_, index) => ({
    id: `node-${index}`,
    name: `Node ${index}`,
    description: `Taxonomy node ${index}`,
    icon: 'N',
    color: '#0078D4',
    properties: [],
  }));

  return {
    name: 'Large Embedded Taxonomy',
    description: 'Large embed fixture',
    entityTypes,
    relationships: entityTypes.slice(1).map((entity, index) => ({
      id: `parent-${index + 1}`,
      name: 'subClassOf',
      from: entity.id,
      to: entityTypes[Math.floor(index / 3)].id,
      cardinality: 'many-to-one',
      kind: 'subclass',
    })),
  };
}

function mockFetch(data: unknown, ok = true) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok,
    status: ok ? 200 : 404,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(typeof data === 'string' ? data : JSON.stringify(data)),
  } as Response);
}

/* Cytoscape needs a DOM container with dimensions. 
   jsdom doesn't render so we mock cytoscape to avoid layout errors. */
vi.mock('cytoscape', () => {
  type MockHandler = (...args: unknown[]) => void;
  const handlers: Record<string, MockHandler[]> = {};
  const nodes = { toggleClass: vi.fn() };
  const mockCy = {
    on: (event: string, selectorOrFn: string | MockHandler, maybeFn?: MockHandler) => {
      const fn = maybeFn || selectorOrFn as MockHandler;
      const key = typeof selectorOrFn === 'string' ? `${event}:${selectorOrFn}` : event;
      (handlers[key] ||= []).push(fn);
    },
    destroy: vi.fn(),
    container: () => document.createElement('div'),
    nodes: () => nodes,
    zoom: () => 1,
  };
  const cytoscape = vi.fn(() => mockCy);
  Object.assign(cytoscape, { use: vi.fn() });
  return { default: cytoscape };
});

vi.mock('cytoscape-fcose', () => ({ default: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('EmbedWidget', () => {
  it('shows loading state then renders ontology name', async () => {
    mockFetch(fakeCatalogue);
    const config: EmbedConfig = { catalogueId: 'official/test', theme: 'dark', height: '400px' };
    render(<EmbedWidget config={config} />);

    expect(screen.getByText('Loading ontology…')).toBeTruthy();

    await waitFor(() => {
      expect(screen.getByText('Test Ontology')).toBeTruthy();
    });
  });

  it('loads ontology from inline base64 JSON', async () => {
    const inline = btoa(JSON.stringify(testOntology));
    const config: EmbedConfig = { ontologyInline: inline, theme: 'dark', height: '400px' };
    render(<EmbedWidget config={config} />);

    await waitFor(() => {
      expect(screen.getByText('Test Ontology')).toBeTruthy();
    });
    expect(screen.getByText(/2 entities/)).toBeTruthy();
    expect(screen.getByText(/1 relationship/)).toBeTruthy();
  });

  it('shows error when no source specified', async () => {
    const config: EmbedConfig = { theme: 'dark', height: '400px' };
    render(<EmbedWidget config={config} />);

    await waitFor(() => {
      expect(screen.getByText(/No ontology source specified/)).toBeTruthy();
    });
  });

  it('shows error on fetch failure', async () => {
    mockFetch(null, false);
    const config: EmbedConfig = { ontologyUrl: 'https://example.com/bad.rdf', theme: 'dark', height: '400px' };
    render(<EmbedWidget config={config} />);

    await waitFor(() => {
      expect(screen.getByText(/Failed to fetch ontology/)).toBeTruthy();
    });
  });

  it('shows error when catalogue ID not found', async () => {
    mockFetch(fakeCatalogue);
    const config: EmbedConfig = { catalogueId: 'nonexistent', theme: 'dark', height: '400px' };
    render(<EmbedWidget config={config} />);

    await waitFor(() => {
      expect(screen.getByText(/not found in catalogue/)).toBeTruthy();
    });
  });

  it('switches between Graph and RDF Source tabs', async () => {
    const inline = btoa(JSON.stringify(testOntology));
    const config: EmbedConfig = { ontologyInline: inline, theme: 'dark', height: '400px' };
    const user = userEvent.setup();
    render(<EmbedWidget config={config} />);

    await waitFor(() => {
      expect(screen.getByText('Test Ontology')).toBeTruthy();
    });

    // Initially on Graph tab — no RDF source visible
    expect(screen.getByText('Graph')).toBeTruthy();
    expect(screen.getByText('RDF Source')).toBeTruthy();

    // Switch to RDF tab
    await user.click(screen.getByText('RDF Source'));

    // Should show RDF serialization (text is split across syntax-highlighted spans)
    await waitFor(() => {
      const pre = document.querySelector('pre');
      expect(pre?.textContent).toMatch(/owl:Ontology/);
    });

    // Copy RDF button should appear
    expect(screen.getByText('Copy RDF')).toBeTruthy();
  });

  it('renders with light theme', async () => {
    const inline = btoa(JSON.stringify(testOntology));
    const config: EmbedConfig = { ontologyInline: inline, theme: 'light', height: '300px' };
    render(<EmbedWidget config={config} />);

    await waitFor(() => {
      expect(screen.getByText('Test Ontology')).toBeTruthy();
    });
    // The component should render without errors in light theme
  });

  it('shows entity/relationship stats in header', async () => {
    const inline = btoa(JSON.stringify(testOntology));
    const config: EmbedConfig = { ontologyInline: inline, theme: 'dark', height: '400px' };
    render(<EmbedWidget config={config} />);

    await waitFor(() => {
      expect(screen.getByText(/2 entities · 1 relationship/)).toBeTruthy();
    });
  });

  it('uses a bounded semantic overview for a massive embedded ontology', async () => {
    const ontology = createLargeOntology();
    const config: EmbedConfig = {
      ontologyInline: btoa(JSON.stringify(ontology)),
      theme: 'dark',
      height: '400px',
    };

    render(<EmbedWidget config={config} />);

    const controls = await screen.findByRole('region', {
      name: 'Large ontology controls',
    });
    expect(controls).toHaveTextContent('Semantic overview');
    expect(controls).toHaveTextContent(/of 350 entities/);
    expect(controls).toHaveTextContent(/of 349 relationships/);
    const detailSlider = screen.getByRole('slider', { name: 'Detail: 1 hop' });
    const search = screen.getByRole('searchbox', { name: 'Jump to an entity' });
    expect(detailSlider).toHaveValue('1');
    expect(detailSlider).toHaveStyle({ width: '100%', minHeight: '44px' });
    expect(search).toHaveStyle({ minHeight: '44px', fontSize: '16px' });
    expect(screen.getByRole('button', { name: 'Find' })).toHaveStyle({
      minHeight: '44px',
    });
    expect(Number(detailSlider.getAttribute('max'))).toBeGreaterThan(1);
    expect(screen.getByRole('button', { name: 'Reset view' })).toBeDisabled();
  });

  it('reveals deep entities through embedded overview search', async () => {
    const ontology = createLargeOntology();
    const config: EmbedConfig = {
      ontologyInline: btoa(JSON.stringify(ontology)),
      theme: 'light',
      height: '400px',
    };
    const user = userEvent.setup();

    render(<EmbedWidget config={config} />);

    const search = await screen.findByRole('searchbox', {
      name: 'Jump to an entity',
    });
    await user.type(search, 'Node 349');
    await user.click(screen.getByRole('button', { name: 'Find' }));

    expect(await screen.findByText('1 matching entity.')).toBeInTheDocument();
  });
});
