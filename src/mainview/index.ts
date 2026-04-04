import Electrobun, { Electroview } from "electrobun/view";

// ============================================================================
// TYPES
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

// Phase 4: Dashboard types
type DashboardSummary = {
	id: string;
	name: string;
	metricsCount: number;
};

type MetricSummary = {
	id: string;
	name: string;
	type: string;
};

type MetricData = {
	summary: {
		count: number;
		sum: number;
		avg: number;
		errorCount: number;
		errorRate: number;
	};
	series: Array<{ date: string; value: number }>;
};

type DashboardData = {
	dashboard: {
		id: string;
		name: string;
		metrics: MetricSummary[];
	};
	metrics: Record<string, MetricData>;
};

type EventsRPC = {
	bun: {
		requests: {
			getRecentSpans: { params: { limit?: number; offset?: number; serviceName?: string }; response: Span[] };
			getSpansByTrace: { params: { traceId: string }; response: Span[] };
			getStats: { params: {}; response: Stats };
			clearOldSpans: { params: { olderThanMs: number }; response: { deleted: number } };
			getServiceSummaries: { params: {}; response: ServiceSummary[] };
			getRegistryStatus: { params: {}; response: RegistryStatus };
			// Phase 2: Registered trace methods
			getRegisteredTraces: { params: { limit?: number; offset?: number; hasErrors?: boolean }; response: RegisteredTraceSummary[] };
			getRegisteredTraceById: { params: { traceId: string }; response: { trace: RegisteredTraceSummary; fullTrace: unknown } | null };
			getMatchedSpansByTrace: { params: { traceId: string }; response: MatchedSpanSummary[] };
			getRegisteredTraceStats: { params: {}; response: RegisteredTraceStats };
			// Phase 4: Dashboard methods
			getDashboards: { params: {}; response: DashboardSummary[] };
			getDashboard: { params: { dashboardId: string; timeRange?: string }; response: DashboardData | null };
		};
		messages: {
			newSpansReceived: { count: number };
			registryUpdated: { workspaceId: string };
			traceMatched: { traceId: string; scenarioMatches: number; storyboardMatches: number; unmatchedSpans: number };
			dashboardsUpdated: { dashboardIds: string[] };
		};
	};
	webview: {
		requests: {};
		messages: {};
	};
};

// ============================================================================
// RPC SETUP
// ============================================================================

const rpc = Electroview.defineRPC<EventsRPC>({
	maxRequestTime: 5000,
	handlers: {
		requests: {},
		messages: {
			newSpansReceived: ({ count }: { count: number }) => {
				console.log(`Received ${count} new spans`);
				loadSpans();
			},
			registryUpdated: ({ workspaceId }: { workspaceId: string }) => {
				console.log(`Registry updated: ${workspaceId}`);
				loadRegistry();
			},
			traceMatched: ({ traceId, scenarioMatches, storyboardMatches, unmatchedSpans }: { traceId: string; scenarioMatches: number; storyboardMatches: number; unmatchedSpans: number }) => {
				console.log(`Trace matched: ${traceId} - ${scenarioMatches} scenarios, ${storyboardMatches} storyboards, ${unmatchedSpans} unmatched`);
				loadRegisteredTraces();
				loadRegisteredTraceStats();
			},
			dashboardsUpdated: ({ dashboardIds }: { dashboardIds: string[] }) => {
				console.log(`Dashboards updated: ${dashboardIds.join(", ")}`);
				loadDashboards();
				if (selectedDashboard && dashboardIds.includes(selectedDashboard.id)) {
					loadDashboardData(selectedDashboard.id);
				}
			},
		},
	},
});

const electrobun = new Electrobun.Electroview({ rpc });

// ============================================================================
// DOM ELEMENTS
// ============================================================================

