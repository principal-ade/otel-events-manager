# Metrics Backend Design: Push Model Architecture

This document describes the architecture for transforming otel-events-manager into a full metrics backend that receives FileTree updates from the desktop app and processes OTEL traces with workflow/scenario matching.

**Related Documents**:
- [LOCAL_METRICS_STORAGE_DESIGN.md](../../../visual-validation/principal-view-core-library/docs/LOCAL_METRICS_STORAGE_DESIGN.md) - Storage and aggregation patterns
- [DASHBOARD_METRICS_DESIGN.md](../../../visual-validation/principal-view-core-library/docs/DASHBOARD_METRICS_DESIGN.md) - Dashboard schema

---

## Overview

### Current State

otel-events-manager currently:
- Receives OTLP traces via HTTP (`POST /v1/traces`)
- Stores raw spans in SQLite
- Displays spans in a simple UI with service filtering

### Target State

Transform into a metrics backend that:
- Receives FileTree updates from the desktop app (push model)
- Matches incoming traces against workflows/scenarios using `@principal-ai/principal-view-core`
- Stores matched traces with full context (storyboard, workflow, scenario)
- Computes and stores pre-aggregated metrics for dashboards
- Provides query API for dashboard rendering

### Why Push Model?

| Approach | Pros | Cons |
|----------|------|------|
| **Push (chosen)** | Desktop app already watches files; single source of truth; instant updates | Requires desktop app running |
| Pull on-demand | Self-contained | Adds latency; may miss rapid changes |
| Self-contained monitoring | No dependencies | Duplicates file watching; more resources |

The push model leverages existing infrastructure in the desktop app while keeping the metrics backend focused on trace processing and storage.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Desktop App                                     │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  RepositoryMonitoringManager                                         │    │
│  │  - Watches registered repositories                                   │    │
│  │  - Builds FileTree on changes                                        │    │
│  │  - Tracks .principal-views/ directories                              │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                    │                                         │
│                                    │ On workspace change / .principal-views  │
│                                    │ file change                             │
│                                    ▼                                         │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  MetricsBackendBridge (new)                                          │    │
│  │  - Pushes FileTree to metrics backend                                │    │
│  │  - Manages connection lifecycle                                      │    │
│  │  - Handles reconnection                                              │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     │ HTTP POST /api/registry/sync
                                     │ (FileTree + metadata)
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Metrics Backend (otel-events-manager)                │
│                                                                              │
│  ┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐    │
│  │ Registry Sync    │────▶│ LocalRegistry    │     │ OTLP Receiver    │    │
│  │ Endpoint         │     │ (@principal-ai/  │     │ (existing)       │    │
│  │ POST /api/       │     │  core)           │     │ POST /v1/traces  │    │
│  │ registry/sync    │     │                  │     │                  │    │
│  └──────────────────┘     └────────┬─────────┘     └────────┬─────────┘    │
│                                    │                         │              │
│                                    │ lookupByScope()         │ OTLP data   │
│                                    ▼                         ▼              │
│                           ┌──────────────────────────────────────┐         │
│                           │ TraceOrchestrator                     │         │
│                           │ (@principal-ai/core)                  │         │
│                           │ - Matches spans to workflows          │         │
│                           │ - Matches events to scenarios         │         │
│                           │ - Returns RegisteredTrace             │         │
│                           └──────────────────────────────────────┘         │
│                                          │                                  │
│                                          │ RegisteredTrace                  │
│                                          ▼                                  │
│                           ┌──────────────────────────────────────┐         │
│                           │ MetricsIngestionService (new)         │         │
│                           │ - Routes to metrics via sourceIndex   │         │
│                           │ - Stores raw events                   │         │
│                           │ - Updates rollup aggregates           │         │
│                           └──────────────────────────────────────┘         │
│                                          │                                  │
│                                          ▼                                  │
│                           ┌──────────────────────────────────────┐         │
│                           │ SQLite Storage                        │         │
│                           │ - span_events (raw, 24h retention)    │         │
│                           │ - metric_rollups (aggregated)         │         │
│                           │ - registered_traces (matched traces)  │         │
│                           │ - registry_state (synced FileTrees)   │         │
│                           └──────────────────────────────────────┘         │
│                                          │                                  │
│                                          ▼                                  │
│                           ┌──────────────────────────────────────┐         │
│                           │ Query API                             │         │
│                           │ GET /api/metrics                      │         │
│                           │ GET /api/traces                       │         │
│                           │ GET /api/services                     │         │
│                           └──────────────────────────────────────┘         │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Push Protocol

