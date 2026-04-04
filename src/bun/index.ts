import { BrowserView, BrowserWindow, Utils, type RPCSchema } from "electrobun/bun";
import Database from "bun:sqlite";
import { join } from "path";
import { mkdirSync, existsSync } from "fs";

// @principal-ai/core imports for trace orchestration (lazy loaded to avoid startup crashes)
import type { FileTree } from "@principal-ai/repository-abstraction";

// Lazy-loaded modules
let TraceOrchestrator: typeof import("@principal-ai/principal-view-core").TraceOrchestrator | null = null;
let LocalRegistry: typeof import("@principal-ai/principal-view-core").LocalRegistry | null = null;
let InMemoryFileSystemAdapter: typeof import("@principal-ai/principal-view-core").InMemoryFileSystemAdapter | null = null;

type RegisteredTrace = import("@principal-ai/principal-view-core").RegisteredTrace;
type OtelExportTraceServiceRequest = import("@principal-ai/principal-view-core").OtelExportTraceServiceRequest;

async function loadPrincipalCore(): Promise<boolean> {
	if (TraceOrchestrator) return true;
	try {
		const core = await import("@principal-ai/principal-view-core");
		TraceOrchestrator = core.TraceOrchestrator;
		LocalRegistry = core.LocalRegistry;
		InMemoryFileSystemAdapter = core.InMemoryFileSystemAdapter;
		console.log("[PrincipalCore] Loaded successfully");
		return true;
	} catch (error) {
		console.error("[PrincipalCore] Failed to load:", error);
		return false;
	}
}

// ============================================================================
// DATABASE SETUP
// ============================================================================

const dataDir = Utils.paths.userData;
if (!existsSync(dataDir)) {
	mkdirSync(dataDir, { recursive: true });
}

const dbPath = join(dataDir, "spans.db");
const db = new Database(dbPath, { create: true });

// Enable WAL mode for better concurrent read performance
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = NORMAL");

// Create spans table
db.exec(`
	CREATE TABLE IF NOT EXISTS spans (
		id TEXT PRIMARY KEY,
		trace_id TEXT NOT NULL,
		span_id TEXT NOT NULL,
		parent_span_id TEXT,

		service_name TEXT,
		service_version TEXT,

		name TEXT NOT NULL,
		kind INTEGER,
		start_time INTEGER NOT NULL,
		end_time INTEGER,
		duration_ms REAL,

		status_code INTEGER DEFAULT 0,
		status_message TEXT,

		attributes TEXT,
		events TEXT,

		received_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
	)
`);

// Create indexes
db.exec(`CREATE INDEX IF NOT EXISTS idx_spans_time ON spans(received_at DESC)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_spans_service ON spans(service_name)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_spans_trace ON spans(trace_id)`);

// Create registry_workspaces table
db.exec(`
	CREATE TABLE IF NOT EXISTS registry_workspaces (
		workspace_id TEXT PRIMARY KEY,
		root_path TEXT NOT NULL,
		name TEXT,
		sha TEXT,
		scope_names TEXT,
		first_synced_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
		last_synced_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
		is_active INTEGER DEFAULT 1
	)
`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_registry_workspaces_active ON registry_workspaces(is_active)`);

// ============================================================================
// PHASE 2: REGISTERED TRACES TABLES
// ============================================================================

// Create registered_traces table - traces processed through TraceOrchestrator
db.exec(`
	CREATE TABLE IF NOT EXISTS registered_traces (
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
	)
`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_registered_traces_time ON registered_traces(received_at DESC)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_registered_traces_errors ON registered_traces(has_errors)`);

