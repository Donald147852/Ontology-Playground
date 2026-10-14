import { useEffect, useRef, useCallback, useMemo, useState } from 'react';
import cytoscape from 'cytoscape';
import fcose from 'cytoscape-fcose';
import type {
  Core,
  ElementDefinition,
  EventObject,
  LayoutOptions,
} from 'cytoscape';
import { useAppStore } from '../store/appStore';
import { ZoomIn, ZoomOut, Maximize2, RotateCcw, Download, Crosshair } from 'lucide-react';
import {
  BOUNDED_LABEL_ZOOM_THRESHOLD,
  createGraphView,
  DEFAULT_LARGE_GRAPH_DEPTH,
  graphViewMaxDepth,
  type GraphViewMode,
} from '../lib/graphView';
import {
  captureGraphPositionSnapshot,
  preserveGraphElementPositions,
  restoreGraphViewport,
  type GraphPositionSnapshot,
} from '../lib/graphPositionPersistence';
import { LargeGraphControls } from './LargeGraphControls';

// Register fcose layout
cytoscape.use(fcose);

declare global {
  interface Window {
    __ONTOLOGY_PREVIEW_CY__?: Core;
  }
}

type GraphColors = { nodeText: string; edgeColor: string; edgeText: string; edgeLabelBg: string };

const MIN_GRAPH_ZOOM = 0.3;
const MAX_GRAPH_ZOOM = 3;
const GRAPH_ZOOM_STEP = 0.3;

function graphLayoutOptions(
  mode: GraphViewMode,
  rootIds: readonly string[] = [],
): LayoutOptions {
  if (mode === 'bounded') {
    return {
      name: 'breadthfirst',
      directed: false,
      circle: true,
      roots: [...rootIds],
      animate: false,
      fit: true,
      padding: 60,
      spacingFactor: 1.7,
    } as LayoutOptions;
  }

  return {
    name: 'fcose',
    quality: mode === 'dense' ? 'default' : 'proof',
    randomize: true,
    animate: false,
    fit: true,
    padding: 60,
    nodeDimensionsIncludeLabels: true,
    nodeRepulsion: () => mode === 'dense' ? 10_000 : 15_000,
    idealEdgeLength: () => mode === 'dense' ? 150 : 200,
    edgeElasticity: () => 0.45,
    nestingFactor: 0.1,
    gravity: 0.25,
    gravityRange: 3.8,
    numIter: mode === 'dense' ? 1_200 : 2_500,
    tile: true,
    tilingPaddingVertical: 40,
    tilingPaddingHorizontal: 40,
    nodeSeparation: mode === 'dense' ? 70 : 100,
  } as LayoutOptions;
}

// Read graph colors from the active theme's CSS custom properties, falling
// back to the dark/light defaults when the variables can't be resolved yet.
function readGraphColors(darkMode: boolean, el?: HTMLElement | null): GraphColors {
  const fallback: GraphColors = darkMode
    ? { nodeText: '#B3B3B3', edgeColor: '#6E6E6E', edgeText: '#9CA0A8', edgeLabelBg: '#15161D' }
    : { nodeText: '#2A2A2A', edgeColor: '#888888', edgeText: '#555555', edgeLabelBg: '#F2F2F2' };
  const source = el ?? (typeof document !== 'undefined' ? document.querySelector<HTMLElement>('.app-container') : null);
  if (!source) return fallback;
  const cs = getComputedStyle(source);
  return {
    nodeText: cs.getPropertyValue('--graph-node-text').trim() || fallback.nodeText,
    edgeColor: cs.getPropertyValue('--graph-edge-color').trim() || fallback.edgeColor,
    edgeText: cs.getPropertyValue('--graph-edge-text').trim() || fallback.edgeText,
    edgeLabelBg: cs.getPropertyValue('--graph-edge-label-bg').trim() || fallback.edgeLabelBg,
  };
}