### Registry Sync Endpoint

```
POST /api/registry/sync
Content-Type: application/json

{
  "action": "update" | "remove",
  "workspace": {
    "id": string,              // Workspace identifier
    "rootPath": string,        // Local filesystem path
    "sha": string              // Content hash for change detection
  },
  "fileTree": FileTree,        // From @principal-ai/repository-abstraction
  "timestamp": number          // Unix milliseconds
}
```

### When to Push

The desktop app pushes FileTree updates when:

1. **Initial registration**: Workspace is registered for monitoring
2. **File changes in `.principal-views/`**: Storyboard, workflow, or canvas files change
3. **`library.yaml` changes**: Owned scopes or service configuration changes
4. **Periodic sync**: Every N minutes as heartbeat (configurable)

### Push Events from Desktop App

```typescript
// In desktop app: MetricsBackendBridge

interface MetricsBackendBridge {
  /**
   * Push FileTree update to metrics backend
   */
  pushRegistryUpdate(workspace: {
    id: string;
    rootPath: string;
    sha: string;
    fileTree: FileTree;
  }): Promise<void>;

  /**
   * Notify metrics backend that workspace was removed
   */
  pushRegistryRemoval(workspaceId: string): Promise<void>;

  /**
   * Check if metrics backend is available
   */
  isConnected(): boolean;
}
```

### Response from Metrics Backend

```typescript
interface RegistrySyncResponse {
  success: boolean;
  registeredScopes: string[];  // Scopes discovered from this FileTree
  error?: string;
}
```

---

## Registry Integration

### LocalRegistry Setup

The metrics backend maintains a `LocalRegistry` instance from `@principal-ai/principal-view-core`:

```typescript
import { LocalRegistry, InMemoryFileSystemAdapter } from '@principal-ai/principal-view-core';
import type { FileTree } from '@principal-ai/repository-abstraction';

class RegistryManager {
  private registry: LocalRegistry;
  private workspaces: Map<string, { sha: string; scopeNames: string[] }>;

  constructor() {
    this.registry = new LocalRegistry(
      (path) => this.readFile(path),  // File reader function
      fsAdapter                        // FileSystemAdapter for discovery
    );
    this.workspaces = new Map();
  }

  /**
   * Handle incoming FileTree sync from desktop app
   */
  async syncWorkspace(
    workspaceId: string,
    fileTree: FileTree
  ): Promise<string[]> {
    // Check if content changed
    const existing = this.workspaces.get(workspaceId);
    if (existing?.sha === fileTree.sha) {
      return existing.scopeNames; // No changes
    }

    // Register/update workspace in LocalRegistry
    const scopeNames = await this.registry.registerWorkspace(fileTree);

    // Track for change detection
    this.workspaces.set(workspaceId, {
      sha: fileTree.sha || '',
      scopeNames
    });

    // Invalidate caches for affected scopes
    for (const scopeName of scopeNames) {
      this.registry.invalidateCache(scopeName);
    }

    return scopeNames;
  }

  /**
   * Get registry for TraceOrchestrator
   */
  getRegistry(): LocalRegistry {
    return this.registry;
  }
}
```

### File Reading Strategy

The metrics backend needs to read files from the FileTree. Options:

**Option A: FileTree includes content**
- Desktop app includes file contents in FileTree
- Pro: No additional reads needed
- Con: Larger payloads

**Option B: Read on-demand via API**
- Metrics backend requests file content from desktop app
- Pro: Smaller sync payloads
- Con: Additional round trips

**Option C: FileTree with lazy loading**
- FileTree includes paths; content fetched when needed
- Desktop app exposes `GET /api/files/:path` endpoint
- Balance between payload size and round trips

