# Trace Ingestion

The OTEL Events Manager ingests traces via the OTLP HTTP protocol and processes them through multiple stages.

## Overview

When a trace arrives at `/v1/traces`:

1. **Receive** - Parse OTLP JSON and extract spans
2. **Store** - Persist raw spans to SQLite database
3. **Orchestrate** - Match spans against registered workflows using TraceOrchestrator
4. **Aggregate** - Update metrics rollups for dashboards
5. **Complete** - Notify UI via RPC

## Key Components

- **HTTP Server** (`src/bun/index.ts:1579`) - Bun server handling OTLP ingestion
- **TraceOrchestrator** - Matches traces to workflow scenarios
- **MetricsIngestionService** - Aggregates span data into dashboard metrics
- **RegistryManager** - Manages workspace registrations and scope discovery

## Error Handling

If the TraceOrchestrator fails, spans are still stored in the database but won't be matched to workflows. The error is logged and the trace is marked as unprocessed.