const totalCountEl = document.getElementById("total-count") as HTMLSpanElement;
const errorCountEl = document.getElementById("error-count") as HTMLSpanElement;
const avgDurationEl = document.getElementById("avg-duration") as HTMLSpanElement;
const refreshBtn = document.getElementById("refresh-btn") as HTMLButtonElement;
const clearBtn = document.getElementById("clear-btn") as HTMLButtonElement;
const spansBody = document.getElementById("spans-body") as HTMLTableSectionElement;
const detailsPanel = document.getElementById("details-panel") as HTMLDivElement;
const detailsContent = document.getElementById("details-content") as HTMLPreElement;
const detailsTitle = document.getElementById("details-title") as HTMLHeadingElement;
const closeDetailsBtn = document.getElementById("close-details") as HTMLButtonElement;
const servicesList = document.getElementById("services-list") as HTMLDivElement;
const registryStatusEl = document.getElementById("registry-status") as HTMLDivElement;

// Phase 2: Tab and registered traces elements
const tabSpans = document.getElementById("tab-spans") as HTMLButtonElement;
const tabTraces = document.getElementById("tab-traces") as HTMLButtonElement;
const spansView = document.getElementById("spans-view") as HTMLDivElement;
const tracesView = document.getElementById("traces-view") as HTMLDivElement;
const tracesBody = document.getElementById("traces-body") as HTMLTableSectionElement;
const traceStatsEl = document.getElementById("trace-stats") as HTMLDivElement;

// Phase 4: Dashboard elements
const tabDashboards = document.getElementById("tab-dashboards") as HTMLButtonElement;
const dashboardsView = document.getElementById("dashboards-view") as HTMLDivElement;
const dashboardsList = document.getElementById("dashboards-list") as HTMLDivElement;
const dashboardContent = document.getElementById("dashboard-content") as HTMLDivElement;
const dashboardTitle = document.getElementById("dashboard-title") as HTMLHeadingElement;
const timeRangeSelect = document.getElementById("time-range-select") as HTMLSelectElement;

// ============================================================================
// STATE
// ============================================================================

let spans: Span[] = [];
let selectedSpan: Span | null = null;
let selectedService: string | null = null;
let services: ServiceSummary[] = [];
let registryStatus: RegistryStatus = { workspaces: [], totalScopes: 0, lastSyncAt: null };

// Phase 2: State for registered traces
let registeredTraces: RegisteredTraceSummary[] = [];
let selectedTrace: RegisteredTraceSummary | null = null;
let matchedSpans: MatchedSpanSummary[] = [];
let traceStats: RegisteredTraceStats = { total: 0, errorCount: 0, totalScenarioMatches: 0, totalStoryboardMatches: 0, totalUnmatchedSpans: 0, avgDuration: null };
let currentTab: "spans" | "traces" | "dashboards" = "spans";

// Phase 4: State for dashboards
let dashboards: DashboardSummary[] = [];
let selectedDashboard: DashboardData["dashboard"] | null = null;
let dashboardMetrics: Record<string, MetricData> = {};
let selectedTimeRange = "last_1h";

// ============================================================================
// HELPERS
// ============================================================================

const SPAN_KINDS = ["UNSPECIFIED", "INTERNAL", "SERVER", "CLIENT", "PRODUCER", "CONSUMER"];
const STATUS_CODES = ["UNSET", "OK", "ERROR"];

function formatDuration(ms: number | null): string {
	if (ms === null) return "-";
	if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
	if (ms < 1000) return `${ms.toFixed(1)}ms`;
	return `${(ms / 1000).toFixed(2)}s`;
}