**Recommendation**: Start with Option A (include content) for `.principal-views/` files since they're small and always needed. Large files can use lazy loading later.

---

## Trace Processing Pipeline

### Enhanced OTLP Ingestion

```typescript
// Modified OTLP handler in metrics backend

import { TraceOrchestrator } from '@principal-ai/principal-view-core';

async function handleOtlpTraces(otlpData: OtelExportTraceServiceRequest): Promise<void> {
  // 1. Check if registry is ready
  const registry = registryManager.getRegistry();
  const scopes = await registry.listScopes();

  if (scopes.length === 0) {
    // No workspaces registered yet - store as unmatched
    await storeUnmatchedTrace(otlpData);
    return;
  }

  // 2. Process through TraceOrchestrator
  const orchestrator = new TraceOrchestrator({ registry });
  const registeredTrace = await orchestrator.processTrace(otlpData);

  // 3. Store the matched trace
  await storeRegisteredTrace(registeredTrace);

  // 4. Update metrics (if dashboard definitions exist)
  if (dashboardsLoaded) {
    await metricsIngestionService.ingestTrace(registeredTrace);
  }

  // 5. Notify UI of new data
  notifyNewTrace(registeredTrace);
}
```

### Trace Categories

After processing, traces fall into three categories:

| Category | What it means | Storage |
|----------|---------------|---------|
| **Scenario Match** | Span matched workflow + scenario | Full context stored |
| **Storyboard Match** | Span matched workflow, no scenario | Stored as orphaned |
| **Unmatched** | No workflow matched | Stored for debugging |

---

## Database Schema

### Extended Schema

Building on existing `spans` table, add:

```sql
-- ============================================================================
-- REGISTERED TRACES
-- Traces that have been processed through TraceOrchestrator
-- ============================================================================

CREATE TABLE registered_traces (
  trace_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  start_time INTEGER NOT NULL,
  end_time INTEGER NOT NULL,
  duration_ms REAL NOT NULL,
  span_count INTEGER NOT NULL,
  has_errors INTEGER DEFAULT 0,

  -- Matching summary
  scenario_match_count INTEGER DEFAULT 0,
  storyboard_match_count INTEGER DEFAULT 0,
  unmatched_span_count INTEGER DEFAULT 0,

  -- Full RegisteredTrace as JSON (for details view)
  registered_trace_json TEXT,

  -- Timestamps
  received_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  processed_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
);

CREATE INDEX idx_registered_traces_time ON registered_traces(received_at DESC);
CREATE INDEX idx_registered_traces_errors ON registered_traces(has_errors);


-- ============================================================================
-- MATCHED SPANS
-- Individual spans with their match context
-- ============================================================================

CREATE TABLE matched_spans (
  id TEXT PRIMARY KEY,                    -- "{traceId}-{spanId}"
  trace_id TEXT NOT NULL,
  span_id TEXT NOT NULL,
  parent_span_id TEXT,

  -- Match context
  match_type TEXT NOT NULL,               -- 'scenario' | 'storyboard' | 'unmatched'
  storyboard_id TEXT,
  workflow_id TEXT,
  scenario_id TEXT,                       -- NULL if storyboard match or unmatched
  node_id TEXT,
  scope_name TEXT,
  scope_version TEXT,

  -- Span data
  span_name TEXT NOT NULL,
  duration_ms REAL,
  timestamp INTEGER NOT NULL,
  is_error INTEGER DEFAULT 0,

  -- Events that matched
  matched_events TEXT,                    -- JSON array of event names

  -- Attributes
  attributes TEXT,                        -- JSON object

  -- For orphaned spans
  orphan_reason TEXT,

  -- Timestamps
  received_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),

  FOREIGN KEY (trace_id) REFERENCES registered_traces(trace_id)
);

CREATE INDEX idx_matched_spans_trace ON matched_spans(trace_id);
CREATE INDEX idx_matched_spans_workflow ON matched_spans(storyboard_id, workflow_id);
CREATE INDEX idx_matched_spans_scenario ON matched_spans(scenario_id);
CREATE INDEX idx_matched_spans_time ON matched_spans(received_at DESC);
CREATE INDEX idx_matched_spans_type ON matched_spans(match_type);


-- ============================================================================
-- REGISTRY STATE
-- Track synced workspaces and their state
-- ============================================================================

CREATE TABLE registry_workspaces (
  workspace_id TEXT PRIMARY KEY,
  root_path TEXT NOT NULL,
  sha TEXT,                               -- Content hash
  scope_names TEXT,                       -- JSON array of discovered scopes

  -- Sync timestamps
  first_synced_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
  last_synced_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),

  -- Status
  is_active INTEGER DEFAULT 1
);

CREATE INDEX idx_registry_workspaces_active ON registry_workspaces(is_active);


-- ============================================================================
-- METRIC ROLLUPS (from LOCAL_METRICS_STORAGE_DESIGN)
-- Pre-aggregated metrics for dashboard queries
-- ============================================================================

CREATE TABLE metric_rollups (
  metric_id TEXT NOT NULL,
  bucket_start INTEGER NOT NULL,
  granularity TEXT NOT NULL,              -- 'minute' | 'hour' | 'day'
  dimension_key TEXT NOT NULL DEFAULT '',

  -- Aggregate values
  count INTEGER DEFAULT 0,
  sum_value REAL DEFAULT 0,
  min_value REAL,
  max_value REAL,
  error_count INTEGER DEFAULT 0,

  -- For percentiles
  duration_digest BLOB,

  updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),

  PRIMARY KEY (metric_id, bucket_start, granularity, dimension_key)
);

CREATE INDEX idx_rollups_time ON metric_rollups(metric_id, granularity, bucket_start);
```