export function OntologyGraph() {
  const cyRef = useRef<Core | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  const focusNodeIdRef = useRef<string | null>(null);
  const [largeSearchInput, setLargeSearchInput] = useState('');
  const [largeSearch, setLargeSearch] = useState('');
  const [largeDepth, setLargeDepth] = useState(DEFAULT_LARGE_GRAPH_DEPTH);
  const [expandedNodeIds, setExpandedNodeIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [graphZoom, setGraphZoom] = useState(MIN_GRAPH_ZOOM);
  const pendingPositionSnapshotRef = useRef<GraphPositionSnapshot | null>(null);
  
  // Helper to safely get cytoscape instance - returns null if destroyed
  const getCy = useCallback(() => {
    const cy = cyRef.current;
    if (!cy || !mountedRef.current) return null;
    // Check if cy is still mounted (destroyed instances have no container)
    try {
      if (!cy.container()) return null;
    } catch {
      return null;
    }
    return cy;
  }, []);

  const preserveCurrentGraphPosition = useCallback((anchorId?: string) => {
    const cy = getCy();
    pendingPositionSnapshotRef.current = cy
      ? captureGraphPositionSnapshot(cy, anchorId)
      : null;
  }, [getCy]);
  
  const {
    currentOntology,
    selectedEntityId,
    selectedRelationshipId,
    highlightedEntities,
    highlightedRelationships,
    selectEntity,
    selectRelationship,
    clearHighlights,
    activeQuest,
    currentStepIndex,
    advanceQuestStep,
    darkMode,
    theme
  } = useAppStore();
  const selectedGraphItemRef = useRef({
    entityId: selectedEntityId,
    relationshipId: selectedRelationshipId,
  });
  useEffect(() => {
    selectedGraphItemRef.current = {
      entityId: selectedEntityId,
      relationshipId: selectedRelationshipId,
    };
  }, [selectedEntityId, selectedRelationshipId]);

  const applySelectionState = useCallback((cy: Core) => {
    const { entityId, relationshipId } = selectedGraphItemRef.current;

    if (focusNodeIdRef.current !== null) {
      cy.elements().unselect();
      if (entityId) cy.getElementById(entityId).select();
      if (relationshipId) cy.getElementById(relationshipId).select();
      return;
    }

    cy.elements().removeClass('highlighted dimmed');
    cy.elements().unselect();

    if (entityId) {
      const node = cy.getElementById(entityId);
      node.select();
      const connectedEdges = node.connectedEdges();
      const connectedNodes = connectedEdges.connectedNodes();

      cy.elements().addClass('dimmed');
      node.removeClass('dimmed');
      connectedEdges.removeClass('dimmed');
      connectedNodes.removeClass('dimmed');
    }

    if (relationshipId) {
      const edge = cy.getElementById(relationshipId);
      edge.select();
      const connectedNodes = edge.connectedNodes();

      cy.elements().addClass('dimmed');
      edge.removeClass('dimmed');
      connectedNodes.removeClass('dimmed');
    }
  }, []);

  const baseGraphView = useMemo(
    () => createGraphView(currentOntology, {
      search: largeSearch,
      depth: largeDepth,
      expandedNodeIds,
    }),
    [
      currentOntology,
      expandedNodeIds,
      largeDepth,
      largeSearch,
    ],
  );
  const graphView = useMemo(() => {
    const visibleEntityIds = new Set(
      baseGraphView.entities.map((entity) => entity.id),
    );
    const visibleRelationshipIds = new Set(
      baseGraphView.relationships.map((relationship) => relationship.id),
    );
    const revealEntityIds = [
      ...(selectedEntityId && !visibleEntityIds.has(selectedEntityId)
        ? [selectedEntityId]
        : []),
      ...highlightedEntities.filter((id) => !visibleEntityIds.has(id)),
    ];
    const revealRelationshipIds = [
      ...(selectedRelationshipId
        && !visibleRelationshipIds.has(selectedRelationshipId)
        ? [selectedRelationshipId]
        : []),
      ...highlightedRelationships.filter(
        (id) => !visibleRelationshipIds.has(id),
      ),
    ];

    if (
      revealEntityIds.length === 0
      && revealRelationshipIds.length === 0
    ) {
      return baseGraphView;
    }

    return createGraphView(currentOntology, {
      search: largeSearch,
      depth: largeDepth,
      expandedNodeIds: [...expandedNodeIds, ...revealEntityIds],
      priorityRelationshipIds: revealRelationshipIds,
    });
  }, [
      baseGraphView,
      currentOntology,
      expandedNodeIds,
      highlightedEntities,
      highlightedRelationships,
      largeDepth,
      largeSearch,
      selectedEntityId,
      selectedRelationshipId,
  ]);
  const isBoundedView = graphView.mode === 'bounded';
  const maxLargeDepth = useMemo(
    () => graphViewMaxDepth(currentOntology),
    [currentOntology],
  );
  const selectedOverviewEntity = useMemo(() => {
    if (!selectedEntityId) return null;
    const entity = graphView.entities.find(
      (candidate) => candidate.id === selectedEntityId,
    );
    if (!entity) return null;
    return {
      id: entity.id,
      name: entity.name,
      hiddenNeighborCount:
        graphView.hiddenNeighborCounts.get(entity.id) ?? 0,
      isExpanded: expandedNodeIds.has(entity.id),
    };
  }, [
    expandedNodeIds,
    graphView.entities,
    graphView.hiddenNeighborCounts,
    selectedEntityId,
  ]);
  const graphRootIds = useMemo(() => {
    const visibleIds = new Set(graphView.entities.map((entity) => entity.id));
    const visibleRootIds = graphView.rootIds.filter((id) => visibleIds.has(id));
    if (visibleRootIds.length > 0) return visibleRootIds;
    return graphView.entities[0] ? [graphView.entities[0].id] : [];
  }, [graphView.entities, graphView.rootIds]);
  const graphOntologyRef = useRef(currentOntology);

  useEffect(() => {
    if (graphOntologyRef.current === currentOntology) return;
    graphOntologyRef.current = currentOntology;
    setLargeSearchInput('');
    setLargeSearch('');
    setLargeDepth(DEFAULT_LARGE_GRAPH_DEPTH);
    setExpandedNodeIds(new Set());
    setFocusNodeId(null);
    pendingPositionSnapshotRef.current = null;
  }, [currentOntology]);

  // Use refs for quest state to avoid re-creating the graph when quest changes
  const activeQuestRef = useRef(activeQuest);
  const currentStepIndexRef = useRef(currentStepIndex);
  const advanceQuestStepRef = useRef(advanceQuestStep);
  
  // Keep refs in sync
  useEffect(() => {
    activeQuestRef.current = activeQuest;
    currentStepIndexRef.current = currentStepIndex;
    advanceQuestStepRef.current = advanceQuestStep;
  }, [activeQuest, currentStepIndex, advanceQuestStep]);
  
  // Theme-aware colors, sourced from the active theme's CSS variables so each
  // theme (including the derived ones) renders with its own graph palette.
  const [themeColors, setThemeColors] = useState<GraphColors>(() => readGraphColors(darkMode));
  useEffect(() => {
    setThemeColors(readGraphColors(darkMode, containerRef.current));
  }, [theme, darkMode]);

  const graphThemeColors = useRef(themeColors);
  useEffect(() => {
    graphThemeColors.current = themeColors;
  }, [themeColors]);

  const buildElements = useCallback((): ElementDefinition[] => {
    const rootIds = new Set(graphView.rootIds);
    const nodes = graphView.entities.map((entity) => {
      const hiddenNeighborCount = graphView.hiddenNeighborCounts.get(entity.id) ?? 0;
      return {
        data: {
          id: entity.id,
          label: `${entity.icon} ${entity.name}${hiddenNeighborCount > 0 ? ` · +${hiddenNeighborCount}` : ''}`,
          name: entity.name,
          icon: entity.icon,
          color: entity.color,
          description: entity.description,
          hiddenNeighborCount,
          isRoot: rootIds.has(entity.id) ? 1 : 0,
          type: 'entity'
        }
      };
    });

    const nodeIds = new Set(nodes.map(n => n.data.id));

    const edges = graphView.relationships
      .filter(rel => rel.from && rel.to && nodeIds.has(rel.from) && nodeIds.has(rel.to))
      .map(rel => ({
        data: {
          id: rel.id,
          source: rel.from,
          target: rel.to,
          label: rel.name,
          cardinality: rel.cardinality,
          description: rel.description,
          kind: rel.kind ?? 'association',
          type: 'relationship'
        }
      }));

    return [...nodes, ...edges];
  }, [graphView]);

  // Initialize Cytoscape
  useEffect(() => {
    if (!containerRef.current) return;

    const baseElements = buildElements();
    const positionSnapshot = isBoundedView
      ? pendingPositionSnapshotRef.current
      : null;
    const positionedElements = positionSnapshot
      ? preserveGraphElementPositions(baseElements, positionSnapshot)
      : null;

    const cy = cytoscape({
      container: containerRef.current,
      elements: positionedElements ?? baseElements,
      style: [
        // Base node style
        {
          selector: 'node',
          style: {
            'label': 'data(label)',
            'text-valign': 'bottom',
            'text-halign': 'center',
            'font-size': '14px',
            'font-family': 'Segoe UI, sans-serif',
            'font-weight': 600,
            'min-zoomed-font-size': 9,
            'color': graphThemeColors.current.nodeText,
            'text-margin-y': 10,
            'width': graphView.mode === 'bounded' ? 34 : 70,
            'height': graphView.mode === 'bounded' ? 34 : 70,
            'background-color': 'data(color)',
            'border-width': 3,
            'border-color': 'data(color)',
            'border-opacity': 0.5,
            'transition-property': 'border-width, border-color, width, height',
            'transition-duration': 200
          }
        },
        {
          selector: 'node.overview-label-hidden',
          style: {
            'label': ''
          }
        },
        {
          selector: 'node[hiddenNeighborCount > 0]',
          style: {
            'border-style': 'dashed',
            'border-width': 5,
            'width': 42,
            'height': 42,
            'min-zoomed-font-size': 8
          }
        },
        {
          selector: 'node[isRoot = 1]',
          style: {
            'border-style': 'solid',
            'border-width': 5,
            'width': 58,
            'height': 58,
            'font-size': '16px',
            'min-zoomed-font-size': 8
          }
        },
        // Selected node
        {
          selector: 'node:selected',
          style: {
            'border-width': 5,
            'border-color': '#0078D4',
            'width': graphView.mode === 'bounded' ? 58 : 85,
            'height': graphView.mode === 'bounded' ? 58 : 85,
            'label': 'data(label)',
            'min-zoomed-font-size': 0
          }
        },
        // Highlighted node
        {
          selector: 'node.highlighted',
          style: {
            'border-width': 4,
            'border-color': '#FFB900',
            'width': graphView.mode === 'bounded' ? 54 : 80,
            'height': graphView.mode === 'bounded' ? 54 : 80,
            'label': 'data(label)',
            'min-zoomed-font-size': 0
          }
        },
        // Dimmed node
        {
          selector: 'node.dimmed',
          style: {
            'opacity': 0.3
          }
        },
        // Base edge style
        {
          selector: 'edge',
          style: {
            'label': graphView.mode === 'full' ? 'data(label)' : '',
            'font-size': '11px',
            'font-family': 'Segoe UI, sans-serif',
            'min-zoomed-font-size': 9,
            'color': graphThemeColors.current.edgeText,
            'text-rotation': 'autorotate',
            'text-margin-y': -10,
            'text-wrap': 'ellipsis',
            'text-max-width': '120px',
            'text-background-color': graphThemeColors.current.edgeLabelBg,
            'text-background-opacity': 1,
            'text-background-padding': '2px',
            'text-background-shape': 'roundrectangle',
            'width': 3,
            'line-color': graphThemeColors.current.edgeColor,
            'target-arrow-color': graphThemeColors.current.edgeColor,
            'target-arrow-shape': 'triangle',
            'curve-style': 'unbundled-bezier',
            'control-point-step-size': 40,
            'edge-distances': 'node-position',
            'transition-property': 'width, line-color, target-arrow-color',
            'transition-duration': 200
          }
        },
        {
          selector: 'edge[kind = "subclass"]',
          style: {
            'line-style': 'dashed',
          }
        },
        // Selected edge
        {
          selector: 'edge:selected',
          style: {
            'width': 5,
            'line-color': '#0078D4',
            'target-arrow-color': '#0078D4',
            'color': '#0078D4',
            'label': 'data(label)'
          }
        },
        // Highlighted edge
        {
          selector: 'edge.highlighted',
          style: {
            'width': 4,
            'line-color': '#FFB900',
            'target-arrow-color': '#FFB900',
            'color': '#FFB900',
            'label': 'data(label)'
          }
        },
        // Dimmed edge
        {
          selector: 'edge.dimmed',
          style: {
            'opacity': 0.2
          }
        }
      ],
       
      layout: positionedElements
        ? { name: 'preset', fit: false }
        : graphLayoutOptions(graphView.mode, graphRootIds),
      minZoom: MIN_GRAPH_ZOOM,
      maxZoom: MAX_GRAPH_ZOOM
    });

    if (positionSnapshot && positionedElements) {
      restoreGraphViewport(cy, positionSnapshot);
    }
    pendingPositionSnapshotRef.current = null;

    let boundedLabelsHidden: boolean | null = null;
    const syncBoundedLabels = () => {
      if (!isBoundedView) return;
      const shouldHide = cy.zoom() < BOUNDED_LABEL_ZOOM_THRESHOLD;
      if (shouldHide === boundedLabelsHidden) return;
      boundedLabelsHidden = shouldHide;
      cy.nodes('[isRoot = 0][hiddenNeighborCount = 0]')
        .toggleClass('overview-label-hidden', shouldHide);
    };
    const syncZoomState = () => {
      syncBoundedLabels();
      setGraphZoom(cy.zoom());
    };
    cy.on('zoom', syncZoomState);
    syncZoomState();

    // Event handlers
    cy.on('tap', 'node', (evt: EventObject) => {
      const nodeId = evt.target.id();
      selectEntity(nodeId);
      
      // Check if this advances a quest step (use refs to avoid re-creating graph)
      const quest = activeQuestRef.current;
      const stepIndex = currentStepIndexRef.current;
      if (quest) {
        const currentStep = quest.steps[stepIndex];
        if (currentStep.targetType === 'entity' && currentStep.targetId === nodeId) {
          advanceQuestStepRef.current();
        }
      }
    });

    cy.on('tap', 'edge', (evt: EventObject) => {
      const edgeId = evt.target.id();
      selectRelationship(edgeId);
      
      // Check if this advances a quest step (use refs to avoid re-creating graph)
      const quest = activeQuestRef.current;
      const stepIndex = currentStepIndexRef.current;
      if (quest) {
        const currentStep = quest.steps[stepIndex];
        if (currentStep.targetType === 'relationship' && currentStep.targetId === edgeId) {
          advanceQuestStepRef.current();
        }
      }
    });

    cy.on('tap', (evt: EventObject) => {
      if (evt.target === cy) {
        // Exit focus mode BEFORE clearing selection so the selection effect
        // doesn't see a stale focusNodeIdRef and skip its dimmed cleanup
        if (focusNodeIdRef.current !== null) {
          focusNodeIdRef.current = null;
          setFocusNodeId(null);
          getCy()?.elements().removeClass('dimmed focus-hidden');
        }
        selectEntity(null);
        selectRelationship(null);
      }
    });

    cy.on('dbltap', 'node', (evt: EventObject) => {
      const nodeId = evt.target.id();
      if (isBoundedView) return;

      const alreadyFocused = focusNodeIdRef.current === nodeId;

      if (alreadyFocused) {
        // Toggle off
        focusNodeIdRef.current = null;
        setFocusNodeId(null);
        cy.elements().removeClass('dimmed focus-hidden');
      } else {
        focusNodeIdRef.current = nodeId;
        setFocusNodeId(nodeId);
        const node = cy.getElementById(nodeId);
        const neighbourhood = node.closedNeighborhood();
        cy.elements().addClass('dimmed');
        neighbourhood.removeClass('dimmed');
      }
    });

    cyRef.current = cy;
    window.__ONTOLOGY_PREVIEW_CY__ = cy;
    mountedRef.current = true;
    applySelectionState(cy);

    return () => {
      mountedRef.current = false;
      if (window.__ONTOLOGY_PREVIEW_CY__ === cy) {
        delete window.__ONTOLOGY_PREVIEW_CY__;
      }
      cy.destroy();
      cyRef.current = null;
    };
  }, [
    applySelectionState,
    buildElements,
    getCy,
    graphView.mode,
    graphRootIds,
    isBoundedView,
    selectEntity,
    selectRelationship,
  ]);

  // Keep focusNodeIdRef in sync with state
  useEffect(() => {
    focusNodeIdRef.current = focusNodeId;
  }, [focusNodeId]);

  // Re-apply focus neighbourhood when focusNodeId changes
  useEffect(() => {
    const cy = getCy();
    if (!cy) return;
    if (focusNodeId === null) {
      cy.elements().removeClass('dimmed');
    } else {
      const node = cy.getElementById(focusNodeId);
      if (node.length) {
        cy.elements().addClass('dimmed');
        node.closedNeighborhood().removeClass('dimmed');
      }
    }
  }, [focusNodeId, getCy]);

  // Update graph colors when theme changes (without recreating graph)
  useEffect(() => {
    const cy = getCy();
    if (!cy) return;

    try {
      // Apply text-color update to ALL edges/nodes (text colors don't affect highlight line-color)
      cy.$('node').style({ 'color': themeColors.nodeText });
      cy.$('edge').style({ 'color': themeColors.edgeText, 'text-background-color': themeColors.edgeLabelBg, 'text-background-opacity': 1 });
      // Line/arrow colors: only update non-highlighted edges so path-finder highlights survive
      cy.edges().not('.highlighted').style({
        'line-color': themeColors.edgeColor,
        'target-arrow-color': themeColors.edgeColor,
      });
    } catch {
      // Graph may have been destroyed
    }
  }, [themeColors, darkMode, getCy]);

  // Handle selection changes
  useEffect(() => {
    const cy = getCy();
    if (!cy) return;
    applySelectionState(cy);
  }, [
    applySelectionState,
    getCy,
    selectedEntityId,
    selectedRelationshipId,
  ]);

  // Handle highlights from queries
  useEffect(() => {
    const cy = getCy();
    if (!cy) return;

    try {
      // Clear previous highlights and restore theme line colors on previously-highlighted edges
      cy.$('edge.highlighted').style({
        'line-color': themeColors.edgeColor,
        'target-arrow-color': themeColors.edgeColor,
      });
      cy.elements().removeClass('highlighted');

      highlightedEntities.forEach(id => {
        cy.getElementById(id).addClass('highlighted');
      });

      highlightedRelationships.forEach(id => {
        const el = cy.getElementById(id);
        el.addClass('highlighted');
        // Force bypass so it overrides any theme update residue
        el.style({ 'line-color': '#FFB900', 'target-arrow-color': '#FFB900' });
      });
    } catch {
      // Graph may have been destroyed
    }
  }, [highlightedEntities, highlightedRelationships, themeColors, getCy]);

  // Graph controls
  const changeZoom = (delta: number) => {
    const cy = getCy();
    if (!cy) return;
    try {
      const nextZoom = Math.min(
        MAX_GRAPH_ZOOM,
        Math.max(MIN_GRAPH_ZOOM, cy.zoom() + delta),
      );
      cy.zoom({
        level: Number(nextZoom.toFixed(2)),
        renderedPosition: {
          x: cy.width() / 2,
          y: cy.height() / 2,
        },
      });
    } catch { /* ignore */ }
  };

  const handleZoomIn = () => {
    changeZoom(GRAPH_ZOOM_STEP);
  };

  const handleZoomOut = () => {
    changeZoom(-GRAPH_ZOOM_STEP);
  };

  const handleFit = () => {
    const cy = getCy();
    if (cy) {
      try {
        cy.fit(undefined, 60);
      } catch { /* ignore */ }
    }
  };

  const handleReset = () => {
    const cy = getCy();
    if (cy) {
      try {
        cy.layout(
          graphLayoutOptions(
            graphView.mode,
            graphRootIds,
          ) as Parameters<Core['layout']>[0],
        ).run();
      } catch { /* ignore */ }
    }
  };

  const handleLargeSearch = () => {
    pendingPositionSnapshotRef.current = null;
    setLargeSearch(largeSearchInput.trim());
    setExpandedNodeIds(new Set());
    selectEntity(null);
    selectRelationship(null);
    clearHighlights();
  };

  const handleShowOverview = () => {
    pendingPositionSnapshotRef.current = null;
    setLargeSearchInput('');
    setLargeSearch('');
    setLargeDepth(DEFAULT_LARGE_GRAPH_DEPTH);
    setExpandedNodeIds(new Set());
    selectEntity(null);
    selectRelationship(null);
    clearHighlights();
  };

  const handleLargeDepthChange = (nextDepth: number) => {
    if (nextDepth === largeDepth) return;
    preserveCurrentGraphPosition();
    setLargeDepth(nextDepth);
  };

  const handleExpandSelectedEntity = () => {
    if (
      !selectedOverviewEntity
      || selectedOverviewEntity.hiddenNeighborCount === 0
      || selectedOverviewEntity.isExpanded
    ) {
      return;
    }

    preserveCurrentGraphPosition(selectedOverviewEntity.id);
    setExpandedNodeIds((current) => {
      if (current.has(selectedOverviewEntity.id)) return current;
      return new Set(current).add(selectedOverviewEntity.id);
    });
  };

  const handleDownload = () => {
    const cy = getCy();
    if (!cy) return;
    try {
      const graphCs = containerRef.current ? getComputedStyle(containerRef.current) : null;
      const bg = (graphCs && graphCs.getPropertyValue('--graph-bg').trim()) || (darkMode ? '#1E1E1E' : '#F5F5F5');
      const pngData = cy.png({ scale: 2, full: true, bg });
      const link = document.createElement('a');
      link.href = pngData;
      const safeName = (currentOntology.name || 'ontology').toLowerCase().replace(/\s+/g, '-');
      link.download = `${safeName}-graph.png`;
      link.click();
    } catch { /* ignore */ }
  };

  const legendLimit = isBoundedView ? 8 : 100;
  const legendEntities = graphView.entities.slice(0, legendLimit);
  const hiddenLegendCount = graphView.entities.length - legendEntities.length;
  const canResetLargeView = (
    largeSearch !== ''
    || largeDepth !== DEFAULT_LARGE_GRAPH_DEPTH
    || expandedNodeIds.size > 0
    || selectedEntityId !== null
    || selectedRelationshipId !== null
    || highlightedEntities.length > 0
    || highlightedRelationships.length > 0
  );

  return (
    <div className="graph-container">
      <div ref={containerRef} className="graph-canvas" data-testid="ontology-graph-canvas" />

      {isBoundedView && (
        <LargeGraphControls
          graphView={graphView}
          totalNodeCount={currentOntology.entityTypes.length}
          totalEdgeCount={currentOntology.relationships.length}
          searchInput={largeSearchInput}
          appliedSearch={largeSearch}
          depth={largeDepth}
          maxDepth={maxLargeDepth}
          canReset={canResetLargeView}
          selectedEntity={selectedOverviewEntity}
          onSearchInputChange={setLargeSearchInput}
          onSearch={handleLargeSearch}
          onDepthChange={handleLargeDepthChange}
          onExpandSelectedEntity={handleExpandSelectedEntity}
          onShowOverview={handleShowOverview}
        />
      )}

      {focusNodeId && !isBoundedView && (
        <div className="graph-focus-badge">
          <Crosshair size={13} />
          <span>Focus mode</span>
          <button
            className="graph-focus-exit"
            onClick={() => {
              setFocusNodeId(null);
              const cy = getCy();
              if (cy) cy.elements().removeClass('dimmed');
            }}
          >
            Click background or ✕ to exit
          </button>
        </div>
      )}
      
      <div className="graph-controls">
        <button
          className="graph-control-btn"
          onClick={handleZoomIn}
          title="Zoom In"
          disabled={graphZoom >= MAX_GRAPH_ZOOM - 0.001}
        >
          <ZoomIn size={18} />
        </button>
        <button
          className="graph-control-btn"
          onClick={handleZoomOut}
          title="Zoom Out"
          disabled={graphZoom <= MIN_GRAPH_ZOOM + 0.001}
        >
          <ZoomOut size={18} />
        </button>
        <button className="graph-control-btn" onClick={handleFit} title="Fit to View">
          <Maximize2 size={18} />
        </button>
        <button className="graph-control-btn" onClick={handleReset} title="Reset Layout">
          <RotateCcw size={18} />
        </button>
        <button className="graph-control-btn" onClick={handleDownload} title="Download Graph as PNG" data-testid="download-ontology-png">
          <Download size={18} />
        </button>
      </div>

      {!isBoundedView && (
        <div className="graph-legend">
          <div className="legend-title">Entity Types</div>
          {legendEntities.map(entity => (
            <div key={entity.id} className="legend-item">
              <div className="legend-dot" style={{ backgroundColor: entity.color }} />
              <span>{entity.icon} {entity.name}</span>
            </div>
          ))}
          {hiddenLegendCount > 0 && (
            <div className="legend-item">
              <span>+ {hiddenLegendCount} more visible in the graph</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
