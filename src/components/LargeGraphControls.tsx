import { useState, type FormEvent } from 'react';
import type { GraphView } from '../lib/graphView';

interface LargeGraphControlsProps {
  graphView: GraphView;
  totalNodeCount: number;
  totalEdgeCount: number;
  searchInput: string;
  appliedSearch: string;
  depth: number;
  maxDepth: number;
  canReset: boolean;
  selectedEntity: {
    name: string;
    hiddenNeighborCount: number;
    isExpanded: boolean;
  } | null;
  onSearchInputChange: (value: string) => void;
  onSearch: () => void;
  onDepthChange: (depth: number) => void;
  onExpandSelectedEntity: () => void;
  onShowOverview: () => void;
}

export function LargeGraphControls({
  graphView,
  totalNodeCount,
  totalEdgeCount,
  searchInput,
  appliedSearch,
  depth,
  maxDepth,
  canReset,
  selectedEntity,
  onSearchInputChange,
  onSearch,
  onDepthChange,
  onExpandSelectedEntity,
  onShowOverview,
}: LargeGraphControlsProps) {
  const [collapsed, setCollapsed] = useState(false);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    onSearch();
  };

  return (
    <section
      className={`large-graph-panel${collapsed ? ' large-graph-panel--collapsed' : ''}`}
      aria-label="Large ontology controls"
    >
      <div className="large-graph-header">
        <div>
          <div className="large-graph-title">Semantic overview</div>
          <div className="large-graph-tier">Focused hierarchy view</div>
        </div>
        <button
          type="button"
          className="large-graph-collapse"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
        >
          {collapsed ? 'Open' : 'Hide'}
        </button>
      </div>

      {!collapsed && (
        <>
          <p className="large-graph-counts" aria-live="polite">
            Showing {graphView.visibleNodeCount.toLocaleString()} of{' '}
            {totalNodeCount.toLocaleString()} entities and{' '}
            {graphView.visibleEdgeCount.toLocaleString()} of{' '}
            {totalEdgeCount.toLocaleString()} relationships.
          </p>

          <form className="large-graph-search" onSubmit={handleSubmit}>
            <label htmlFor="large-graph-search">Jump to an entity</label>
            <div>
              <input
                id="large-graph-search"
                type="search"
                value={searchInput}
                onChange={(event) => onSearchInputChange(event.target.value)}
                placeholder="Name, ID, or keyword"
              />
              <button type="submit">Find</button>
            </div>
          </form>

          <div className="large-graph-options">
            <div className="large-graph-detail-header">
              <label htmlFor="large-graph-depth">
                Detail: <strong>{depth} {depth === 1 ? 'hop' : 'hops'}</strong>
                <span className="large-graph-depth-max">
                  {' '}· max {maxDepth}
                </span>
              </label>
              <button
                type="button"
                disabled={!canReset}
                onClick={onShowOverview}
              >
                Reset view
              </button>
            </div>
            <input
              id="large-graph-depth"
              type="range"
              min={1}
              max={maxDepth}
              step={1}
              value={depth}
              disabled={maxDepth <= 1}
              onChange={(event) => onDepthChange(Number(event.target.value))}
              aria-label={`Detail: ${depth} ${depth === 1 ? 'hop' : 'hops'}`}
              aria-valuetext={`${depth} ${depth === 1 ? 'hop' : 'hops'}`}
            />
          </div>

          {selectedEntity && (
            <div className="large-graph-selection-action">
              {selectedEntity.hiddenNeighborCount > 0
                && !selectedEntity.isExpanded ? (
                  <button
                    type="button"
                    aria-label={`Show ${selectedEntity.hiddenNeighborCount} hidden ${
                      selectedEntity.hiddenNeighborCount === 1
                        ? 'neighbor'
                        : 'neighbors'
                    } for ${selectedEntity.name}`}
                    onClick={onExpandSelectedEntity}
                  >
                    Show {selectedEntity.hiddenNeighborCount.toLocaleString()}{' '}
                    hidden {selectedEntity.hiddenNeighborCount === 1
                      ? 'neighbor'
                      : 'neighbors'}
                  </button>
                ) : (
                  <p>
                    {selectedEntity.isExpanded
                      ? 'This entity is already expanded.'
                      : 'All of this entity’s neighbors are visible.'}
                  </p>
                )}
            </div>
          )}

          {appliedSearch && (
            <div className="large-graph-status" aria-live="polite">
              {graphView.searchMatchCount > 0 ? (
                <p className="large-graph-result">
                  {graphView.searchMatchCount.toLocaleString()} matching{' '}
                  {graphView.searchMatchCount === 1 ? 'entity' : 'entities'}.
                </p>
              ) : (
                <p className="large-graph-warning" role="alert">
                  No matching entity was found. Showing hierarchy roots instead.
                </p>
              )}
            </div>
          )}
          <p className="large-graph-hint">
            Dashed “+N” entities have hidden neighbors. Select one, then use
            Show neighbors to expand it without losing your place.
          </p>
        </>
      )}
    </section>
  );
}
