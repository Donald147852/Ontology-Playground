import { useState, type FormEvent } from 'react';
import type { GraphView } from '../lib/graphView';

interface LargeGraphControlsProps {
  graphView: GraphView;
  totalNodeCount: number;
  totalEdgeCount: number;
  searchInput: string;
  appliedSearch: string;
  depth: number;
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
          <div className="large-graph-tier">Massive ontology mode</div>
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
            <label htmlFor="large-graph-depth">Detail</label>
            <select
              id="large-graph-depth"
              value={depth}
              onChange={(event) => onDepthChange(Number(event.target.value))}
            >
              <option value={1}>1 hop</option>
              <option value={2}>2 hops</option>
              <option value={3}>3 hops</option>
              <option value={4}>4 hops</option>
            </select>
            <button type="button" onClick={onShowOverview}>Overview</button>
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
