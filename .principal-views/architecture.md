# OTEL Events Manager Architecture

The OTEL Events Manager is a trace collector, matcher, and dashboard viewer built with Electrobun.

## Span Conventions

### HTTP Server Spans

All HTTP endpoints create server spans following the OpenTelemetry HTTP semantic conventions:
- `http.server POST /v1/traces` - OTLP trace ingestion
- `http.server POST /api/registry/sync` - Workspace registry sync
- `http.server GET /api/*` - Query endpoints

## Components

- **HTTP Server** - Bun-based HTTP server on port 4321
- **SQLite Database** - Persistent storage for spans, traces, and metrics
- **TraceOrchestrator** - Matches incoming traces to registered workflow scenarios
- **MetricsIngestionService** - Aggregates trace data into dashboard metrics
- **Electrobun UI** - Desktop application for viewing traces and dashboards
