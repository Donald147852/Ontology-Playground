import { describe, expect, it } from 'vitest';
import type { ElementDefinition } from 'cytoscape';
import {
  preserveGraphElementPositions,
  type GraphPositionSnapshot,
} from './graphPositionPersistence';

const elements: ElementDefinition[] = [
  { data: { id: 'root' } },
  { data: { id: 'existing' } },
  { data: { id: 'added' } },
  {
    data: {
      id: 'root-existing',
      source: 'root',
      target: 'existing',
    },
  },
  {
    data: {
      id: 'existing-added',
      source: 'existing',
      target: 'added',
    },
  },
];

describe('graph position persistence', () => {
  it('keeps existing nodes fixed and places added neighbors around them', () => {
    const snapshot: GraphPositionSnapshot = {
      positions: new Map([
        ['root', { x: 100, y: 100 }],
        ['existing', { x: 250, y: 100 }],
      ]),
      zoom: 0.8,
      pan: { x: 20, y: 30 },
      anchorId: 'existing',
    };

    const positioned = preserveGraphElementPositions(elements, snapshot);

    expect(positioned).not.toBeNull();
    expect(positioned?.find(({ data }) => data.id === 'root')?.position)
      .toEqual({ x: 100, y: 100 });
    expect(positioned?.find(({ data }) => data.id === 'existing')?.position)
      .toEqual({ x: 250, y: 100 });
    expect(positioned?.find(({ data }) => data.id === 'added')?.position)
      .toEqual({ x: 340, y: 100 });
  });

  it('does not apply stale coordinates to an unrelated graph', () => {
    const snapshot: GraphPositionSnapshot = {
      positions: new Map([['other', { x: 10, y: 10 }]]),
      zoom: 1,
      pan: { x: 0, y: 0 },
    };

    expect(preserveGraphElementPositions(elements, snapshot)).toBeNull();
  });
});