// Create matched_spans table - individual spans with their match context
db.exec(`
	CREATE TABLE IF NOT EXISTS matched_spans (
		id TEXT PRIMARY KEY,
		trace_id TEXT NOT NULL,
		span_id TEXT NOT NULL,
		parent_span_id TEXT,

		-- Match context
		match_type TEXT NOT NULL,
		storyboard_id TEXT,
		workflow_id TEXT,
		scenario_id TEXT,
		node_id TEXT,
		scope_name TEXT,
		scope_version TEXT,

		-- Span data
		span_name TEXT NOT NULL,
		duration_ms REAL,
		timestamp INTEGER NOT NULL,
		is_error INTEGER DEFAULT 0,

		-- Events that matched
		matched_events TEXT,

		-- Attributes
		attributes TEXT,

		-- For orphaned/unmatched spans
		orphan_reason TEXT,

		-- Timestamps
		received_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),

		FOREIGN KEY (trace_id) REFERENCES registered_traces(trace_id)
	)
`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_matched_spans_trace ON matched_spans(trace_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_matched_spans_workflow ON matched_spans(storyboard_id, workflow_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_matched_spans_scenario ON matched_spans(scenario_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_matched_spans_time ON matched_spans(received_at DESC)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_matched_spans_type ON matched_spans(match_type)`);

// ============================================================================
// PHASE 3: METRICS AGGREGATION TABLES
// ============================================================================

// Create span_events table - raw events with short retention (24h)
db.exec(`
	CREATE TABLE IF NOT EXISTS span_events (
		id TEXT PRIMARY KEY,
		timestamp INTEGER NOT NULL,

		-- Trace context
		trace_id TEXT NOT NULL,
		span_id TEXT,
		parent_span_id TEXT,

		-- Workflow matching
		storyboard_id TEXT NOT NULL,
		workflow_id TEXT NOT NULL,
		scenario_id TEXT,
		node_id TEXT,

		-- Event data
		event_name TEXT,
		span_name TEXT,
		duration_ms REAL,
		is_error INTEGER DEFAULT 0,

		-- Flexible attributes
		attributes TEXT,

		-- Metadata
		created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
	)
`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_events_workflow_time ON span_events(storyboard_id, workflow_id, timestamp)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_events_timestamp ON span_events(timestamp)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_events_trace ON span_events(trace_id)`);

// Create metric_rollups table - pre-aggregated buckets (7-30 days)
db.exec(`
	CREATE TABLE IF NOT EXISTS metric_rollups (
		metric_id TEXT NOT NULL,
		bucket_start INTEGER NOT NULL,
		granularity TEXT NOT NULL,
		dimension_key TEXT NOT NULL DEFAULT '',

		-- Aggregate values
		count INTEGER DEFAULT 0,
		sum_value REAL DEFAULT 0,
		min_value REAL,
		max_value REAL,
		error_count INTEGER DEFAULT 0,

		-- For percentiles (t-digest serialized)
		duration_digest BLOB,

		-- Metadata
		updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),

		PRIMARY KEY (metric_id, bucket_start, granularity, dimension_key)
	)
`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_rollups_time ON metric_rollups(metric_id, granularity, bucket_start)`);

// Create dashboard_metrics table - tracks which metrics exist and their configurations
db.exec(`
	CREATE TABLE IF NOT EXISTS dashboard_metrics (
		metric_id TEXT PRIMARY KEY,
		dashboard_id TEXT NOT NULL,
		metric_name TEXT NOT NULL,
		metric_type TEXT NOT NULL,

		-- Serialized configuration
		sources_json TEXT NOT NULL,
		query_json TEXT NOT NULL,

		-- Status
		is_active INTEGER DEFAULT 1,
		created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
		updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
	)
`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_metrics_dashboard ON dashboard_metrics(dashboard_id)`);

// ============================================================================
// PREPARED STATEMENTS
// ============================================================================

const insertSpan = db.prepare(`
	INSERT OR REPLACE INTO spans (
		id, trace_id, span_id, parent_span_id,
		service_name, service_version,
		name, kind, start_time, end_time, duration_ms,
		status_code, status_message,
		attributes, events, received_at
	) VALUES (
		$id, $trace_id, $span_id, $parent_span_id,
		$service_name, $service_version,
		$name, $kind, $start_time, $end_time, $duration_ms,
		$status_code, $status_message,
		$attributes, $events, $received_at
	)
`);

const getRecentSpans = db.prepare(`
	SELECT * FROM spans ORDER BY received_at DESC LIMIT ? OFFSET ?
`);

const getSpansByTrace = db.prepare(`
	SELECT * FROM spans WHERE trace_id = ? ORDER BY start_time ASC
`);

const getStats = db.prepare(`
	SELECT
		COUNT(*) as total,
		SUM(CASE WHEN status_code = 2 THEN 1 ELSE 0 END) as error_count,
		AVG(duration_ms) as avg_duration
	FROM spans
`);

const clearOldSpans = db.prepare(`
	DELETE FROM spans WHERE received_at < ?
`);

const getServiceSummaries = db.prepare(`
	SELECT service_name, COUNT(*) as count FROM spans GROUP BY service_name ORDER BY count DESC
`);

const getRecentSpansByService = db.prepare(`
	SELECT * FROM spans WHERE service_name = ? ORDER BY received_at DESC LIMIT ? OFFSET ?
`);

// Registry prepared statements
const upsertWorkspace = db.prepare(`
	INSERT INTO registry_workspaces (workspace_id, root_path, name, sha, scope_names, first_synced_at, last_synced_at, is_active)
	VALUES ($workspace_id, $root_path, $name, $sha, $scope_names, $now, $now, 1)
	ON CONFLICT(workspace_id) DO UPDATE SET
		root_path = excluded.root_path,
		name = excluded.name,
		sha = excluded.sha,
		scope_names = excluded.scope_names,
		last_synced_at = excluded.last_synced_at,
		is_active = 1
`);

const getActiveWorkspaces = db.prepare(`
	SELECT * FROM registry_workspaces WHERE is_active = 1 ORDER BY last_synced_at DESC
`);

const deactivateWorkspace = db.prepare(`
	UPDATE registry_workspaces SET is_active = 0 WHERE workspace_id = ?
`);

// Registered traces prepared statements
const insertRegisteredTrace = db.prepare(`
	INSERT OR REPLACE INTO registered_traces (
		trace_id, name, start_time, end_time, duration_ms, span_count, has_errors,
		scenario_match_count, storyboard_match_count, unmatched_span_count,
		registered_trace_json, received_at, processed_at
	) VALUES (
		$trace_id, $name, $start_time, $end_time, $duration_ms, $span_count, $has_errors,
		$scenario_match_count, $storyboard_match_count, $unmatched_span_count,
		$registered_trace_json, $received_at, $processed_at
	)
`);

const getRecentRegisteredTraces = db.prepare(`
	SELECT * FROM registered_traces ORDER BY received_at DESC LIMIT ? OFFSET ?
`);

const getRegisteredTraceById = db.prepare(`
	SELECT * FROM registered_traces WHERE trace_id = ?
`);

// Matched spans prepared statements
const insertMatchedSpan = db.prepare(`
	INSERT OR REPLACE INTO matched_spans (
		id, trace_id, span_id, parent_span_id,
		match_type, storyboard_id, workflow_id, scenario_id, node_id,
		scope_name, scope_version,
		span_name, duration_ms, timestamp, is_error,
		matched_events, attributes, orphan_reason, received_at
	) VALUES (
		$id, $trace_id, $span_id, $parent_span_id,
		$match_type, $storyboard_id, $workflow_id, $scenario_id, $node_id,
		$scope_name, $scope_version,
		$span_name, $duration_ms, $timestamp, $is_error,
		$matched_events, $attributes, $orphan_reason, $received_at
	)
`);

const getMatchedSpansByTrace = db.prepare(`
	SELECT * FROM matched_spans WHERE trace_id = ? ORDER BY timestamp ASC
`);

const getRegisteredTraceStats = db.prepare(`
	SELECT
		COUNT(*) as total,
		SUM(CASE WHEN has_errors = 1 THEN 1 ELSE 0 END) as error_count,
		SUM(scenario_match_count) as total_scenario_matches,
		SUM(storyboard_match_count) as total_storyboard_matches,
		SUM(unmatched_span_count) as total_unmatched_spans,
		AVG(duration_ms) as avg_duration
	FROM registered_traces
`);

// Phase 3: Metrics aggregation prepared statements
const insertSpanEvent = db.prepare(`
	INSERT OR REPLACE INTO span_events (
		id, timestamp, trace_id, span_id, parent_span_id,
		storyboard_id, workflow_id, scenario_id, node_id,
		event_name, span_name, duration_ms, is_error, attributes
	) VALUES (
		$id, $timestamp, $trace_id, $span_id, $parent_span_id,
		$storyboard_id, $workflow_id, $scenario_id, $node_id,
		$event_name, $span_name, $duration_ms, $is_error, $attributes
	)
`);

const upsertMetricRollup = db.prepare(`
	INSERT INTO metric_rollups (
		metric_id, bucket_start, granularity, dimension_key,
		count, sum_value, min_value, max_value, error_count, updated_at
	) VALUES (
		$metric_id, $bucket_start, $granularity, $dimension_key,
		$count, $sum_value, $min_value, $max_value, $error_count, $updated_at
	)
	ON CONFLICT (metric_id, bucket_start, granularity, dimension_key) DO UPDATE SET
		count = count + excluded.count,
		sum_value = sum_value + excluded.sum_value,
		min_value = MIN(COALESCE(min_value, excluded.min_value), excluded.min_value),
		max_value = MAX(COALESCE(max_value, excluded.max_value), excluded.max_value),
		error_count = error_count + excluded.error_count,
		updated_at = excluded.updated_at
`);

const getMetricRollups = db.prepare(`
	SELECT bucket_start, dimension_key, count, sum_value, min_value, max_value, error_count
	FROM metric_rollups
	WHERE metric_id = ? AND granularity = ? AND bucket_start >= ? AND bucket_start < ?
	ORDER BY bucket_start ASC
`);

const cleanupOldSpanEvents = db.prepare(`
	DELETE FROM span_events WHERE timestamp < ?
`);

const cleanupOldMetricRollups = db.prepare(`
	DELETE FROM metric_rollups WHERE bucket_start < ?
`);

const upsertDashboardMetric = db.prepare(`
	INSERT INTO dashboard_metrics (
		metric_id, dashboard_id, metric_name, metric_type, sources_json, query_json, updated_at
	) VALUES (
		$metric_id, $dashboard_id, $metric_name, $metric_type, $sources_json, $query_json, $updated_at
	)
	ON CONFLICT (metric_id) DO UPDATE SET
		dashboard_id = excluded.dashboard_id,
		metric_name = excluded.metric_name,
		metric_type = excluded.metric_type,
		sources_json = excluded.sources_json,
		query_json = excluded.query_json,
		updated_at = excluded.updated_at
`);

const getActiveDashboardMetrics = db.prepare(`
	SELECT * FROM dashboard_metrics WHERE is_active = 1
`);

// ============================================================================
// PHASE 3: METRICS INGESTION SERVICE
// ============================================================================

/**
 * Metric source definition (from dashboard.json)
 */
interface MetricSource {
	storyboard: string;
	workflow: string;
	nodes?: string[];
	event?: string;
}

/**
 * Metric query definition
 */
interface MetricQuery {
	derivation: string;
	groupBy?: string[];
	timeGroup?: string;
}

/**
 * Metric definition from dashboard
 */
interface MetricDefinition {
	id: string;
	name: string;
	type: string;
	sources: MetricSource[];
	query: MetricQuery;
}

/**
 * Dashboard definition
 */
interface DashboardDefinition {
	id: string;
	name: string;
	metrics: MetricDefinition[];
}

/**
 * MetricSourceIndex - Fast lookup for routing spans to metrics
 */
class MetricSourceIndex {
	// storyboard:workflow → [MetricDefinition, ...]
	private workflowIndex = new Map<string, MetricDefinition[]>();
	// storyboard:workflow:node → [MetricDefinition, ...]
	private nodeIndex = new Map<string, MetricDefinition[]>();
	// storyboard:workflow:event → [MetricDefinition, ...]
	private eventIndex = new Map<string, MetricDefinition[]>();

	constructor(dashboards: DashboardDefinition[]) {
		for (const dashboard of dashboards) {
			for (const metric of dashboard.metrics) {
				this.indexMetric(metric);
			}
		}
		// Log indexed workflow keys for debugging
		console.log(`[MetricSourceIndex] Indexed workflow keys: ${Array.from(this.workflowIndex.keys()).join(", ")}`);
	}

	private indexMetric(metric: MetricDefinition): void {
		for (const source of metric.sources) {
			const workflowKey = `${source.storyboard}:${source.workflow}`;

			// Index by workflow
			if (!this.workflowIndex.has(workflowKey)) {
				this.workflowIndex.set(workflowKey, []);
			}
			this.workflowIndex.get(workflowKey)!.push(metric);

			// Index by specific nodes
			if (source.nodes?.length) {
				for (const node of source.nodes) {
					const nodeKey = `${workflowKey}:${node}`;
					if (!this.nodeIndex.has(nodeKey)) {
						this.nodeIndex.set(nodeKey, []);
					}
					this.nodeIndex.get(nodeKey)!.push(metric);
				}
			}

			// Index by event
			if (source.event) {
				const eventKey = `${workflowKey}:${source.event}`;
				if (!this.eventIndex.has(eventKey)) {
					this.eventIndex.set(eventKey, []);
				}
				this.eventIndex.get(eventKey)!.push(metric);
			}
		}
	}

	/**
	 * Find all metrics affected by a span
	 */
	findMetrics(lookup: {
		storyboardId: string;
		workflowId: string;
		nodeId?: string;
		events?: string[];
	}): MetricDefinition[] {
		const results = new Set<MetricDefinition>();
		const workflowKey = `${lookup.storyboardId}:${lookup.workflowId}`;

		// Check workflow-level metrics (no node/event filter)
		const workflowMetrics = this.workflowIndex.get(workflowKey) || [];
		for (const metric of workflowMetrics) {
			const source = metric.sources.find(
				(s) => s.storyboard === lookup.storyboardId && s.workflow === lookup.workflowId
			);
			if (source && !source.nodes?.length && !source.event) {
				results.add(metric);
			}
		}

		// Check node-specific metrics
		if (lookup.nodeId) {
			const nodeKey = `${workflowKey}:${lookup.nodeId}`;
			const nodeMetrics = this.nodeIndex.get(nodeKey) || [];
			for (const metric of nodeMetrics) {
				results.add(metric);
			}
		}

		// Check event-specific metrics
		if (lookup.events?.length) {
			for (const event of lookup.events) {
				const eventKey = `${workflowKey}:${event}`;
				const eventMetrics = this.eventIndex.get(eventKey) || [];
				for (const metric of eventMetrics) {
					results.add(metric);
				}
			}
		}

		return Array.from(results);
	}

	/**
	 * Check if index has any metrics
	 */
	hasMetrics(): boolean {
		return this.workflowIndex.size > 0;
	}
}

/**
 * MetricsIngestionService - Processes traces and updates metrics
 */
class MetricsIngestionService {
	private sourceIndex: MetricSourceIndex | null = null;
	private dashboards: DashboardDefinition[] = [];
	private rollupGranularities: Array<"minute" | "hour" | "day"> = ["minute", "hour", "day"];
	private rawEventRetentionMs = 24 * 60 * 60 * 1000; // 24 hours
	private rollupRetentionMs = 30 * 24 * 60 * 60 * 1000; // 30 days

	/**
	 * Load dashboard definitions and build source index
	 */
	loadDashboards(dashboards: DashboardDefinition[]): void {
		this.dashboards = dashboards;
		this.sourceIndex = new MetricSourceIndex(dashboards);

		// Register metrics in database
		const now = Date.now();
		for (const dashboard of dashboards) {
			for (const metric of dashboard.metrics) {
				upsertDashboardMetric.run({
					$metric_id: metric.id,
					$dashboard_id: dashboard.id,
					$metric_name: metric.name,
					$metric_type: metric.type,
					$sources_json: JSON.stringify(metric.sources),
					$query_json: JSON.stringify(metric.query),
					$updated_at: now,
				});
			}
		}

		console.log(
			`[MetricsIngestion] Loaded ${dashboards.length} dashboards with ${dashboards.reduce((sum, d) => sum + d.metrics.length, 0)} metrics`
		);
	}

	/**
	 * Check if dashboards are loaded
	 */
	isReady(): boolean {
		return this.sourceIndex !== null && this.sourceIndex.hasMetrics();
	}

	/**
	 * Process a registered trace and update metrics
	 */
	async ingestTrace(trace: RegisteredTrace): Promise<{ eventsIngested: number; metricsUpdated: number; affectedDashboardIds: string[] }> {
		if (!this.sourceIndex) {
			return { eventsIngested: 0, metricsUpdated: 0, affectedDashboardIds: [] };
		}

		const timestamp = trace.startTime;
		let eventsIngested = 0;
		let metricsUpdated = 0;
		const affectedDashboardIds = new Set<string>();

		// Process scenario matches (full workflow + scenario match)
		for (const match of trace.scenarioMatches) {
			for (const span of match.matchedSpans) {
				const result = this.processMatchedSpan(trace, match, span, timestamp);
				eventsIngested += result.eventStored ? 1 : 0;
				metricsUpdated += result.metricsUpdated;
				for (const dashboardId of result.affectedDashboardIds) {
					affectedDashboardIds.add(dashboardId);
				}
			}
		}

		// Process storyboard matches (orphaned spans)
		for (const match of trace.storyboardMatches) {
			for (const span of match.orphanedSpans) {
				this.storeRawEvent(trace, match, span, timestamp);
				eventsIngested++;
			}
		}

		return { eventsIngested, metricsUpdated, affectedDashboardIds: Array.from(affectedDashboardIds) };
	}

	/**
	 * Process a single matched span
	 */
	private processMatchedSpan(
		trace: RegisteredTrace,
		match: { storyboardId: string; workflowId: string; scenarioId: string; scopeName: string },
		span: { spanId: string; parentSpanId?: string; nodeId: string; spanName: string; duration: number; events: string[]; attributes?: Record<string, unknown> },
		timestamp: number
	): { eventStored: boolean; metricsUpdated: number; affectedDashboardIds: string[] } {
		// Find metrics this span contributes to
		const affectedMetrics = this.sourceIndex!.findMetrics({
			storyboardId: match.storyboardId,
			workflowId: match.workflowId,
			nodeId: span.nodeId,
			events: span.events,
		});

		// Store raw event
		this.storeRawEvent(trace, match, span, timestamp);

		// Update rollups for each affected metric and track dashboard IDs
		let metricsUpdated = 0;
		const affectedDashboardIds = new Set<string>();
		for (const metric of affectedMetrics) {
			this.updateRollups(metric, span, timestamp, trace.hasErrors);
			metricsUpdated++;
			// Find which dashboard this metric belongs to
			for (const dashboard of this.dashboards) {
				if (dashboard.metrics.some((m) => m.id === metric.id)) {
					affectedDashboardIds.add(dashboard.id);
				}
			}
		}

		return { eventStored: true, metricsUpdated, affectedDashboardIds: Array.from(affectedDashboardIds) };
	}

	/**
	 * Store raw event for debugging
	 */
	private storeRawEvent(
		trace: RegisteredTrace,
		match: { storyboardId: string; workflowId: string; scenarioId?: string },
		span: { spanId: string; parentSpanId?: string; nodeId?: string; spanName: string; duration: number; events?: string[]; attributes?: Record<string, unknown> },
		timestamp: number
	): void {
		insertSpanEvent.run({
			$id: `${trace.traceId}-${span.spanId}`,
			$timestamp: timestamp,
			$trace_id: trace.traceId,
			$span_id: span.spanId,
			$parent_span_id: span.parentSpanId || null,
			$storyboard_id: match.storyboardId,
			$workflow_id: match.workflowId,
			$scenario_id: match.scenarioId || null,
			$node_id: span.nodeId || null,
			$event_name: span.events?.[0] || null,
			$span_name: span.spanName,
			$duration_ms: span.duration,
			$is_error: trace.hasErrors ? 1 : 0,
			$attributes: JSON.stringify(span.attributes || {}),
		});
	}

	/**
	 * Update rollup aggregates for a metric
	 */
	private updateRollups(
		metric: MetricDefinition,
		span: { duration: number; attributes?: Record<string, unknown> },
		timestamp: number,
		hasError: boolean
	): void {
		// Compute dimension key from groupBy attributes
		const dimensionKey = this.computeDimensionKey(metric.query.groupBy, span.attributes);

		// Get the value to aggregate
		const value = this.extractValue(metric.query.derivation, span);

		const now = Date.now();

		// Update each configured granularity
		for (const granularity of this.rollupGranularities) {
			const bucketStart = this.getBucketStart(timestamp, granularity);

			upsertMetricRollup.run({
				$metric_id: metric.id,
				$bucket_start: bucketStart,
				$granularity: granularity,
				$dimension_key: dimensionKey,
				$count: 1,
				$sum_value: value,
				$min_value: value,
				$max_value: value,
				$error_count: hasError ? 1 : 0,
				$updated_at: now,
			});
		}
	}

	/**
	 * Compute dimension key for groupBy
	 */
	private computeDimensionKey(groupBy: string[] | undefined, attributes: Record<string, unknown> | undefined): string {
		if (!groupBy?.length || !attributes) return "";

		return groupBy
			.map((key) => `${key}=${attributes[key] ?? "null"}`)
			.sort()
			.join("|");
	}

	/**
	 * Extract value based on derivation type
	 */
	private extractValue(derivation: string, span: { duration: number }): number {
		switch (derivation) {
			case "count":
			case "rate":
				return 1;
			case "duration":
			case "p50":
			case "p95":
			case "p99":
			case "avg":
				return span.duration;
			default:
				return 1;
		}
	}

	/**
	 * Get bucket start timestamp for granularity
	 */
	private getBucketStart(timestamp: number, granularity: string): number {
		const date = new Date(timestamp);

		switch (granularity) {
			case "minute":
				date.setSeconds(0, 0);
				break;
			case "hour":
				date.setMinutes(0, 0, 0);
				break;
			case "day":
				date.setHours(0, 0, 0, 0);
				break;
		}

		return date.getTime();
	}

	/**
	 * Cleanup old data based on retention policy
	 */
	cleanup(): { eventsDeleted: number; rollupsDeleted: number } {
		const rawCutoff = Date.now() - this.rawEventRetentionMs;
		const eventsResult = cleanupOldSpanEvents.run(rawCutoff);

		const rollupCutoff = Date.now() - this.rollupRetentionMs;
		const rollupsResult = cleanupOldMetricRollups.run(rollupCutoff);

		console.log(
			`[MetricsIngestion] Cleanup: deleted ${eventsResult.changes} events, ${rollupsResult.changes} rollups`
		);

		return {
			eventsDeleted: eventsResult.changes,
			rollupsDeleted: rollupsResult.changes,
		};
	}

	/**
	 * Query metric data for a time range
	 */
	queryMetric(
		metricId: string,
		granularity: "minute" | "hour" | "day",
		startTime: number,
		endTime: number
	): Array<{ bucketStart: number; dimensionKey: string; count: number; sumValue: number; minValue: number | null; maxValue: number | null; errorCount: number }> {
		const rows = getMetricRollups.all(metricId, granularity, startTime, endTime) as Array<{
			bucket_start: number;
			dimension_key: string;
			count: number;
			sum_value: number;
			min_value: number | null;
			max_value: number | null;
			error_count: number;
		}>;

		return rows.map((row) => ({
			bucketStart: row.bucket_start,
			dimensionKey: row.dimension_key,
			count: row.count,
			sumValue: row.sum_value,
			minValue: row.min_value,
			maxValue: row.max_value,
			errorCount: row.error_count,
		}));
	}

	/**
	 * Get all loaded dashboards
	 */
	getDashboards(): DashboardDefinition[] {
		return this.dashboards;
	}

	/**
	 * Get a specific dashboard by ID
	 */
	getDashboard(dashboardId: string): DashboardDefinition | undefined {
		return this.dashboards.find((d) => d.id === dashboardId);
	}

	/**
	 * Get a specific metric definition
	 */
	getMetricDefinition(metricId: string): MetricDefinition | undefined {
		for (const dashboard of this.dashboards) {
			const metric = dashboard.metrics.find((m) => m.id === metricId);
			if (metric) return metric;
		}
		return undefined;
	}

	/**
	 * Query a dashboard with all its metrics populated
	 */
	queryDashboard(
		dashboardId: string,
		timeRange: string = "last_1h"
	): {
		dashboard: DashboardDefinition;
		metrics: Record<string, { summary: { count: number; sum: number; avg: number; errorCount: number; errorRate: number }; series: Array<{ date: string; value: number }> }>;
	} | null {
		const dashboard = this.getDashboard(dashboardId);
		if (!dashboard) return null;

		// Resolve time range
		const now = Date.now();
		const presetMs: Record<string, number> = {
			last_5m: 5 * 60 * 1000,
			last_15m: 15 * 60 * 1000,
			last_30m: 30 * 60 * 1000,
			last_1h: 60 * 60 * 1000,
			last_3h: 3 * 60 * 60 * 1000,
			last_6h: 6 * 60 * 60 * 1000,
			last_12h: 12 * 60 * 60 * 1000,
			last_24h: 24 * 60 * 60 * 1000,
			last_7d: 7 * 24 * 60 * 60 * 1000,
			last_30d: 30 * 24 * 60 * 60 * 1000,
		};
		const ms = presetMs[timeRange] || presetMs.last_1h;
		const startTime = now - ms;

		// Select granularity based on time range
		const hours = ms / (1000 * 60 * 60);
		const granularity: "minute" | "hour" | "day" = hours <= 2 ? "minute" : hours <= 48 ? "hour" : "day";

		const metrics: Record<string, { summary: { count: number; sum: number; avg: number; errorCount: number; errorRate: number }; series: Array<{ date: string; value: number }> }> = {};

		for (const metric of dashboard.metrics) {
			const rollups = this.queryMetric(metric.id, granularity, startTime, now);

			const totalCount = rollups.reduce((sum, r) => sum + r.count, 0);
			const totalSum = rollups.reduce((sum, r) => sum + r.sumValue, 0);
			const totalErrors = rollups.reduce((sum, r) => sum + r.errorCount, 0);

			// Determine value based on derivation
			const series = rollups.map((r) => {
				let value: number;
				switch (metric.query.derivation) {
					case "count":
						value = r.count;
						break;
					case "sum":
						value = r.sumValue;
						break;
					case "avg":
						value = r.count > 0 ? r.sumValue / r.count : 0;
						break;
					case "error_rate":
						value = r.count > 0 ? (r.errorCount / r.count) * 100 : 0;
						break;
					default:
						value = r.count;
				}
				return {
					date: new Date(r.bucketStart).toISOString(),
					value,
				};
			});

			metrics[metric.id] = {
				summary: {
					count: totalCount,
					sum: totalSum,
					avg: totalCount > 0 ? totalSum / totalCount : 0,
					errorCount: totalErrors,
					errorRate: totalCount > 0 ? (totalErrors / totalCount) * 100 : 0,
				},
				series,
			};
		}

		return { dashboard, metrics };
	}
}

// Create global metrics ingestion service instance
const metricsIngestionService = new MetricsIngestionService();

// ============================================================================
// REGISTRY MANAGER
// ============================================================================

/**
 * RegistryManager - Manages LocalRegistry for trace matching
 *
 * Wraps LocalRegistry from @principal-ai/core and provides:
 * - Workspace registration with FileTree
 * - File reader that reads files from disk using FileTree paths
 * - Cache invalidation on updates
 */
class RegistryManager {
	private registry: InstanceType<typeof import("@principal-ai/principal-view-core").LocalRegistry> | null = null;
	private fsAdapter: InstanceType<typeof import("@principal-ai/principal-view-core").InMemoryFileSystemAdapter> | null = null;
	private fileTrees: Map<string, FileTree> = new Map();
	private workspaceRoots: Map<string, string> = new Map(); // workspaceId -> rootPath
	private initialized = false;

	async initialize(): Promise<boolean> {
		if (this.initialized) return true;

		const loaded = await loadPrincipalCore();
		if (!loaded || !LocalRegistry || !InMemoryFileSystemAdapter) {
			console.error("[RegistryManager] Failed to load @principal-ai/principal-view-core");
			return false;
		}

		// Create file reader that reads from disk using stored workspace roots
		const fileReader = async (path: string): Promise<string> => {
			// Try to read the file from disk
			// The path may be relative to a workspace root or absolute
			try {
				const file = Bun.file(path);
				if (await file.exists()) {
					return await file.text();
				}
			} catch {
				// File not found at absolute path, try workspace roots
			}

			// Try each workspace root
			for (const [, rootPath] of this.workspaceRoots) {
				try {
					const fullPath = path.startsWith("/") ? path : `${rootPath}/${path}`;
					const file = Bun.file(fullPath);
					if (await file.exists()) {
						return await file.text();
					}
				} catch {
					continue;
				}
			}

			throw new Error(`File not found: ${path}`);
		};

		// Create FileSystemAdapter for library discovery
		this.fsAdapter = new InMemoryFileSystemAdapter();

		this.registry = new LocalRegistry(fileReader, this.fsAdapter);
		this.initialized = true;
		console.log("[RegistryManager] Initialized successfully");
		return true;
	}

	/**
	 * Populate the InMemoryFileSystemAdapter with FileTree data
	 * This is necessary for LibraryDiscovery to find and read files
	 *
	 * Optimized to only read relevant files:
	 * - library.yaml files (for service discovery)
	 * - Files in .principal-views directories (for canvas discovery)
	 * - package.json files (for package discovery)
	 */
	private async populateAdapterFromFileTree(fileTree: FileTree, rootPath: string): Promise<void> {
		if (!this.fsAdapter) return;

		const totalFiles = fileTree.allFiles?.length || 0;

		// Filter to only relevant files for library discovery and dashboards
		const relevantFiles = (fileTree.allFiles || []).filter((file) => {
			const relativePath = (file as { relativePath?: string }).relativePath ||
				(file as { path?: string }).path ||
				(file as { name?: string }).name || '';

			return relativePath.includes('.principal-views/') ||
				relativePath.endsWith('library.yaml') ||
				relativePath.endsWith('package.json') ||
				relativePath.endsWith('.dashboard.json');
		});

		console.log(`[RegistryManager] Populating adapter with ${relevantFiles.length} relevant files (of ${totalFiles} total)`);

		let loadedCount = 0;
		let errorCount = 0;

		for (const file of relevantFiles) {
			const relativePath = (file as { relativePath?: string }).relativePath ||
				(file as { path?: string }).path ||
				(file as { name?: string }).name;

			if (!relativePath) continue;

			// Build absolute path
			const absolutePath = relativePath.startsWith("/")
				? relativePath
				: `${rootPath}/${relativePath}`;

			// Check if file has content embedded in FileTree
			const content = (file as { content?: string }).content;

			if (content !== undefined) {
				// Use embedded content
				this.fsAdapter.writeFileSync(absolutePath, content);
				loadedCount++;
			} else {
				// Read content from disk
				try {
					const diskFile = Bun.file(absolutePath);
					if (await diskFile.exists()) {
						const diskContent = await diskFile.text();
						this.fsAdapter.writeFileSync(absolutePath, diskContent);
						loadedCount++;
					}
				} catch (err) {
					// File doesn't exist or can't be read, skip it
					errorCount++;
				}
			}
		}

		console.log(`[RegistryManager] Adapter populated: ${loadedCount} files loaded, ${errorCount} errors`);
	}

	/**
	 * Sync a workspace with its FileTree
	 */
	async syncWorkspace(workspaceId: string, fileTree: FileTree, rootPath?: string): Promise<string[]> {
		if (!await this.initialize()) {
			console.error("[RegistryManager] Cannot sync workspace - not initialized");
			return [];
		}

		// Store the FileTree and root path for file reading
		this.fileTrees.set(workspaceId, fileTree);

		// Determine root path
		let resolvedRootPath: string;
		if (rootPath) {
			resolvedRootPath = rootPath;
			this.workspaceRoots.set(workspaceId, rootPath);
		} else if (fileTree.metadata.sourceInfo?.["rootPath"]) {
			// Try to get rootPath from FileTree metadata
			resolvedRootPath = fileTree.metadata.sourceInfo["rootPath"] as string;
			this.workspaceRoots.set(workspaceId, resolvedRootPath);
		} else if (fileTree.root?.path) {
			// Try to get rootPath from FileTree root
			resolvedRootPath = fileTree.root.path;
			this.workspaceRoots.set(workspaceId, resolvedRootPath);
		} else {
			console.error("[RegistryManager] Cannot determine root path for workspace");
			return [];
		}

		// Populate the InMemoryFileSystemAdapter with FileTree data
		// This is necessary for LibraryDiscovery to find and read files
		await this.populateAdapterFromFileTree(fileTree, resolvedRootPath);

		// Register with LocalRegistry
		const scopeNames = await this.registry!.registerWorkspace(fileTree);

		// Phase 4: Discover and load dashboard definitions
		const dashboards = await this.discoverDashboards(fileTree, resolvedRootPath);
		if (dashboards.length > 0) {
			metricsIngestionService.loadDashboards(dashboards);
			console.log(`[RegistryManager] Loaded ${dashboards.length} dashboards from workspace`);
		}

		console.log(`[RegistryManager] Synced workspace ${workspaceId} with ${scopeNames.length} scopes`);
		return scopeNames;
	}

	/**
	 * Discover .dashboard.json files in the FileTree
	 */
	private async discoverDashboards(fileTree: FileTree, rootPath: string): Promise<DashboardDefinition[]> {
		const dashboards: DashboardDefinition[] = [];

		// Find all .dashboard.json files
		const dashboardFiles = (fileTree.allFiles || []).filter((file) => {
			const relativePath = (file as { relativePath?: string }).relativePath ||
				(file as { path?: string }).path ||
				(file as { name?: string }).name || '';
			return relativePath.endsWith('.dashboard.json');
		});

		console.log(`[RegistryManager] Found ${dashboardFiles.length} dashboard files`);

		for (const file of dashboardFiles) {
			const relativePath = (file as { relativePath?: string }).relativePath ||
				(file as { path?: string }).path ||
				(file as { name?: string }).name;

			if (!relativePath) continue;

			const absolutePath = relativePath.startsWith("/")
				? relativePath
				: `${rootPath}/${relativePath}`;

			try {
				// Check if file has embedded content
				let content = (file as { content?: string }).content;

				if (!content) {
					// Read from disk
					const diskFile = Bun.file(absolutePath);
					if (await diskFile.exists()) {
						content = await diskFile.text();
					}
				}

				if (content) {
					const dashboard = JSON.parse(content) as DashboardDefinition;
					// Ensure required fields
					if (dashboard.id && dashboard.metrics && Array.isArray(dashboard.metrics)) {
						dashboards.push(dashboard);
						console.log(`[RegistryManager] Loaded dashboard: ${dashboard.id} (${dashboard.metrics.length} metrics)`);
					}
				}
			} catch (error) {
				console.error(`[RegistryManager] Failed to load dashboard ${relativePath}:`, error);
			}
		}

		return dashboards;
	}

	/**
	 * Remove a workspace
	 */
	removeWorkspace(workspaceId: string): void {
		this.fileTrees.delete(workspaceId);
		this.workspaceRoots.delete(workspaceId);
		if (this.registry) {
			this.registry.unregisterWorkspace(workspaceId);
		}
		console.log(`[RegistryManager] Removed workspace ${workspaceId}`);
	}

	/**
	 * Invalidate cache for a scope (call when files change)
	 */
	invalidateCache(scopeName: string): void {
		if (this.registry) {
			this.registry.invalidateCache(scopeName);
		}
	}

	/**
	 * Get the LocalRegistry for TraceOrchestrator
	 */
	getRegistry(): InstanceType<typeof import("@principal-ai/principal-view-core").LocalRegistry> | null {
		return this.registry;
	}

	/**
	 * List all registered scopes
	 */
	async listScopes(): Promise<Array<{ name: string; versions: string[] }>> {
		if (!this.registry) return [];
		return this.registry.listScopes();
	}

	/**
	 * Check if any workspaces are registered
	 */
	hasWorkspaces(): boolean {
		return this.fileTrees.size > 0;
	}

	/**
	 * Check if registry is ready
	 */
	isInitialized(): boolean {
		return this.initialized && this.registry !== null;
	}
}

// Create global registry manager instance
const registryManager = new RegistryManager();

// ============================================================================
// TRACE ORCHESTRATOR
// ============================================================================

/**
 * Process a trace through TraceOrchestrator and store the result
 */
async function processAndStoreTrace(
	otlpData: OtelExportTraceServiceRequest
): Promise<RegisteredTrace | null> {
	// Check if registry has any workspaces
	if (!registryManager.hasWorkspaces()) {
		console.log("[TraceOrchestrator] No workspaces registered, skipping trace matching");
		return null;
	}

	// Ensure principal-view-core is loaded
	if (!await loadPrincipalCore() || !TraceOrchestrator) {
		console.log("[TraceOrchestrator] @principal-ai/principal-view-core not loaded, skipping trace matching");
		return null;
	}

	// Ensure registry is initialized
	if (!registryManager.isInitialized()) {
		console.log("[TraceOrchestrator] Registry not initialized, skipping trace matching");
		return null;
	}

	const scopes = await registryManager.listScopes();
	if (scopes.length === 0) {
		console.log("[TraceOrchestrator] No scopes registered, skipping trace matching");
		return null;
	}

	const registry = registryManager.getRegistry();
	if (!registry) {
		console.log("[TraceOrchestrator] Registry not available, skipping trace matching");
		return null;
	}

	try {
		// Create orchestrator and process trace
		const orchestrator = new TraceOrchestrator({
			registry,
			enableValidation: true,
		});

		const registeredTrace = await orchestrator.processTrace(otlpData);

		// Store the registered trace
		const now = Date.now();
		insertRegisteredTrace.run({
			$trace_id: registeredTrace.traceId,
			$name: registeredTrace.name,
			$start_time: registeredTrace.startTime,
			$end_time: registeredTrace.endTime,
			$duration_ms: registeredTrace.duration,
			$span_count: registeredTrace.spanCount,
			$has_errors: registeredTrace.hasErrors ? 1 : 0,
			$scenario_match_count: registeredTrace.scenarioMatches.length,
			$storyboard_match_count: registeredTrace.storyboardMatches.length,
			$unmatched_span_count: registeredTrace.unmatchedSpans.spans.length,
			$registered_trace_json: JSON.stringify(registeredTrace),
			$received_at: now,
			$processed_at: now,
		});

		// Store matched spans from scenario matches
		for (const scenarioMatch of registeredTrace.scenarioMatches) {
			for (const span of scenarioMatch.matchedSpans) {
				insertMatchedSpan.run({
					$id: `${registeredTrace.traceId}-${span.spanId}`,
					$trace_id: registeredTrace.traceId,
					$span_id: span.spanId,
					$parent_span_id: span.parentSpanId || null,
					$match_type: "scenario",
					$storyboard_id: scenarioMatch.storyboardId,
					$workflow_id: scenarioMatch.workflowId,
					$scenario_id: scenarioMatch.scenarioId,
					$node_id: span.nodeId,
					$scope_name: scenarioMatch.scopeName,
					$scope_version: scenarioMatch.scopeVersion || null,
					$span_name: span.spanName,
					$duration_ms: span.duration,
					$timestamp: span.timestamp,
					$is_error: 0,
					$matched_events: JSON.stringify(span.events),
					$attributes: JSON.stringify(span.attributes || {}),
					$orphan_reason: null,
					$received_at: now,
				});
			}
		}

		// Store orphaned spans from storyboard matches
		for (const storyboardMatch of registeredTrace.storyboardMatches) {
			for (const span of storyboardMatch.orphanedSpans) {
				insertMatchedSpan.run({
					$id: `${registeredTrace.traceId}-${span.spanId}`,
					$trace_id: registeredTrace.traceId,
					$span_id: span.spanId,
					$parent_span_id: span.parentSpanId || null,
					$match_type: "storyboard",
					$storyboard_id: storyboardMatch.storyboardId,
					$workflow_id: storyboardMatch.workflowId,
					$scenario_id: null,
					$node_id: span.nodeId,
					$scope_name: storyboardMatch.scopeName,
					$scope_version: storyboardMatch.scopeVersion || null,
					$span_name: span.spanName,
					$duration_ms: span.duration,
					$timestamp: span.timestamp,
					$is_error: 0,
					$matched_events: JSON.stringify(span.observedEvents),
					$attributes: JSON.stringify(span.attributes || {}),
					$orphan_reason: span.reason,
					$received_at: now,
				});
			}
		}

		// Store unmatched spans
		for (const span of registeredTrace.unmatchedSpans.spans) {
			insertMatchedSpan.run({
				$id: `${registeredTrace.traceId}-${span.spanId}`,
				$trace_id: registeredTrace.traceId,
				$span_id: span.spanId,
				$parent_span_id: span.parentSpanId || null,
				$match_type: "unmatched",
				$storyboard_id: null,
				$workflow_id: null,
				$scenario_id: null,
				$node_id: null,
				$scope_name: span.scopeName,
				$scope_version: span.scopeVersion || null,
				$span_name: span.spanName,
				$duration_ms: span.duration,
				$timestamp: span.timestamp,
				$is_error: 0,
				$matched_events: null,
				$attributes: JSON.stringify(span.attributes || {}),
				$orphan_reason: span.reason,
				$received_at: now,
			});
		}

		// Phase 3: Ingest into metrics aggregation (if dashboards are loaded)
		let affectedDashboardIds: string[] = [];
		if (metricsIngestionService.isReady()) {
			const metricsResult = await metricsIngestionService.ingestTrace(registeredTrace);
			affectedDashboardIds = metricsResult.affectedDashboardIds;
		}

		return { trace: registeredTrace, affectedDashboardIds };
	} catch (error) {
		console.error("[TraceOrchestrator] Error processing trace:", error);
		return null;
	}
}

// ============================================================================
// OTLP INGESTION
// ============================================================================

interface OTLPAttribute {
	key: string;
	value: {
		stringValue?: string;
		intValue?: string | number;
		boolValue?: boolean;
		doubleValue?: number;
		arrayValue?: { values: OTLPAttribute["value"][] };
	};
}

interface OTLPSpan {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	kind?: number;
	startTimeUnixNano: string;
	endTimeUnixNano?: string;
	attributes?: OTLPAttribute[];
	events?: Array<{
		name: string;
		timeUnixNano: string;
		attributes?: OTLPAttribute[];
	}>;
	status?: {
		code?: number;
		message?: string;
	};
}

interface OTLPResourceSpan {
	resource?: {
		attributes?: OTLPAttribute[];
	};
	scopeSpans?: Array<{
		scope?: { name?: string; version?: string };
		spans?: OTLPSpan[];
	}>;
}

interface OTLPTraceRequest {
	resourceSpans?: OTLPResourceSpan[];
}

function extractAttributeValue(attr: OTLPAttribute): unknown {
	const v = attr.value;
	if (v.stringValue !== undefined) return v.stringValue;
	if (v.intValue !== undefined) return Number(v.intValue);
	if (v.boolValue !== undefined) return v.boolValue;
	if (v.doubleValue !== undefined) return v.doubleValue;
	if (v.arrayValue !== undefined) {
		return v.arrayValue.values.map((val) => {
			if (val.stringValue !== undefined) return val.stringValue;
			if (val.intValue !== undefined) return Number(val.intValue);
			if (val.boolValue !== undefined) return val.boolValue;
			if (val.doubleValue !== undefined) return val.doubleValue;
			return null;
		});
	}
	return null;
}

function attributesToObject(attrs?: OTLPAttribute[]): Record<string, unknown> {
	if (!attrs) return {};
	const result: Record<string, unknown> = {};
	for (const attr of attrs) {
		result[attr.key] = extractAttributeValue(attr);
	}
	return result;
}

function ingestOTLPTraces(request: OTLPTraceRequest): number {
	let count = 0;
	const now = Date.now();

	if (!request.resourceSpans) return 0;

	for (const resourceSpan of request.resourceSpans) {
		// Extract service info from resource attributes
		const resourceAttrs = attributesToObject(resourceSpan.resource?.attributes);
		const serviceName = (resourceAttrs["service.name"] as string) || "unknown";
		const serviceVersion = (resourceAttrs["service.version"] as string) || null;

		if (!resourceSpan.scopeSpans) continue;

		for (const scopeSpan of resourceSpan.scopeSpans) {
			if (!scopeSpan.spans) continue;

			for (const span of scopeSpan.spans) {
				const startTime = BigInt(span.startTimeUnixNano);
				const endTime = span.endTimeUnixNano ? BigInt(span.endTimeUnixNano) : null;
				const durationMs = endTime ? Number(endTime - startTime) / 1_000_000 : null;

				insertSpan.run({
					$id: `${span.traceId}-${span.spanId}`,
					$trace_id: span.traceId,
					$span_id: span.spanId,
					$parent_span_id: span.parentSpanId || null,
					$service_name: serviceName,
					$service_version: serviceVersion,
					$name: span.name,
					$kind: span.kind || 0,
					$start_time: Number(startTime),
					$end_time: endTime ? Number(endTime) : null,
					$duration_ms: durationMs,
					$status_code: span.status?.code || 0,
					$status_message: span.status?.message || null,
					$attributes: JSON.stringify(attributesToObject(span.attributes)),
					$events: JSON.stringify(
						span.events?.map((e) => ({
							name: e.name,
							time: e.timeUnixNano,
							attributes: attributesToObject(e.attributes),
						})) || []
					),
					$received_at: now,
				});
				count++;
			}
		}
	}

	return count;
}

// ============================================================================
// HTTP SERVER
// ============================================================================

const HTTP_PORT = 4321;

const httpServer = Bun.serve({
	port: HTTP_PORT,
	async fetch(req: Request) {
		const url = new URL(req.url);

		// CORS headers
		const corsHeaders = {
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
			"Access-Control-Allow-Headers": "Content-Type",
		};

		// Handle preflight
		if (req.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: corsHeaders });
		}

		// Health check
		if (req.method === "GET" && url.pathname === "/health") {
			return Response.json({ status: "ok" }, { headers: corsHeaders });
		}

		// OTLP traces endpoint
		if (req.method === "POST" && url.pathname === "/v1/traces") {
			try {
				const body = (await req.json()) as OTLPTraceRequest;
				const count = ingestOTLPTraces(body);

				// Process through TraceOrchestrator if registry is available
				// Cast to OtelExportTraceServiceRequest for TraceOrchestrator
				const processResult = await processAndStoreTrace(
					body as unknown as OtelExportTraceServiceRequest
				);
				const registeredTrace = processResult?.trace;
				const affectedDashboardIds = processResult?.affectedDashboardIds || [];

				// Notify webview of new spans
				if (count > 0 && eventsRPC?.send) {
					try {
						eventsRPC.send.newSpansReceived({ count });
						// Also notify about registered trace if we got one
						if (registeredTrace) {
							eventsRPC.send.traceMatched({
								traceId: registeredTrace.traceId,
								scenarioMatches: registeredTrace.scenarioMatches.length,
								storyboardMatches: registeredTrace.storyboardMatches.length,
								unmatchedSpans: registeredTrace.unmatchedSpans.spans.length,
							});
						}
						// Notify about dashboard updates
						if (affectedDashboardIds.length > 0) {
							eventsRPC.send.dashboardsUpdated({ dashboardIds: affectedDashboardIds });
						}
					} catch {
						// RPC not ready yet, webview will poll
					}
				}

				return Response.json(
					{
						accepted: count,
						matched: registeredTrace
							? {
									traceId: registeredTrace.traceId,
									scenarioMatches: registeredTrace.scenarioMatches.length,
									storyboardMatches: registeredTrace.storyboardMatches.length,
									unmatchedSpans: registeredTrace.unmatchedSpans.spans.length,
								}
							: null,
					},
					{ headers: corsHeaders }
				);
			} catch (error) {
				console.error("Error ingesting traces:", error);
				return Response.json(
					{ error: "Failed to ingest traces" },
					{ status: 400, headers: corsHeaders }
				);
			}
		}

		// Registry sync endpoint (push from desktop app)
		if (req.method === "POST" && url.pathname === "/api/registry/sync") {
			try {
				const body = (await req.json()) as {
					action: "update" | "remove";
					workspace: {
						id: string;
						rootPath: string;
						name?: string;
						sha?: string;
					};
					fileTree?: FileTree;
					scopeNames?: string[];
					timestamp: number;
				};

				if (body.action === "update") {
					const now = Date.now();
					let discoveredScopes: string[] = body.scopeNames || [];

					// FileTree is required for trace matching
					if (!body.fileTree) {
						return Response.json(
							{ error: "fileTree is required for registry sync" },
							{ status: 400, headers: corsHeaders }
						);
					}

					console.log(`Registry sync: FileTree for ${body.workspace.id}:`);
					console.log(`  - SHA: ${body.fileTree.sha}`);
					console.log(`  - Total files: ${body.fileTree.allFiles?.length || 0}`);
					console.log(`  - Root path: ${body.fileTree.root?.path || body.workspace.rootPath || 'unknown'}`);

					// Register with RegistryManager for trace matching
					try {
						discoveredScopes = await registryManager.syncWorkspace(
							body.workspace.id,
							body.fileTree,
							body.workspace.rootPath
						);
						console.log(
							`Registry sync: registered workspace ${body.workspace.id} with FileTree, ` +
								`discovered ${discoveredScopes.length} scopes`
						);
					} catch (error) {
						console.error("Error registering workspace with RegistryManager:", error);
						return Response.json(
							{ error: "Failed to register workspace with RegistryManager" },
							{ status: 500, headers: corsHeaders }
						);
					}

					// Verify that scopes were discovered
					if (discoveredScopes.length === 0) {
						return Response.json(
							{
								error: "No scopes discovered in workspace",
								details: "Make sure library.yaml has a resources section with service.name attributes",
								workspace: body.workspace.id,
							},
							{ status: 400, headers: corsHeaders }
						);
					}

					// Update database
					upsertWorkspace.run({
						$workspace_id: body.workspace.id,
						$root_path: body.workspace.rootPath,
						$name: body.workspace.name || null,
						$sha: body.workspace.sha || null,
						$scope_names: JSON.stringify(discoveredScopes),
						$now: now,
					});
					console.log(`Registry sync: updated workspace ${body.workspace.id}`);

					// Notify webview
					if (eventsRPC?.send) {
						try {
							eventsRPC.send.registryUpdated({ workspaceId: body.workspace.id });
						} catch {
							// RPC not ready
						}
					}

					return Response.json(
						{ success: true, registeredScopes: discoveredScopes },
						{ headers: corsHeaders }
					);
				} else if (body.action === "remove") {
					// Remove from RegistryManager
					registryManager.removeWorkspace(body.workspace.id);

					// Update database
					deactivateWorkspace.run(body.workspace.id);
					console.log(`Registry sync: removed workspace ${body.workspace.id}`);

					// Notify webview
					if (eventsRPC?.send) {
						try {
							eventsRPC.send.registryUpdated({ workspaceId: body.workspace.id });
						} catch {
							// RPC not ready
						}
					}

					return Response.json({ success: true }, { headers: corsHeaders });
				}

				return Response.json(
					{ error: "Invalid action" },
					{ status: 400, headers: corsHeaders }
				);
			} catch (error) {
				console.error("Error syncing registry:", error);
				return Response.json(
					{ error: "Failed to sync registry" },
					{ status: 400, headers: corsHeaders }
				);
			}
		}

		// Registry status endpoint (for debugging)
		if (req.method === "GET" && url.pathname === "/api/registry/status") {
			const rows = getActiveWorkspaces.all() as Array<{
				workspace_id: string;
				root_path: string;
				name: string | null;
				sha: string | null;
				scope_names: string | null;
				first_synced_at: number;
				last_synced_at: number;
			}>;

			return Response.json(
				{
					workspaces: rows.map((row) => ({
						workspaceId: row.workspace_id,
						rootPath: row.root_path,
						name: row.name,
						sha: row.sha,
						scopeNames: row.scope_names ? JSON.parse(row.scope_names) : [],
						firstSyncedAt: row.first_synced_at,
						lastSyncedAt: row.last_synced_at,
					})),
				},
				{ headers: corsHeaders }
			);
		}

		// Phase 3: Metrics query endpoint
		if (req.method === "GET" && url.pathname.startsWith("/api/metrics/")) {
			const metricId = url.pathname.slice("/api/metrics/".length);
			if (!metricId) {
				return Response.json(
					{ error: "metricId is required" },
					{ status: 400, headers: corsHeaders }
				);
			}

			// Parse query parameters
			const timeRange = url.searchParams.get("timeRange") || "last_1h";
			const granularity = (url.searchParams.get("granularity") || "minute") as "minute" | "hour" | "day";

			// Resolve time range
			const now = Date.now();
			const presetMs: Record<string, number> = {
				last_5m: 5 * 60 * 1000,
				last_15m: 15 * 60 * 1000,
				last_30m: 30 * 60 * 1000,
				last_1h: 60 * 60 * 1000,
				last_3h: 3 * 60 * 60 * 1000,
				last_6h: 6 * 60 * 60 * 1000,
				last_12h: 12 * 60 * 60 * 1000,
				last_24h: 24 * 60 * 60 * 1000,
				last_7d: 7 * 24 * 60 * 60 * 1000,
				last_30d: 30 * 24 * 60 * 60 * 1000,
			};
			const ms = presetMs[timeRange] || presetMs.last_1h;
			const startTime = now - ms;
			const endTime = now;

			// Query rollups
			const rollups = metricsIngestionService.queryMetric(metricId, granularity, startTime, endTime);

			// Transform to time series format
			const series = rollups.map((r) => ({
				date: new Date(r.bucketStart).toISOString(),
				bucketStart: r.bucketStart,
				dimensionKey: r.dimensionKey,
				count: r.count,
				sum: r.sumValue,
				avg: r.count > 0 ? r.sumValue / r.count : 0,
				min: r.minValue,
				max: r.maxValue,
				errorCount: r.errorCount,
				errorRate: r.count > 0 ? (r.errorCount / r.count) * 100 : 0,
			}));

			// Compute current period totals
			const totalCount = rollups.reduce((sum, r) => sum + r.count, 0);
			const totalSum = rollups.reduce((sum, r) => sum + r.sumValue, 0);
			const totalErrors = rollups.reduce((sum, r) => sum + r.errorCount, 0);

			return Response.json(
				{
					metricId,
					timeRange,
					granularity,
					startTime,
					endTime,
					series,
					summary: {
						count: totalCount,
						sum: totalSum,
						avg: totalCount > 0 ? totalSum / totalCount : 0,
						errorCount: totalErrors,
						errorRate: totalCount > 0 ? (totalErrors / totalCount) * 100 : 0,
					},
				},
				{ headers: corsHeaders }
			);
		}

		// Phase 3: Load dashboard definitions endpoint
		if (req.method === "POST" && url.pathname === "/api/dashboards/load") {
			try {
				const body = await req.json() as { dashboards: DashboardDefinition[] };
				if (!body.dashboards || !Array.isArray(body.dashboards)) {
					return Response.json(
						{ error: "dashboards array is required" },
						{ status: 400, headers: corsHeaders }
					);
				}

				metricsIngestionService.loadDashboards(body.dashboards);

				return Response.json(
					{
						success: true,
						metricsLoaded: body.dashboards.reduce((sum, d) => sum + d.metrics.length, 0),
					},
					{ headers: corsHeaders }
				);
			} catch (error) {
				console.error("Error loading dashboards:", error);
				return Response.json(
					{ error: "Failed to load dashboards" },
					{ status: 500, headers: corsHeaders }
				);
			}
		}

		// Phase 3: Trigger cleanup endpoint
		if (req.method === "POST" && url.pathname === "/api/metrics/cleanup") {
			const result = metricsIngestionService.cleanup();
			return Response.json(result, { headers: corsHeaders });
		}

		// Debug: Get recent span events
		if (req.method === "GET" && url.pathname === "/api/debug/span-events") {
			const limit = parseInt(url.searchParams.get("limit") || "50");
			const events = db
				.query(
					`SELECT id, timestamp, storyboard_id, workflow_id, scenario_id, node_id, span_name, duration_ms, is_error
					 FROM span_events ORDER BY timestamp DESC LIMIT ?`
				)
				.all(limit);
			return Response.json({ events, total: events.length }, { headers: corsHeaders });
		}

		// Phase 4: Get all dashboards
		if (req.method === "GET" && url.pathname === "/api/dashboards") {
			const dashboards = metricsIngestionService.getDashboards();
			return Response.json(
				{
					dashboards: dashboards.map((d) => ({
						id: d.id,
						name: d.name,
						metricsCount: d.metrics.length,
					})),
					total: dashboards.length,
				},
				{ headers: corsHeaders }
			);
		}

		// Phase 4: Get a specific dashboard with metrics data
		if (req.method === "GET" && url.pathname.startsWith("/api/dashboards/") && !url.pathname.includes("/load")) {
			const dashboardId = url.pathname.slice("/api/dashboards/".length);
			if (!dashboardId) {
				return Response.json(
					{ error: "dashboardId is required" },
					{ status: 400, headers: corsHeaders }
				);
			}

			const timeRange = url.searchParams.get("timeRange") || "last_1h";
			const result = metricsIngestionService.queryDashboard(dashboardId, timeRange);

			if (!result) {
				return Response.json(
					{ error: `Dashboard not found: ${dashboardId}` },
					{ status: 404, headers: corsHeaders }
				);
			}

			return Response.json(result, { headers: corsHeaders });
		}

		return new Response("Not found", { status: 404, headers: corsHeaders });
	},
});

console.log(`HTTP server running at http://localhost:${HTTP_PORT}`);

// ============================================================================
// PHASE 3: CLEANUP JOB
// ============================================================================

// Run cleanup every hour
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

setInterval(() => {
	console.log("[Cleanup] Running scheduled cleanup...");
	const result = metricsIngestionService.cleanup();
	console.log(`[Cleanup] Deleted ${result.eventsDeleted} events, ${result.rollupsDeleted} rollups`);
}, CLEANUP_INTERVAL_MS);

// Run initial cleanup on startup (after 5 seconds to let things settle)
setTimeout(() => {
	console.log("[Cleanup] Running initial cleanup...");
	metricsIngestionService.cleanup();
}, 5000);

// ============================================================================
// RPC TYPES
// ============================================================================

type Span = {
	id: string;
	trace_id: string;
	span_id: string;
	parent_span_id: string | null;
	service_name: string | null;
	service_version: string | null;
	name: string;
	kind: number;
	start_time: number;
	end_time: number | null;
	duration_ms: number | null;
	status_code: number;
	status_message: string | null;
	attributes: string;
	events: string;
	received_at: number;
};

type Stats = {
	total: number;
	errorCount: number;
	avgDuration: number | null;
};

type ServiceSummary = {
	name: string;
	count: number;
};

type RegistryWorkspace = {
	workspaceId: string;
	rootPath: string;
	name: string | null;
	sha: string | null;
	scopeNames: string[];
	firstSyncedAt: number;
	lastSyncedAt: number;
	isActive: boolean;
};

type RegistryStatus = {
	workspaces: RegistryWorkspace[];
	totalScopes: number;
	lastSyncAt: number | null;
};

// Phase 2: Registered trace types
type RegisteredTraceRow = {
	trace_id: string;
	name: string;
	start_time: number;
	end_time: number;
	duration_ms: number;
	span_count: number;
	has_errors: number;
	scenario_match_count: number;
	storyboard_match_count: number;
	unmatched_span_count: number;
	registered_trace_json: string;
	received_at: number;
	processed_at: number;
};

type RegisteredTraceSummary = {
	traceId: string;
	name: string;
	startTime: number;
	endTime: number;
	durationMs: number;
	spanCount: number;
	hasErrors: boolean;
	scenarioMatchCount: number;
	storyboardMatchCount: number;
	unmatchedSpanCount: number;
	receivedAt: number;
};

type MatchedSpanRow = {
	id: string;
	trace_id: string;
	span_id: string;
	parent_span_id: string | null;
	match_type: string;
	storyboard_id: string | null;
	workflow_id: string | null;
	scenario_id: string | null;
	node_id: string | null;
	scope_name: string | null;
	scope_version: string | null;
	span_name: string;
	duration_ms: number | null;
	timestamp: number;
	is_error: number;
	matched_events: string | null;
	attributes: string | null;
	orphan_reason: string | null;
	received_at: number;
};

type MatchedSpanSummary = {
	id: string;
	traceId: string;
	spanId: string;
	parentSpanId: string | null;
	matchType: "scenario" | "storyboard" | "unmatched";
	storyboardId: string | null;
	workflowId: string | null;
	scenarioId: string | null;
	nodeId: string | null;
	scopeName: string | null;
	scopeVersion: string | null;
	spanName: string;
	durationMs: number | null;
	timestamp: number;
	isError: boolean;
	matchedEvents: string[];
	orphanReason: string | null;
};

type RegisteredTraceStats = {
	total: number;
	errorCount: number;
	totalScenarioMatches: number;
	totalStoryboardMatches: number;
	totalUnmatchedSpans: number;
	avgDuration: number | null;
};

type EventsRPC = {
	bun: RPCSchema<{
		requests: {
			getRecentSpans: {
				params: { limit?: number; offset?: number; serviceName?: string };
				response: Span[];
			};
			getSpansByTrace: {
				params: { traceId: string };
				response: Span[];
			};
			getStats: {
				params: {};
				response: Stats;
			};
			clearOldSpans: {
				params: { olderThanMs: number };
				response: { deleted: number };
			};
			getServiceSummaries: {
				params: {};
				response: ServiceSummary[];
			};
			getRegistryStatus: {
				params: {};
				response: RegistryStatus;
			};
			// Phase 2: Registered trace methods
			getRegisteredTraces: {
				params: { limit?: number; offset?: number; hasErrors?: boolean };
				response: RegisteredTraceSummary[];
			};
			getRegisteredTraceById: {
				params: { traceId: string };
				response: { trace: RegisteredTraceSummary; fullTrace: RegisteredTrace } | null;
			};
			getMatchedSpansByTrace: {
				params: { traceId: string };
				response: MatchedSpanSummary[];
			};
			getRegisteredTraceStats: {
				params: {};
				response: RegisteredTraceStats;
			};
			// Phase 4: Dashboard methods
			getDashboards: {
				params: {};
				response: Array<{ id: string; name: string; metricsCount: number }>;
			};
			getDashboard: {
				params: { dashboardId: string; timeRange?: string };
				response: {
					dashboard: { id: string; name: string; metrics: Array<{ id: string; name: string; type: string }> };
					metrics: Record<string, {
						summary: { count: number; sum: number; avg: number; errorCount: number; errorRate: number };
						series: Array<{ date: string; value: number }>;
					}>;
				} | null;
			};
		};
		messages: {
			newSpansReceived: { count: number };
			registryUpdated: { workspaceId: string };
			traceMatched: {
				traceId: string;
				scenarioMatches: number;
				storyboardMatches: number;
				unmatchedSpans: number;
			};
			dashboardsUpdated: { dashboardIds: string[] };
		};
	}>;
	webview: RPCSchema<{
		requests: {};
		messages: {};
	}>;
};

// ============================================================================
// RPC HANDLERS
// ============================================================================

const eventsRPC = BrowserView.defineRPC<EventsRPC>({
	maxRequestTime: 5000,
	handlers: {
		requests: {
			getRecentSpans: ({ limit = 100, offset = 0, serviceName }) => {
				if (serviceName) {
					return getRecentSpansByService.all(serviceName, limit, offset) as Span[];
				}
				return getRecentSpans.all(limit, offset) as Span[];
			},
			getSpansByTrace: ({ traceId }) => {
				return getSpansByTrace.all(traceId) as Span[];
			},
			getStats: () => {
				const row = getStats.get() as {
					total: number;
					error_count: number;
					avg_duration: number | null;
				};
				return {
					total: row.total,
					errorCount: row.error_count || 0,
					avgDuration: row.avg_duration,
				};
			},
			clearOldSpans: ({ olderThanMs }) => {
				const cutoff = Date.now() - olderThanMs;
				const result = clearOldSpans.run(cutoff);
				return { deleted: result.changes };
			},
			getServiceSummaries: () => {
				const rows = getServiceSummaries.all() as { service_name: string; count: number }[];
				return rows.map((row) => ({
					name: row.service_name || "unknown",
					count: row.count,
				}));
			},
			getRegistryStatus: () => {
				const rows = getActiveWorkspaces.all() as Array<{
					workspace_id: string;
					root_path: string;
					name: string | null;
					sha: string | null;
					scope_names: string | null;
					first_synced_at: number;
					last_synced_at: number;
					is_active: number;
				}>;

				const workspaces: RegistryWorkspace[] = rows.map((row) => ({
					workspaceId: row.workspace_id,
					rootPath: row.root_path,
					name: row.name,
					sha: row.sha,
					scopeNames: row.scope_names ? JSON.parse(row.scope_names) : [],
					firstSyncedAt: row.first_synced_at,
					lastSyncedAt: row.last_synced_at,
					isActive: row.is_active === 1,
				}));

				const totalScopes = workspaces.reduce((sum, w) => sum + w.scopeNames.length, 0);
				const lastSyncAt = workspaces.length > 0
					? Math.max(...workspaces.map((w) => w.lastSyncedAt))
					: null;

				return { workspaces, totalScopes, lastSyncAt };
			},

			// Phase 2: Registered trace handlers
			getRegisteredTraces: ({ limit = 100, offset = 0, hasErrors }) => {
				let rows: RegisteredTraceRow[];
				if (hasErrors !== undefined) {
					const stmt = db.prepare(`
						SELECT * FROM registered_traces
						WHERE has_errors = ?
						ORDER BY received_at DESC LIMIT ? OFFSET ?
					`);
					rows = stmt.all(hasErrors ? 1 : 0, limit, offset) as RegisteredTraceRow[];
				} else {
					rows = getRecentRegisteredTraces.all(limit, offset) as RegisteredTraceRow[];
				}

				return rows.map((row) => ({
					traceId: row.trace_id,
					name: row.name,
					startTime: row.start_time,
					endTime: row.end_time,
					durationMs: row.duration_ms,
					spanCount: row.span_count,
					hasErrors: row.has_errors === 1,
					scenarioMatchCount: row.scenario_match_count,
					storyboardMatchCount: row.storyboard_match_count,
					unmatchedSpanCount: row.unmatched_span_count,
					receivedAt: row.received_at,
				}));
			},

			getRegisteredTraceById: ({ traceId }) => {
				const row = getRegisteredTraceById.get(traceId) as RegisteredTraceRow | null;
				if (!row) return null;

				const trace: RegisteredTraceSummary = {
					traceId: row.trace_id,
					name: row.name,
					startTime: row.start_time,
					endTime: row.end_time,
					durationMs: row.duration_ms,
					spanCount: row.span_count,
					hasErrors: row.has_errors === 1,
					scenarioMatchCount: row.scenario_match_count,
					storyboardMatchCount: row.storyboard_match_count,
					unmatchedSpanCount: row.unmatched_span_count,
					receivedAt: row.received_at,
				};

				let fullTrace: RegisteredTrace | null = null;
				try {
					fullTrace = JSON.parse(row.registered_trace_json) as RegisteredTrace;
				} catch {
					console.error("Failed to parse registered_trace_json for trace:", traceId);
				}

				return { trace, fullTrace: fullTrace as RegisteredTrace };
			},

			getMatchedSpansByTrace: ({ traceId }) => {
				const rows = getMatchedSpansByTrace.all(traceId) as MatchedSpanRow[];

				return rows.map((row) => ({
					id: row.id,
					traceId: row.trace_id,
					spanId: row.span_id,
					parentSpanId: row.parent_span_id,
					matchType: row.match_type as "scenario" | "storyboard" | "unmatched",
					storyboardId: row.storyboard_id,
					workflowId: row.workflow_id,
					scenarioId: row.scenario_id,
					nodeId: row.node_id,
					scopeName: row.scope_name,
					scopeVersion: row.scope_version,
					spanName: row.span_name,
					durationMs: row.duration_ms,
					timestamp: row.timestamp,
					isError: row.is_error === 1,
					matchedEvents: row.matched_events ? JSON.parse(row.matched_events) : [],
					orphanReason: row.orphan_reason,
				}));
			},

			getRegisteredTraceStats: () => {
				const row = getRegisteredTraceStats.get() as {
					total: number;
					error_count: number;
					total_scenario_matches: number;
					total_storyboard_matches: number;
					total_unmatched_spans: number;
					avg_duration: number | null;
				};

				return {
					total: row.total || 0,
					errorCount: row.error_count || 0,
					totalScenarioMatches: row.total_scenario_matches || 0,
					totalStoryboardMatches: row.total_storyboard_matches || 0,
					totalUnmatchedSpans: row.total_unmatched_spans || 0,
					avgDuration: row.avg_duration,
				};
			},

			// Phase 4: Dashboard handlers
			getDashboards: () => {
				const dashboards = metricsIngestionService.getDashboards();
				return dashboards.map((d) => ({
					id: d.id,
					name: d.name || d.id,
					metricsCount: d.metrics.length,
				}));
			},

			getDashboard: ({ dashboardId, timeRange = "last_1h" }) => {
				const result = metricsIngestionService.queryDashboard(dashboardId, timeRange);
				if (!result) return null;

				return {
					dashboard: {
						id: result.dashboard.id,
						name: result.dashboard.name || result.dashboard.id,
						metrics: result.dashboard.metrics.map((m) => ({
							id: m.id,
							name: m.name,
							type: m.type,
						})),
					},
					metrics: result.metrics,
				};
			},
		},
		messages: {},
	},
});

// ============================================================================
// WINDOW SETUP
// ============================================================================

const mainWindow = new BrowserWindow({
	title: "OTEL Events Manager",
	url: "views://mainview/index.html",
	rpc: eventsRPC,
	frame: {
		width: 1000,
		height: 700,
		x: 100,
		y: 100,
	},
});

console.log("OTEL Events Manager started!");
console.log(`Database: ${dbPath}`);
console.log(`HTTP API: http://localhost:${HTTP_PORT}/v1/traces`);