function formatRelativeTime(timestamp: number): string {
	const diff = Date.now() - timestamp;
	const seconds = Math.floor(diff / 1000);

	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

function escapeHtml(str: string): string {
	const div = document.createElement("div");
	div.textContent = str;
	return div.innerHTML;
}

function getStatusClass(code: number): string {
	switch (code) {
		case 1: return "status-ok";
		case 2: return "status-error";
		default: return "status-unset";
	}
}

// ============================================================================
// RENDERING
// ============================================================================

function renderSpans(): void {
	if (spans.length === 0) {
		spansBody.innerHTML = `
			<tr class="empty-row">
				<td colspan="5">No spans received yet. Send OTLP traces to http://localhost:4321/v1/traces</td>
			</tr>
		`;
		return;
	}

	spansBody.innerHTML = spans
		.map((span) => {
			const statusClass = getStatusClass(span.status_code);
			return `
				<tr class="span-row ${selectedSpan?.id === span.id ? 'selected' : ''}" data-id="${escapeHtml(span.id)}">
					<td class="time-col">${formatRelativeTime(span.received_at)}</td>
					<td class="service-col">${escapeHtml(span.service_name || "unknown")}</td>
					<td class="name-col">${escapeHtml(span.name)}</td>
					<td class="duration-col">${formatDuration(span.duration_ms)}</td>
					<td class="status-col"><span class="status-badge ${statusClass}">${STATUS_CODES[span.status_code] || "UNSET"}</span></td>
				</tr>
			`;
		})
		.join("");

	// Attach click handlers
	spansBody.querySelectorAll(".span-row").forEach((row) => {
		row.addEventListener("click", () => {
			const id = (row as HTMLElement).dataset["id"]!;
			const span = spans.find((s) => s["id"] === id);
			if (span) showDetails(span);
		});
	});
}

function renderStats(stats: Stats): void {
	totalCountEl.textContent = `${stats.total} spans`;
	errorCountEl.textContent = `${stats.errorCount} errors`;
	avgDurationEl.textContent = stats.avgDuration !== null
		? `${formatDuration(stats.avgDuration)} avg`
		: "- avg";

	// Highlight errors if any
	errorCountEl.classList.toggle("has-errors", stats.errorCount > 0);
}

function showDetails(span: Span): void {
	selectedSpan = span;
	renderSpans(); // Re-render to show selection

	let attributes: Record<string, unknown> = {};
	let events: unknown[] = [];

	try {
		attributes = JSON.parse(span.attributes);
	} catch {}

	try {
		events = JSON.parse(span.events);
	} catch {}

	const details = {
		id: span["id"],
		traceId: span.trace_id,
		spanId: span.span_id,
		parentSpanId: span.parent_span_id,
		service: {
			name: span.service_name,
			version: span.service_version,
		},
		name: span.name,
		kind: SPAN_KINDS[span.kind] || "UNKNOWN",
		duration: formatDuration(span.duration_ms),
		status: {
			code: STATUS_CODES[span.status_code] || "UNKNOWN",
			message: span.status_message,
		},
		attributes,
		events,
		receivedAt: new Date(span.received_at).toISOString(),
	};

	if (detailsTitle) detailsTitle.textContent = "Span Details";
	detailsContent.textContent = JSON.stringify(details, null, 2);
	detailsPanel.classList.add("visible");
}

function hideDetails(): void {
	selectedSpan = null;
	selectedTrace = null;
	matchedSpans = [];
	detailsPanel.classList.remove("visible");
	renderSpans();
	renderRegisteredTraces();
}

// ============================================================================
// PHASE 2: REGISTERED TRACES RENDERING
// ============================================================================

function renderRegisteredTraces(): void {
	if (!tracesBody) return;

	if (registeredTraces.length === 0) {
		tracesBody.innerHTML = `
			<tr class="empty-row">
				<td colspan="6">No matched traces yet. Sync a workspace and send OTLP traces.</td>
			</tr>
		`;
		return;
	}

	tracesBody.innerHTML = registeredTraces
		.map((trace) => {
			const hasMatches = trace.scenarioMatchCount > 0 || trace.storyboardMatchCount > 0;
			return `
				<tr class="trace-row ${selectedTrace?.traceId === trace.traceId ? 'selected' : ''}" data-trace-id="${escapeHtml(trace.traceId)}">
					<td class="time-col">${formatRelativeTime(trace.receivedAt)}</td>
					<td class="name-col">${escapeHtml(trace.name)}</td>
					<td class="spans-col">${trace.spanCount}</td>
					<td class="duration-col">${formatDuration(trace.durationMs)}</td>
					<td class="matches-col">
						${trace.scenarioMatchCount > 0 ? `<span class="match-badge match-scenario">${trace.scenarioMatchCount} scenario</span>` : ''}
						${trace.storyboardMatchCount > 0 ? `<span class="match-badge match-storyboard">${trace.storyboardMatchCount} storyboard</span>` : ''}
						${trace.unmatchedSpanCount > 0 ? `<span class="match-badge match-unmatched">${trace.unmatchedSpanCount} unmatched</span>` : ''}
						${!hasMatches && trace.unmatchedSpanCount === 0 ? `<span class="match-badge match-none">no spans</span>` : ''}
					</td>
					<td class="status-col">
						${trace.hasErrors ? '<span class="status-badge status-error">ERROR</span>' : '<span class="status-badge status-ok">OK</span>'}
					</td>
				</tr>
			`;
		})
		.join("");

	// Attach click handlers
	tracesBody.querySelectorAll(".trace-row").forEach((row) => {
		row.addEventListener("click", () => {
			const traceId = (row as HTMLElement).dataset["traceId"]!;
			const trace = registeredTraces.find((t) => t.traceId === traceId);
			if (trace) showTraceDetails(trace);
		});
	});
}

function renderTraceStats(): void {
	if (!traceStatsEl) return;

	traceStatsEl.innerHTML = `
		<span class="stat">${traceStats.total} traces</span>
		<span class="stat match-scenario-stat">${traceStats.totalScenarioMatches} scenario matches</span>
		<span class="stat match-storyboard-stat">${traceStats.totalStoryboardMatches} storyboard matches</span>
		<span class="stat match-unmatched-stat">${traceStats.totalUnmatchedSpans} unmatched</span>
	`;
}

async function showTraceDetails(trace: RegisteredTraceSummary): Promise<void> {
	selectedTrace = trace;
	renderRegisteredTraces();

	// Load matched spans for this trace
	try {
		matchedSpans = await electrobun.rpc!.request.getMatchedSpansByTrace({ traceId: trace.traceId });
	} catch (error) {
		console.error("Failed to load matched spans:", error);
		matchedSpans = [];
	}

	// Build details view
	const scenarioSpans = matchedSpans.filter(s => s.matchType === "scenario");
	const storyboardSpans = matchedSpans.filter(s => s.matchType === "storyboard");
	const unmatchedSpansList = matchedSpans.filter(s => s.matchType === "unmatched");

	const details = {
		traceId: trace.traceId,
		name: trace.name,
		duration: formatDuration(trace.durationMs),
		spanCount: trace.spanCount,
		hasErrors: trace.hasErrors,
		receivedAt: new Date(trace.receivedAt).toISOString(),
		matching: {
			scenarioMatches: trace.scenarioMatchCount,
			storyboardMatches: trace.storyboardMatchCount,
			unmatchedSpans: trace.unmatchedSpanCount,
		},
		scenarioSpans: scenarioSpans.map(s => ({
			spanName: s.spanName,
			storyboardId: s.storyboardId,
			workflowId: s.workflowId,
			scenarioId: s.scenarioId,
			scopeName: s.scopeName,
			duration: formatDuration(s.durationMs),
			matchedEvents: s.matchedEvents,
		})),
		storyboardSpans: storyboardSpans.map(s => ({
			spanName: s.spanName,
			storyboardId: s.storyboardId,
			workflowId: s.workflowId,
			scopeName: s.scopeName,
			reason: s.orphanReason,
		})),
		unmatchedSpans: unmatchedSpansList.map(s => ({
			spanName: s.spanName,
			scopeName: s.scopeName,
			reason: s.orphanReason,
		})),
	};

	if (detailsTitle) detailsTitle.textContent = "Trace Details";
	detailsContent.textContent = JSON.stringify(details, null, 2);
	detailsPanel.classList.add("visible");
}

function switchTab(tab: "spans" | "traces" | "dashboards"): void {
	currentTab = tab;

	// Update tab buttons
	tabSpans?.classList.toggle("active", tab === "spans");
	tabTraces?.classList.toggle("active", tab === "traces");
	tabDashboards?.classList.toggle("active", tab === "dashboards");

	// Update views
	spansView?.classList.toggle("hidden", tab !== "spans");
	tracesView?.classList.toggle("hidden", tab !== "traces");
	dashboardsView?.classList.toggle("hidden", tab !== "dashboards");

	// Load data for the selected tab
	if (tab === "traces") {
		loadRegisteredTraces();
		loadRegisteredTraceStats();
	} else if (tab === "dashboards") {
		loadDashboards();
	}
}

// ============================================================================
// PHASE 4: DASHBOARD RENDERING
// ============================================================================

function renderDashboardsList(): void {
	if (!dashboardsList) return;

	if (dashboards.length === 0) {
		dashboardsList.innerHTML = `
			<div class="dashboard-empty">
				No dashboards loaded. Sync a workspace with .dashboard.json files.
			</div>
		`;
		return;
	}

	dashboardsList.innerHTML = dashboards
		.map((dashboard) => `
			<div class="dashboard-item ${selectedDashboard?.id === dashboard.id ? 'selected' : ''}" data-dashboard-id="${escapeHtml(dashboard.id)}">
				<div class="dashboard-name">${escapeHtml(dashboard.name)}</div>
				<div class="dashboard-metrics-count">${dashboard.metricsCount} metrics</div>
			</div>
		`)
		.join("");

	// Attach click handlers
	dashboardsList.querySelectorAll(".dashboard-item").forEach((item) => {
		item.addEventListener("click", () => {
			const dashboardId = (item as HTMLElement).dataset["dashboardId"]!;
			loadDashboardData(dashboardId);
		});
	});
}

function renderDashboardContent(): void {
	if (!dashboardContent || !selectedDashboard) {
		if (dashboardContent) {
			dashboardContent.innerHTML = `
				<div class="dashboard-placeholder">
					Select a dashboard from the list to view metrics
				</div>
			`;
		}
		return;
	}

	if (dashboardTitle) {
		dashboardTitle.textContent = selectedDashboard.name;
	}

	// Render metric panels
	const panels = selectedDashboard.metrics.map((metric) => {
		const data = dashboardMetrics[metric.id];
		if (!data) {
			return `
				<div class="metric-panel">
					<div class="metric-header">
						<span class="metric-name">${escapeHtml(metric.name)}</span>
						<span class="metric-type">${escapeHtml(metric.type)}</span>
					</div>
					<div class="metric-value">Loading...</div>
				</div>
			`;
		}

		// Determine the primary value to display
		let primaryValue: string;
		let trend = "";
		switch (metric.type) {
			case "counter":
				primaryValue = formatNumber(data.summary.count);
				break;
			case "gauge":
				primaryValue = formatNumber(data.summary.avg, 2);
				break;
			case "histogram":
				primaryValue = formatDuration(data.summary.avg);
				break;
			default:
				primaryValue = formatNumber(data.summary.count);
		}

		// Render mini sparkline if we have series data
		const sparkline = data.series.length > 0 ? renderSparkline(data.series) : "";

		return `
			<div class="metric-panel">
				<div class="metric-header">
					<span class="metric-name">${escapeHtml(metric.name)}</span>
					<span class="metric-type">${escapeHtml(metric.type)}</span>
				</div>
				<div class="metric-value">${primaryValue}</div>
				<div class="metric-details">
					<span class="metric-count">${formatNumber(data.summary.count)} events</span>
					${data.summary.errorCount > 0 ? `<span class="metric-errors">${data.summary.errorCount} errors</span>` : ''}
				</div>
				${sparkline}
			</div>
		`;
	}).join("");

	dashboardContent.innerHTML = `
		<div class="metrics-grid">
			${panels}
		</div>
	`;
}

function renderSparkline(series: Array<{ date: string; value: number }>): string {
	if (series.length < 2) return "";

	const values = series.map((s) => s.value);
	const maxVal = Math.max(...values, 1);
	const minVal = Math.min(...values, 0);
	const range = maxVal - minVal || 1;

	const width = 120;
	const height = 30;
	const points = series.map((s, i) => {
		const x = (i / (series.length - 1)) * width;
		const y = height - ((s.value - minVal) / range) * height;
		return `${x},${y}`;
	}).join(" ");

	return `
		<div class="metric-sparkline">
			<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
				<polyline
					fill="none"
					stroke="#58a6ff"
					stroke-width="1.5"
					points="${points}"
				/>
			</svg>
		</div>
	`;
}

function formatNumber(n: number, decimals = 0): string {
	if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
	if (n >= 1000) return (n / 1000).toFixed(1) + "K";
	return decimals > 0 ? n.toFixed(decimals) : n.toString();
}

// ============================================================================
// DATA LOADING
// ============================================================================

async function loadSpans(): Promise<void> {
	try {
		const params: { limit: number; offset: number; serviceName?: string } = { limit: 100, offset: 0 };
		if (selectedService) {
			params.serviceName = selectedService;
		}
		spans = await electrobun.rpc!.request.getRecentSpans(params);
		renderSpans();
	} catch (error) {
		console.error("Failed to load spans:", error);
	}
}

async function loadStats(): Promise<void> {
	try {
		const stats = await electrobun.rpc!.request.getStats({});
		renderStats(stats);
	} catch (error) {
		console.error("Failed to load stats:", error);
	}
}

async function loadServices(): Promise<void> {
	try {
		services = await electrobun.rpc!.request.getServiceSummaries({});
		renderServices();
	} catch (error) {
		console.error("Failed to load services:", error);
	}
}

function renderServices(): void {
	const totalCount = services.reduce((sum, s) => sum + s.count, 0);

	const allServicesItem = `
		<div class="service-item ${selectedService === null ? 'selected' : ''}" data-service="">
			<span class="service-name">All Services</span>
			<span class="service-count">${totalCount}</span>
		</div>
	`;

	const serviceItems = services
		.map((service) => `
			<div class="service-item ${selectedService === service.name ? 'selected' : ''}" data-service="${escapeHtml(service.name)}">
				<span class="service-name">${escapeHtml(service.name)}</span>
				<span class="service-count">${service.count}</span>
			</div>
		`)
		.join("");

	servicesList.innerHTML = allServicesItem + serviceItems;

	// Attach click handlers
	servicesList.querySelectorAll(".service-item").forEach((item) => {
		item.addEventListener("click", () => {
			const serviceName = (item as HTMLElement).dataset["service"]!;
			selectService(serviceName || null);
		});
	});
}

function selectService(serviceName: string | null): void {
	selectedService = serviceName;
	renderServices();
	loadSpans();
}

async function loadRegistry(): Promise<void> {
	try {
		registryStatus = await electrobun.rpc!.request.getRegistryStatus({});
		renderRegistry();
	} catch (error) {
		console.error("Failed to load registry status:", error);
	}
}

// Phase 2: Load registered traces
async function loadRegisteredTraces(): Promise<void> {
	try {
		registeredTraces = await electrobun.rpc!.request.getRegisteredTraces({ limit: 100, offset: 0 });
		renderRegisteredTraces();
	} catch (error) {
		console.error("Failed to load registered traces:", error);
	}
}

async function loadRegisteredTraceStats(): Promise<void> {
	try {
		traceStats = await electrobun.rpc!.request.getRegisteredTraceStats({});
		renderTraceStats();
	} catch (error) {
		console.error("Failed to load trace stats:", error);
	}
}

// Phase 4: Dashboard loading
async function loadDashboards(): Promise<void> {
	try {
		dashboards = await electrobun.rpc!.request.getDashboards({});
		renderDashboardsList();
	} catch (error) {
		console.error("Failed to load dashboards:", error);
	}
}

async function loadDashboardData(dashboardId: string): Promise<void> {
	try {
		const result = await electrobun.rpc!.request.getDashboard({ dashboardId, timeRange: selectedTimeRange });
		if (result) {
			selectedDashboard = result.dashboard;
			dashboardMetrics = result.metrics;
			renderDashboardsList();
			renderDashboardContent();
		}
	} catch (error) {
		console.error("Failed to load dashboard data:", error);
	}
}

function renderRegistry(): void {
	if (registryStatus.workspaces.length === 0) {
		registryStatusEl.innerHTML = `<div class="registry-empty">No workspaces synced</div>`;
		return;
	}

	const workspaceItems = registryStatus.workspaces
		.map((workspace) => {
			const name = workspace.name || getWorkspaceName(workspace.rootPath);
			const syncAge = Date.now() - workspace.lastSyncedAt;
			const isStale = syncAge > 5 * 60 * 1000; // 5 minutes
			const statusClass = isStale ? "stale" : "";

			return `
				<div class="workspace-item">
					<div class="workspace-name">
						<span class="workspace-status ${statusClass}"></span>
						${escapeHtml(name)}
					</div>
					<div class="workspace-path" title="${escapeHtml(workspace.rootPath)}">
						${escapeHtml(truncatePath(workspace.rootPath))}
					</div>
					<div class="workspace-meta">
						<span class="workspace-scopes">${workspace.scopeNames.length} scopes</span>
						<span class="workspace-sync-time">${formatRelativeTime(workspace.lastSyncedAt)}</span>
					</div>
				</div>
			`;
		})
		.join("");

	registryStatusEl.innerHTML = workspaceItems;
}

function getWorkspaceName(rootPath: string): string {
	const parts = rootPath.split("/");
	return parts[parts.length - 1] || rootPath;
}

function truncatePath(path: string, maxLength: number = 30): string {
	if (path.length <= maxLength) return path;
	const parts = path.split("/");
	if (parts.length <= 2) return path;
	return ".../" + parts.slice(-2).join("/");
}

async function refresh(): Promise<void> {
	await Promise.all([
		loadSpans(),
		loadStats(),
		loadServices(),
		loadRegistry(),
		loadRegisteredTraces(),
		loadRegisteredTraceStats(),
		loadDashboards(),
	]);
}

async function clearOld(): Promise<void> {
	const oneHourMs = 60 * 60 * 1000;
	try {
		const result = await electrobun.rpc!.request.clearOldSpans({ olderThanMs: oneHourMs });
		console.log(`Cleared ${result.deleted} old spans`);
		await refresh();
	} catch (error) {
		console.error("Failed to clear old spans:", error);
	}
}

// ============================================================================
// EVENT LISTENERS
// ============================================================================

refreshBtn.addEventListener("click", refresh);
clearBtn.addEventListener("click", clearOld);
closeDetailsBtn.addEventListener("click", hideDetails);

// Tab switching
tabSpans?.addEventListener("click", () => switchTab("spans"));
tabTraces?.addEventListener("click", () => switchTab("traces"));
tabDashboards?.addEventListener("click", () => switchTab("dashboards"));

// Phase 4: Time range select
timeRangeSelect?.addEventListener("change", () => {
	selectedTimeRange = timeRangeSelect.value;
	if (selectedDashboard) {
		loadDashboardData(selectedDashboard.id);
	}
});

// Close details on Escape key
document.addEventListener("keydown", (e) => {
	if (e.key === "Escape" && detailsPanel.classList.contains("visible")) {
		hideDetails();
	}
});

// ============================================================================
// AUTO-REFRESH
// ============================================================================

// Refresh every 5 seconds
setInterval(refresh, 5000);

// ============================================================================
// INITIAL LOAD
// ============================================================================

refresh();
