import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { useAppStore } from './store/appStore';
import { loadCatalogueEntry } from './lib/catalogue';
import type { LoadedCatalogueEntry } from './types/catalogue';

vi.mock('./hooks/useRoute', () => {
  const route = {
    page: 'catalogue' as const,
    ontologyId: 'official/deep-link-test',
  };
  return { useRoute: () => route };
});

vi.mock('./lib/catalogue', () => ({
  loadCatalogueEntry: vi.fn(),
}));

vi.mock('./components', () => {
  const Stub = () => null;
  return {
    Header: Stub,
    OntologyGraph: Stub,
    QuestPanel: Stub,
    InspectorPanel: Stub,
    QueryPlayground: Stub,
    SearchFilter: Stub,
    WelcomeModal: Stub,
    AboutModal: Stub,
    HelpModal: Stub,
    DataSourcesModal: Stub,
    ImportExportModal: Stub,
    FabricExportModal: Stub,
    GalleryModal: Stub,
    OntologySummaryModal: Stub,
    OntologyDesigner: Stub,
    LearnPage: Stub,
    Toast: Stub,
    CommandPalette: Stub,
    GuidedTour: Stub,
    AppFooter: Stub,
    OntologyStatsPanel: Stub,
    PathFinderPanel: Stub,
    isTourDismissed: () => true,
  };
});

const linkedEntry: LoadedCatalogueEntry = {
  id: 'official/deep-link-test',
  name: 'Deep Link Test',
  description: 'Loaded by a catalogue route',
  category: 'general',
  tags: [],
  author: 'ontology-quest',
  source: 'official',
  entityCount: 1,
  relationshipCount: 0,
  payloadUrl: 'catalogue-payloads/official/deep-link-test/hash.json',
  payloadHash: `sha256:${'a'.repeat(64)}`,
  ontology: {
    name: 'Deep Link Test',
    namespace: 'https://example.com/deep-link-test#',
    entityTypes: [
      {
        id: 'test',
        name: 'Test',
        description: 'A test entity',
        properties: [],
        position: { x: 0, y: 0 },
      },
    ],
    relationships: [],
  },
  bindings: [],
};

describe('catalogue deep links', () => {
  beforeEach(() => {
    vi.mocked(loadCatalogueEntry).mockReset();
  });

  it('loads the linked catalogue entry exactly once', async () => {
    vi.mocked(loadCatalogueEntry).mockResolvedValue(linkedEntry);

    render(<App />);

    await waitFor(() => {
      expect(useAppStore.getState().currentOntology.name).toBe('Deep Link Test');
    });
    expect(loadCatalogueEntry).toHaveBeenCalledTimes(1);
    expect(loadCatalogueEntry).toHaveBeenCalledWith('official/deep-link-test');
  });
});