---

## HTTP API

### Registry Endpoints

```
POST /api/registry/sync
  - Receive FileTree push from desktop app
  - Body: { action, workspace, fileTree, timestamp }
  - Response: { success, registeredScopes, error? }

GET /api/registry/status
  - Get current registry state
  - Response: { workspaces: [...], totalScopes, lastSyncAt }

DELETE /api/registry/workspace/:id
  - Remove a workspace from registry
  - Response: { success }
```

### Trace Endpoints

```
GET /api/traces
  - List registered traces with filtering
  - Query: ?limit=100&offset=0&hasErrors=true&matchType=scenario
  - Response: { traces: [...], total }

GET /api/traces/:traceId
  - Get full RegisteredTrace details
  - Response: RegisteredTrace

GET /api/traces/:traceId/spans
  - Get matched spans for a trace
  - Response: { spans: [...] }
```

### Metrics Endpoints

```
GET /api/metrics/:metricId
  - Query metric data for dashboard
  - Query: ?timeRange=last_1h&granularity=minute
  - Response: MetricData

GET /api/services
  - List services with span counts (existing, enhanced)
  - Response: { services: [{ name, count, matchedCount, unmatchedCount }] }
```

---

## Implementation Phases

### Phase 1: Registry Sync Infrastructure ✅ COMPLETE

**Goal**: Desktop app can push FileTree updates to metrics backend

1. ✅ Add `@principal-ai/principal-view-core` and `@principal-ai/repository-abstraction` dependencies
2. ✅ Create `RegistryManager` class wrapping `LocalRegistry`
3. ✅ Add `POST /api/registry/sync` endpoint
4. ✅ Add `registry_workspaces` table
5. ✅ Create `MetricsBackendBridge` in desktop app (desktop app side)
6. ✅ Wire up push on workspace registration (desktop app side)

**Implementation Notes**:
- `RegistryManager` uses `InMemoryFileSystemAdapter` populated from FileTree data
- Files are read from disk using the workspace root path for content not embedded in FileTree
- Only relevant files are loaded: `.principal-views/`, `library.yaml`, `package.json`

**Deliverable**: FileTree syncs from desktop app to metrics backend ✅

### Phase 2: Trace Matching Integration ✅ COMPLETE

**Goal**: Incoming traces are matched against synced workflows

1. ✅ Create `TraceOrchestrator` integration in OTLP handler
2. ✅ Add `registered_traces` and `matched_spans` tables
3. ✅ Update UI to show match context (storyboard/workflow/scenario)
4. ✅ Add trace detail view with full RegisteredTrace

