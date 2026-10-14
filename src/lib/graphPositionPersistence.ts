import type {
  Core,
  ElementDefinition,
  Position,
} from 'cytoscape';

export interface GraphPositionSnapshot {
  positions: ReadonlyMap<string, Position>;
  zoom: number;
  pan: Position;
  anchorId?: string;
}

interface EdgeEndpoints {
  source: string;
  target: string;
}

function elementId(element: ElementDefinition): string | null {
  return typeof element.data.id === 'string' ? element.data.id : null;
}

function edgeEndpoints(element: ElementDefinition): EdgeEndpoints | null {
  const source = element.data.source;
  const target = element.data.target;
  return typeof source === 'string' && typeof target === 'string'
    ? { source, target }
    : null;
}

function averagePosition(positions: readonly Position[]): Position {
  const total = positions.reduce(
    (sum, position) => ({
      x: sum.x + position.x,
      y: sum.y + position.y,
    }),
    { x: 0, y: 0 },
  );
  return {
    x: total.x / positions.length,
    y: total.y / positions.length,
  };
}

function radialOffset(index: number): Position {
  let ring = 1;
  let slot = index;
  let capacity = 8;

  while (slot >= capacity) {
    slot -= capacity;
    ring += 1;
    capacity = ring * 8;
  }

  const angle = (slot / capacity) * Math.PI * 2;
  const radius = ring * 90;
  return {
    x: Math.cos(angle) * radius,
    y: Math.sin(angle) * radius,
  };
}

export function captureGraphPositionSnapshot(
  cy: Core,
  anchorId?: string,
): GraphPositionSnapshot | null {
  const positions = new Map<string, Position>();
  cy.nodes().forEach((node) => {
    const position = node.position();
    positions.set(node.id(), { x: position.x, y: position.y });
  });

  if (positions.size === 0) return null;

  const pan = cy.pan();
  return {
    positions,
    zoom: cy.zoom(),
    pan: { x: pan.x, y: pan.y },
    anchorId,
  };
}

export function preserveGraphElementPositions(
  elements: readonly ElementDefinition[],
  snapshot: GraphPositionSnapshot,
): ElementDefinition[] | null {
  const visibleNodeIds = new Set(
    elements
      .filter((element) => edgeEndpoints(element) === null)
      .map(elementId)
      .filter((id): id is string => id !== null),
  );
  const assignedPositions = new Map<string, Position>();

  for (const [id, position] of snapshot.positions) {
    if (visibleNodeIds.has(id)) assignedPositions.set(id, position);
  }
  if (assignedPositions.size === 0) return null;

  const adjacency = new Map<string, Set<string>>();
  for (const element of elements) {
    const endpoints = edgeEndpoints(element);
    if (!endpoints) continue;
    if (!adjacency.has(endpoints.source)) adjacency.set(endpoints.source, new Set());
    if (!adjacency.has(endpoints.target)) adjacency.set(endpoints.target, new Set());
    adjacency.get(endpoints.source)?.add(endpoints.target);
    adjacency.get(endpoints.target)?.add(endpoints.source);
  }

  const retainedPositions = [...assignedPositions.values()];
  const anchorPosition = snapshot.anchorId
    ? assignedPositions.get(snapshot.anchorId)
    : undefined;
  const fallbackPosition = anchorPosition ?? averagePosition(retainedPositions);
  let addedNodeIndex = 0;

  return elements.map((element) => {
    if (edgeEndpoints(element)) return element;

    const id = elementId(element);
    if (!id) return element;

    const retainedPosition = assignedPositions.get(id);
    if (retainedPosition) {
      return { ...element, position: retainedPosition };
    }

    const connectedPositions = [...(adjacency.get(id) ?? [])]
      .map((neighborId) => assignedPositions.get(neighborId))
      .filter((position): position is Position => position !== undefined);
    const origin = connectedPositions.length > 0
      ? averagePosition(connectedPositions)
      : fallbackPosition;
    const offset = radialOffset(addedNodeIndex);
    addedNodeIndex += 1;
    const position = {
      x: origin.x + offset.x,
      y: origin.y + offset.y,
    };
    assignedPositions.set(id, position);
    return { ...element, position };
  });
}

export function restoreGraphViewport(
  cy: Core,
  snapshot: GraphPositionSnapshot,
): void {
  cy.zoom(snapshot.zoom);
  cy.pan(snapshot.pan);
}
