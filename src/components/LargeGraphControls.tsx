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
  onSearchInputChange: (value: string) => void;
  onSearch: () => void;
  onDepthChange: (depth: number) => void;
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
  onSearchInputChange,
  onSearch,
  onDepthChange,
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
                placeholder="Name, ID, or description"
              />
              <button type="submit">Find</button>
            </div>
          </form>

          <div className="large-graph-options">
            <label htmlFor="large-graph-depth">
              Detail: <strong>{depth} {depth === 1 ? 'hop' : 'hops'}</strong>
              <span className="large-graph-depth-max">
                {' '}· max {maxDepth}
              </span>
            </label>
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
            <button
              type="button"
              disabled={!canReset}
              onClick={onShowOverview}
            >
              Reset view
            </button>
          </div>

          {appliedSearch && graphView.searchMatchCount > 0 && (
            <p className="large-graph-result">
              {graphView.searchMatchCount.toLocaleString()} matching{' '}
              {graphView.searchMatchCount === 1 ? 'entity' : 'entities'}.
            </p>
          )}
          {appliedSearch && graphView.searchMatchCount === 0 && (
            <p className="large-graph-warning" role="alert">
              No matching entity was found. Showing hierarchy roots instead.
            </p>
          )}
          <p className="large-graph-hint">
            “+N” marks hidden neighbors. Double-click that entity to reveal one
            more hop, or use Search &amp; Filter to jump anywhere.
          </p>
        </>
      )}
    </section>
  );
}