**Implementation Notes**:
- UI has "Spans" and "Matched Traces" tabs
- Matched traces show badge counts: scenario (green), storyboard (yellow), unmatched (gray)
- Detail panel shows full trace info with matched spans grouped by type
- RPC methods: `getRegisteredTraces`, `getRegisteredTraceById`, `getMatchedSpansByTrace`, `getRegisteredTraceStats`

**Deliverable**: Traces show workflow/scenario matches in UI ✅

### Phase 3: Metrics Aggregation ✅ COMPLETE

**Goal**: Pre-computed metrics for dashboard queries

1. ✅ Implement `MetricsIngestionService` (from LOCAL_METRICS_STORAGE_DESIGN)
2. ✅ Add `span_events`, `metric_rollups`, and `dashboard_metrics` tables
3. ✅ Implement rollup updates on trace ingestion
4. ✅ Add `GET /api/metrics/:metricId` endpoint
5. ✅ Add cleanup job for old data (runs hourly)

**Implementation Notes**:
- `MetricSourceIndex` indexes metrics by workflow/node/event for fast span routing
- `MetricsIngestionService` processes RegisteredTrace and updates rollups at minute/hour/day granularities
- Dimension keys support groupBy for multi-dimensional metrics
- Cleanup: span_events retained 24h, rollups retained 30 days
- Endpoints:
  - `GET /api/metrics/:metricId?timeRange=last_1h&granularity=minute` - Query metric data
  - `POST /api/dashboards/load` - Load dashboard definitions to enable metrics
  - `POST /api/metrics/cleanup` - Trigger manual cleanup

**Deliverable**: Dashboard can query aggregated metrics ✅

### Phase 4: Dashboard Integration ✅ COMPLETE

**Goal**: Full dashboard rendering with real data

1. ✅ Load `.dashboard.json` definitions from synced FileTrees
2. ✅ Implement `MetricsQueryService` as DataProvider (via MetricsIngestionService.queryDashboard)
3. ✅ Add dashboard UI components
4. ✅ Real-time updates via RPC messaging

**Implementation Notes**:
- Dashboard files discovered automatically during workspace sync
- UI has three tabs: Spans, Matched Traces, Dashboards
- Dashboards view has sidebar listing available dashboards with time range selector
- Metric panels display KPI values with sparkline charts
- Supported metric types: counter (count), gauge (avg), histogram (duration)
- Time ranges: 5m, 15m, 30m, 1h, 3h, 6h, 12h, 24h, 7d
- RPC methods: `getDashboards`, `getDashboard` with time range
- HTTP endpoints: `GET /api/dashboards`, `GET /api/dashboards/:id`
- `dashboardsUpdated` RPC message for real-time updates

**Deliverable**: Live dashboards showing metrics from matched traces ✅

---

## Configuration

```typescript
interface MetricsBackendConfig {
  // HTTP server
  httpPort: number;                    // Default: 4321

  // Registry
  enableRegistrySync: boolean;         // Default: true
  registrySyncSecret?: string;         // Optional auth token

  // Storage
  databasePath: string;                // SQLite file path
  rawEventRetentionMs: number;         // Default: 24 hours
  rollupRetentionMs: number;           // Default: 30 days

  // Aggregation
  rollupGranularities: string[];       // Default: ['minute', 'hour', 'day']

  // Cleanup
  cleanupIntervalMs: number;           // Default: 1 hour
}
```

---

## Security Considerations

1. **Registry Sync Authentication**
   - Optional shared secret for registry sync endpoint
   - Validate workspace paths are within expected directories

2. **OTLP Ingestion**
   - Currently localhost only
   - Add optional authentication for remote ingestion

3. **Query API**
   - Read-only endpoints
   - Consider rate limiting for production use

---

## Future Considerations

1. **WebSocket for Real-Time Updates**
   - Push matched traces to UI immediately
   - Live dashboard updates without polling

2. **Multi-Workspace Support**
   - Handle multiple workspaces with different schemas
   - Scope isolation for metrics

3. **Remote Registry**
   - Support published schemas from remote registry
   - Fallback when desktop app not running

4. **Export/Import**
   - Export metrics data for analysis
   - Import historical data for testing
