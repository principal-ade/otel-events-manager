# OTEL Events Manager - Design Choices

This document captures the architectural decisions and trade-offs made in building the OTEL Events Manager.

**Based on:** [LOCAL_METRICS_STORAGE_DESIGN.md](/Users/griever/Developer/visual-validation/principal-view-core-library/docs/LOCAL_METRICS_STORAGE_DESIGN.md) - the comprehensive design for SQLite-powered dashboard data from OTEL traces. This implementation is a simplified v1 that establishes the foundation for that larger vision.

---

## Overview

A desktop application built with Electrobun that receives OpenTelemetry trace data via HTTP, stores it in SQLite, and displays spans in a real-time table view.

---

## Architecture

```
┌─────────────────┐     HTTP POST      ┌─────────────────────────────────────┐
│  OTEL Collector │ ──────────────────▶│        OTEL Events Manager          │
│  (or any client)│   /v1/traces       │                                     │
└─────────────────┘                    │  ┌─────────┐     ┌──────────────┐  │
                                       │  │  Bun    │────▶│   SQLite     │  │
                                       │  │ Process │     │  (spans.db)  │  │
                                       │  └────┬────┘     └──────────────┘  │
                                       │       │ RPC                        │
                                       │  ┌────▼────┐                       │
                                       │  │ Webview │  ← Table UI           │
                                       │  └─────────┘                       │
                                       └─────────────────────────────────────┘
```

---

## Key Decisions

### 1. HTTP API Instead of MessagePort

**Choice:** Expose an HTTP endpoint (`POST /v1/traces`) rather than using MessagePort IPC.

**Rationale:**
- MessagePort is Electron-specific; HTTP is universal
- Any OTEL collector or instrumented app can send traces
- Easier to debug with curl/Postman
- Standard OTLP endpoint path for compatibility

**Trade-off:** Slightly more overhead than direct IPC, but negligible for our use case.

---

### 2. Single Flat Table Schema

**Choice:** Store all spans in one `spans` table with flattened columns rather than normalized tables.

```sql
CREATE TABLE spans (
  id TEXT PRIMARY KEY,           -- "{traceId}-{spanId}"
  trace_id, span_id, parent_span_id,
  service_name, service_version,
  name, kind, start_time, end_time, duration_ms,
  status_code, status_message,
  attributes TEXT,               -- JSON
  events TEXT,                   -- JSON
  received_at INTEGER
)
```

**Rationale:**
- Simpler queries for the initial version
- Single table is easier to reason about
- JSON columns preserve flexibility for attributes/events
- SQLite handles this scale easily (100k rows = ~10MB)

**Trade-off:** No separate tables for services, traces, or metrics rollups. These can be added later if needed.

**Future:** The design doc at `/Users/griever/Developer/visual-validation/principal-view-core-library/docs/LOCAL_METRICS_STORAGE_DESIGN.md` outlines a more sophisticated schema with:
- `span_events` - raw events with short retention
- `metric_rollups` - pre-aggregated time buckets
- `dashboard_metrics` - metric configurations

---

### 3. OTLP JSON Format

**Choice:** Accept standard OTLP JSON format (not protobuf).

**Input structure:**
```json
{
  "resourceSpans": [{
    "resource": { "attributes": [...] },
    "scopeSpans": [{
      "spans": [{
        "traceId", "spanId", "name", "kind",
        "startTimeUnixNano", "endTimeUnixNano",
        "attributes", "events", "status"
      }]
    }]
  }]
}
```

**Rationale:**
- JSON is easier to debug and test
- Matches the format from the existing OTEL collection server
- No protobuf parsing dependency needed

**Trade-off:** Larger payload size than protobuf, but fine for local development.

---

### 4. Bun's Native SQLite

**Choice:** Use `bun:sqlite` instead of better-sqlite3 or other npm packages.

**Rationale:**
- Zero dependencies - built into Bun runtime
- Synchronous API is simpler for our use case
- Excellent performance for local storage
- WAL mode enabled for concurrent reads

**Configuration:**
```typescript
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = NORMAL");
```

---

### 5. Polling + RPC Notification Hybrid

**Choice:** UI polls every 5 seconds AND receives RPC notifications for new spans.

**Rationale:**
- Polling ensures data is always fresh even if RPC fails
- RPC notifications provide instant updates when available
- Graceful degradation - if RPC isn't ready, polling catches up

**Implementation:**
```typescript
// Bun side - notify on new spans
if (mainWindow?.rpc?.send) {
  mainWindow.rpc.send.newSpansReceived({ count });
}

// View side - poll as backup
setInterval(refresh, 5000);
```

---

### 6. Port Selection

| Port | Purpose |
|------|---------|
| 4321 | HTTP API for OTLP traces |
| 50000+ | Internal Electrobun RPC (auto-assigned) |

**Rationale:**
- 4321 is memorable and unlikely to conflict
- Standard OTLP port is 4318, but we're a secondary receiver
- Could be made configurable via env var if needed

---

### 7. Dark Theme UI

**Choice:** GitHub-inspired dark theme for the UI.

**Rationale:**
- Developer tools are often viewed for long periods
- Dark theme reduces eye strain
- Matches common IDE/terminal aesthetics
- Status colors (green/red) are more visible on dark backgrounds

---

## Data Retention

**Current:** No automatic cleanup. Data persists until manually cleared.

**Clear Old button:** Removes spans older than 1 hour.

**Future consideration:** Add configurable retention policies:
- Raw spans: 24-48 hours
- Aggregated rollups: 7-30 days

---

## What's Not Included (Yet)

These features were intentionally deferred for the initial version:

1. **Separate databases per service** - All spans go to one DB
2. **Tabs for different apps** - Single view for now
3. **Metric aggregations** - No rollups or computed metrics
4. **Time-series charts** - Table only, no visualizations
5. **Trace waterfall view** - Flat list, no parent-child hierarchy visualization
6. **Search/filtering** - Basic table, no query interface
7. **Export functionality** - No CSV/JSON export

---

## File Structure

```
otel-events-manager/
├── src/
│   ├── bun/
│   │   └── index.ts          # HTTP server, SQLite, RPC handlers
│   └── mainview/
│       ├── index.ts          # UI logic, table rendering
│       ├── index.html        # Table structure
│       └── index.css         # Dark theme styling
├── docs/
│   └── DESIGN_CHOICES.md     # This file
├── electrobun.config.ts      # App configuration
└── package.json
```

---

## Related Documents

- [LOCAL_METRICS_STORAGE_DESIGN.md](file:///Users/griever/Developer/visual-validation/principal-view-core-library/docs/LOCAL_METRICS_STORAGE_DESIGN.md) - Full metrics storage architecture
- [DASHBOARD_METRICS_DESIGN.md](file:///Users/griever/Developer/visual-validation/principal-view-core-library/docs/DASHBOARD_METRICS_DESIGN.md) - Dashboard schema and validation
