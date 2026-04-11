import { URL } from 'node:url';
import { desc, eq } from 'drizzle-orm';
import { config as appConfig } from '@/config';
import { getDatabase, schema } from '@/db';
import { buildScreenPlaybackStateById } from '@/screens/playback';

type PrometheusMetric = Record<string, string>;

type PrometheusVectorResult = {
  metric: PrometheusMetric;
  value: [number | string, string];
};

type PrometheusResponse = {
  status: 'success' | 'error';
  data?: {
    resultType?: string;
    result?: PrometheusVectorResult[];
  };
};

type MachineDefinition = {
  id: string;
  name: string;
  role: 'data' | 'backend' | 'cms' | 'development';
  dashboardUid: string;
  expectedJobs: string[];
  services: Array<{
    id: string;
    label: string;
    job: string;
  }>;
};

type ObservabilityStatus = 'healthy' | 'degraded' | 'critical' | 'unknown' | 'unconfigured';

export type ObservabilityGrafanaLink = {
  label: string;
  url: string;
};

export type MachineSummary = {
  id: string;
  name: string;
  role: MachineDefinition['role'];
  status: ObservabilityStatus;
  scrape_status: {
    reachable_targets: number;
    expected_targets: number;
  };
  resources: {
    cpu_percent: number | null;
    memory_percent: number | null;
    disk_percent: number | null;
  };
  services: Array<{
    id: string;
    label: string;
    status: 'up' | 'down' | 'unknown';
  }>;
  grafana: {
    dashboard_url: string | null;
  };
};

export type ObservabilityOverviewSummary = {
  generated_at: string;
  deployment_mode: 'development' | 'qa' | 'production';
  current_state_source: 'backend_and_prometheus';
  fleet: {
    total_players: number | null;
    active_players: number | null;
    inactive_players: number | null;
    offline_players: number | null;
    reachable_players: number | null;
    configured_player_targets: number | null;
  };
  alerts: {
    available: boolean;
    firing: number;
    highest_severity: 'critical' | 'warning' | 'info' | 'none' | 'unknown';
    status: ObservabilityStatus;
  };
  machines: MachineSummary[];
  grafana: {
    enabled: boolean;
    embed_enabled: boolean;
    base_path: string;
    links: {
      backend_service: string | null;
      players_fleet: string | null;
      machines: Record<string, string | null>;
    };
  };
};

export type ScreenObservabilitySummary = {
  generated_at: string;
  screen: {
    id: string;
    name: string;
    status: string;
    health_state: string | null;
    health_reason: string | null;
    last_backend_heartbeat_at: string | null;
  };
  player_scrape: {
    configured: boolean;
    status: 'up' | 'down' | 'unknown';
    last_successful_player_heartbeat_at: string | null;
  };
  latest_player_metrics: {
    cpu_percent: number | null;
    memory_used_bytes: number | null;
    memory_total_bytes: number | null;
    disk_used_bytes: number | null;
    disk_total_bytes: number | null;
    temperature_celsius: number | null;
    battery_percent: number | null;
    power_connected: boolean | null;
    request_queue_items: number | null;
    request_queue_oldest_age_seconds: number | null;
    cache_used_bytes: number | null;
    cache_total_bytes: number | null;
    last_schedule_sync_at: string | null;
    display_count: number | null;
  };
  latest_backend_telemetry: Record<string, unknown> | null;
  grafana: {
    enabled: boolean;
    embed_enabled: boolean;
    links: ObservabilityGrafanaLink[];
    embed_url: string | null;
  };
};

const PROMETHEUS_API_PATH = '/api/v1/query';
const PROMETHEUS_MACHINE_REGEX = 'vm1|vm2|vm3|dev-local';

function normalizeGrafanaBasePath(basePath: string) {
  const trimmed = basePath.trim();
  if (!trimmed) return '/grafana';
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

function toScalar(result?: PrometheusVectorResult | null) {
  if (!result?.value) return null;
  const parsed = Number(result.value[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseUnixTime(value: number | null) {
  if (value === null || !Number.isFinite(value) || value <= 0) return null;
  return new Date(value * 1000).toISOString();
}

function classifyMachineStatus(params: {
  expectedTargets: number;
  reachableTargets: number;
  cpuPercent: number | null;
  memoryPercent: number | null;
  diskPercent: number | null;
}) {
  const { expectedTargets, reachableTargets, cpuPercent, memoryPercent, diskPercent } = params;
  if (expectedTargets === 0) return 'unconfigured' as const;
  if (reachableTargets === 0) return 'critical' as const;
  if (reachableTargets < expectedTargets) return 'degraded' as const;
  if ([cpuPercent, memoryPercent, diskPercent].some((value) => typeof value === 'number' && value >= 95)) {
    return 'critical' as const;
  }
  if ([cpuPercent, memoryPercent, diskPercent].some((value) => typeof value === 'number' && value >= 85)) {
    return 'degraded' as const;
  }
  return 'healthy' as const;
}

function classifyAlertStatus(firing: number, highestSeverity: string) {
  if (firing <= 0) return 'healthy' as const;
  if (highestSeverity === 'critical') return 'critical' as const;
  if (highestSeverity === 'warning') return 'degraded' as const;
  return 'degraded' as const;
}

function buildDashboardUrl(uid: string, queryParams?: Record<string, string | null | undefined>) {
  const basePath = normalizeGrafanaBasePath(appConfig.OBSERVABILITY_GRAFANA_BASE_PATH);
  const url = new URL(`${basePath}/d/${uid}`, 'http://signhex.local');
  Object.entries(queryParams ?? {}).forEach(([key, value]) => {
    if (value) {
      url.searchParams.set(key, value);
    }
  });
  return `${url.pathname}${url.search}`;
}

function getMachineDefinitions(): MachineDefinition[] {
  if (appConfig.OBSERVABILITY_DEPLOYMENT_MODE === 'development') {
    return [
      {
        id: 'dev-local',
        name: 'Development Host',
        role: 'development',
        dashboardUid: 'signhex-vm2-backend',
        expectedJobs: ['signhex-server', 'vm2-node'],
        services: [
          { id: 'backend', label: 'Backend API', job: 'signhex-server' },
          { id: 'node', label: 'Host Exporter', job: 'vm2-node' },
        ],
      },
    ];
  }

  return [
    {
      id: 'vm1',
      name: 'VM1 Data Machine',
      role: 'data',
      dashboardUid: 'signhex-vm1-data',
      expectedJobs: ['vm1-node', 'vm1-postgres', 'vm1-minio', 'vm1-cadvisor'],
      services: [
        { id: 'node', label: 'Host Exporter', job: 'vm1-node' },
        { id: 'postgres', label: 'PostgreSQL Exporter', job: 'vm1-postgres' },
        { id: 'minio', label: 'MinIO Metrics', job: 'vm1-minio' },
        { id: 'cadvisor', label: 'Container Metrics', job: 'vm1-cadvisor' },
      ],
    },
    {
      id: 'vm2',
      name: 'VM2 Backend Machine',
      role: 'backend',
      dashboardUid: 'signhex-vm2-backend',
      expectedJobs: ['signhex-server', 'vm2-node', 'vm2-cadvisor'],
      services: [
        { id: 'backend', label: 'Backend API', job: 'signhex-server' },
        { id: 'node', label: 'Host Exporter', job: 'vm2-node' },
        { id: 'cadvisor', label: 'Container Metrics', job: 'vm2-cadvisor' },
      ],
    },
    {
      id: 'vm3',
      name: 'VM3 CMS Machine',
      role: 'cms',
      dashboardUid: 'signhex-vm3-cms',
      expectedJobs: ['vm3-node', 'vm3-nginx', 'vm3-grafana'],
      services: [
        { id: 'node', label: 'Host Exporter', job: 'vm3-node' },
        { id: 'nginx', label: 'Nginx Exporter', job: 'vm3-nginx' },
        { id: 'grafana', label: 'Grafana Metrics', job: 'vm3-grafana' },
      ],
    },
  ];
}

class PrometheusSummaryClient {
  private readonly baseUrl: string | null;

  constructor(baseUrl: string | null | undefined) {
    this.baseUrl =
      baseUrl ??
      (appConfig.NODE_ENV === 'test' ? 'http://127.0.0.1:9090' : null);
  }

  get enabled() {
    return Boolean(this.baseUrl);
  }

  async query(expression: string): Promise<PrometheusVectorResult[]> {
    if (!this.baseUrl) {
      return [];
    }

    const url = new URL(PROMETHEUS_API_PATH, this.baseUrl);
    url.searchParams.set('query', expression);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), appConfig.OBSERVABILITY_PROMETHEUS_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
      });

      if (!response.ok) {
        return [];
      }

      const body = (await response.json()) as PrometheusResponse;
      if (body.status !== 'success' || body.data?.resultType !== 'vector') {
        return [];
      }

      return body.data.result ?? [];
    } catch {
      return [];
    } finally {
      clearTimeout(timeout);
    }
  }
}

function mapInstantValuesByMachine(results: PrometheusVectorResult[]) {
  const mapped = new Map<string, number>();
  for (const result of results) {
    const machineId = result.metric.machine;
    const value = toScalar(result);
    if (!machineId || value === null) continue;
    mapped.set(machineId, value);
  }
  return mapped;
}

function buildServiceStatusMap(results: PrometheusVectorResult[]) {
  const mapped = new Map<string, number>();
  for (const result of results) {
    const machineId = result.metric.machine;
    const job = result.metric.job;
    const value = toScalar(result);
    if (!machineId || !job || value === null) continue;
    mapped.set(`${machineId}:${job}`, value);
  }
  return mapped;
}

export async function buildObservabilityOverviewSummary(): Promise<ObservabilityOverviewSummary> {
  const prometheus = new PrometheusSummaryClient(appConfig.OBSERVABILITY_PROMETHEUS_BASE_URL);
  const machineDefinitions = getMachineDefinitions();
  const grafanaBasePath = normalizeGrafanaBasePath(appConfig.OBSERVABILITY_GRAFANA_BASE_PATH);

  const [fleetStateResults, playerTargetResults, alertResults, hostUpResults, cpuResults, memoryResults, diskResults] =
    await Promise.all([
      prometheus.query('signhex_fleet_players_total'),
      prometheus.query('up{job="players"}'),
      prometheus.query('count by (severity) (ALERTS{alertstate="firing"})'),
      prometheus.query(`up{machine=~"${PROMETHEUS_MACHINE_REGEX}"}`),
      prometheus.query(
        `100 * (1 - avg by(machine) (rate(node_cpu_seconds_total{machine=~"${PROMETHEUS_MACHINE_REGEX}",mode="idle"}[5m])))`
      ),
      prometheus.query(
        `100 * (1 - (node_memory_MemAvailable_bytes{machine=~"${PROMETHEUS_MACHINE_REGEX}"} / node_memory_MemTotal_bytes{machine=~"${PROMETHEUS_MACHINE_REGEX}"}))`
      ),
      prometheus.query(
        `max by(machine) (100 * (1 - (node_filesystem_avail_bytes{machine=~"${PROMETHEUS_MACHINE_REGEX}",fstype!~"tmpfs|overlay|squashfs"} / node_filesystem_size_bytes{machine=~"${PROMETHEUS_MACHINE_REGEX}",fstype!~"tmpfs|overlay|squashfs"})))`
      ),
    ]);

  const fleetTotals = new Map<string, number>();
  for (const result of fleetStateResults) {
    const state = result.metric.state;
    const value = toScalar(result);
    if (!state || value === null) continue;
    fleetTotals.set(state, value);
  }

  const cpuByMachine = mapInstantValuesByMachine(cpuResults);
  const memoryByMachine = mapInstantValuesByMachine(memoryResults);
  const diskByMachine = mapInstantValuesByMachine(diskResults);
  const serviceStatuses = buildServiceStatusMap(hostUpResults);
  const hostTargetsByMachine = new Map<string, { expected: number; reachable: number }>();

  for (const machine of machineDefinitions) {
    hostTargetsByMachine.set(machine.id, { expected: machine.expectedJobs.length, reachable: 0 });
  }

  for (const result of hostUpResults) {
    const machineId = result.metric.machine;
    const value = toScalar(result);
    if (!machineId || value === null) continue;
    const current = hostTargetsByMachine.get(machineId);
    if (!current) continue;
    current.reachable += value >= 1 ? 1 : 0;
  }

  const machines: MachineSummary[] = machineDefinitions.map((machine) => {
    const targetState = hostTargetsByMachine.get(machine.id) ?? { expected: machine.expectedJobs.length, reachable: 0 };
    const cpuPercent = cpuByMachine.get(machine.id) ?? null;
    const memoryPercent = memoryByMachine.get(machine.id) ?? null;
    const diskPercent = diskByMachine.get(machine.id) ?? null;

    return {
      id: machine.id,
      name: machine.name,
      role: machine.role,
      status: prometheus.enabled
        ? classifyMachineStatus({
            expectedTargets: targetState.expected,
            reachableTargets: targetState.reachable,
            cpuPercent,
            memoryPercent,
            diskPercent,
          })
        : 'unconfigured',
      scrape_status: {
        reachable_targets: targetState.reachable,
        expected_targets: targetState.expected,
      },
      resources: {
        cpu_percent: cpuPercent,
        memory_percent: memoryPercent,
        disk_percent: diskPercent,
      },
      services: machine.services.map((service) => {
        const value = serviceStatuses.get(`${machine.id}:${service.job}`);
        return {
          id: service.id,
          label: service.label,
          status: value === undefined ? 'unknown' : value >= 1 ? 'up' : 'down',
        };
      }),
      grafana: {
        dashboard_url: appConfig.OBSERVABILITY_GRAFANA_ENABLED ? buildDashboardUrl(machine.dashboardUid) : null,
      },
    };
  });

  const configuredPlayerTargets = playerTargetResults.length > 0 ? playerTargetResults.length : null;
  const reachablePlayerTargets =
    playerTargetResults.length > 0
      ? playerTargetResults.reduce((count, result) => count + (toScalar(result) === 1 ? 1 : 0), 0)
      : null;

  const firingAlerts = alertResults.reduce((count, result) => count + (toScalar(result) ?? 0), 0);
  const severityOrder = ['critical', 'warning', 'info'];
  const highestSeverity =
    severityOrder.find((severity) => alertResults.some((result) => result.metric.severity === severity)) ??
    (alertResults.length > 0 ? 'unknown' : 'none');

  return {
    generated_at: new Date().toISOString(),
    deployment_mode: appConfig.OBSERVABILITY_DEPLOYMENT_MODE,
    current_state_source: 'backend_and_prometheus',
    fleet: {
      total_players:
        fleetTotals.get('ACTIVE') !== undefined ||
        fleetTotals.get('INACTIVE') !== undefined ||
        fleetTotals.get('OFFLINE') !== undefined
          ? (fleetTotals.get('ACTIVE') ?? 0) + (fleetTotals.get('INACTIVE') ?? 0) + (fleetTotals.get('OFFLINE') ?? 0)
          : null,
      active_players: fleetTotals.get('ACTIVE') ?? null,
      inactive_players: fleetTotals.get('INACTIVE') ?? null,
      offline_players: fleetTotals.get('OFFLINE') ?? null,
      reachable_players: reachablePlayerTargets,
      configured_player_targets: configuredPlayerTargets,
    },
    alerts: {
      available: prometheus.enabled,
      firing: firingAlerts,
      highest_severity: highestSeverity as ObservabilityOverviewSummary['alerts']['highest_severity'],
      status: prometheus.enabled ? classifyAlertStatus(firingAlerts, highestSeverity) : 'unconfigured',
    },
    machines,
    grafana: {
      enabled: appConfig.OBSERVABILITY_GRAFANA_ENABLED,
      embed_enabled: appConfig.OBSERVABILITY_GRAFANA_EMBED_ENABLED,
      base_path: grafanaBasePath,
      links: {
        backend_service: appConfig.OBSERVABILITY_GRAFANA_ENABLED ? buildDashboardUrl('signhex-backend-service') : null,
        players_fleet: appConfig.OBSERVABILITY_GRAFANA_ENABLED ? buildDashboardUrl('signhex-players-fleet') : null,
        machines: Object.fromEntries(
          machineDefinitions.map((machine) => [
            machine.id,
            appConfig.OBSERVABILITY_GRAFANA_ENABLED ? buildDashboardUrl(machine.dashboardUid) : null,
          ])
        ),
      },
    },
  };
}

export async function buildMachineSummaries(): Promise<MachineSummary[]> {
  const overview = await buildObservabilityOverviewSummary();
  return overview.machines;
}

export async function buildScreenObservabilitySummary(screenId: string): Promise<ScreenObservabilitySummary | null> {
  const db = getDatabase();
  const screen = await db.select().from(schema.screens).where(eq(schema.screens.id, screenId)).limit(1);
  const screenRow = screen[0];
  if (!screenRow) {
    return null;
  }

  const summary = await buildScreenPlaybackStateById(screenId, { db });
  const [latestHeartbeat] = await db
    .select({
      created_at: schema.heartbeats.created_at,
      bucket: schema.storageObjects.bucket,
      object_key: schema.storageObjects.object_key,
    })
    .from(schema.heartbeats)
    .leftJoin(schema.storageObjects, eq(schema.heartbeats.storage_object_id, schema.storageObjects.id))
    .where(eq(schema.heartbeats.screen_id, screenId))
    .orderBy(desc(schema.heartbeats.created_at))
    .limit(1);

  let latestBackendTelemetry: Record<string, unknown> | null = null;
  if (latestHeartbeat?.bucket && latestHeartbeat.object_key) {
    const { getObject } = await import('@/s3');
    try {
      const payload = await getObject(latestHeartbeat.bucket, latestHeartbeat.object_key);
      latestBackendTelemetry = JSON.parse(payload.toString('utf8')) as Record<string, unknown>;
    } catch {
      latestBackendTelemetry = null;
    }
  }

  const prometheus = new PrometheusSummaryClient(appConfig.OBSERVABILITY_PROMETHEUS_BASE_URL);
  const playerMetricResults = await prometheus.query(
    [
      `up{job="players",device_id="${screenId}"}`,
      `signhex_player_last_successful_heartbeat_unixtime{device_id="${screenId}"}`,
      `signhex_player_system_cpu_usage_percent{device_id="${screenId}"}`,
      `signhex_player_system_memory_bytes{device_id="${screenId}",state=~"used|total"}`,
      `signhex_player_system_disk_bytes{device_id="${screenId}",state=~"used|total"}`,
      `signhex_player_system_temperature_celsius{device_id="${screenId}"}`,
      `signhex_player_battery_percent{device_id="${screenId}"}`,
      `signhex_player_power_connected{device_id="${screenId}"}`,
      `signhex_player_request_queue_items{device_id="${screenId}",category="all"}`,
      `signhex_player_request_queue_oldest_age_seconds{device_id="${screenId}",category="all"}`,
      `signhex_player_cache_bytes{device_id="${screenId}",state=~"used|total"}`,
      `signhex_player_last_schedule_sync_unixtime{device_id="${screenId}"}`,
      `signhex_player_display_count{device_id="${screenId}"}`,
    ].join(' or ')
  );

  const metricValue = (name: string, matcher?: (metric: PrometheusMetric) => boolean) =>
    toScalar(
      playerMetricResults.find(
        (result) => result.metric.__name__ === name && (matcher ? matcher(result.metric) : true)
      ) ?? null
    );

  const grafanaLinks: ObservabilityGrafanaLink[] = [];
  if (appConfig.OBSERVABILITY_GRAFANA_ENABLED) {
    grafanaLinks.push({
      label: 'Open player fleet dashboard',
      url: buildDashboardUrl('signhex-players-fleet', {
        'var-device_id': screenId,
        'var-screen_id': screenId,
      }),
    });
    grafanaLinks.push({
      label: 'Open backend service dashboard',
      url: buildDashboardUrl('signhex-backend-service'),
    });
  }

  return {
    generated_at: new Date().toISOString(),
    screen: {
      id: screenRow.id,
      name: screenRow.name,
      status: screenRow.status,
      health_state: (summary as { health_state?: string | null })?.health_state ?? null,
      health_reason: (summary as { health_reason?: string | null })?.health_reason ?? null,
      last_backend_heartbeat_at: screenRow.last_heartbeat_at?.toISOString() ?? null,
    },
    player_scrape: {
      configured: playerMetricResults.length > 0,
      status: (() => {
        const upValue = metricValue('up');
        if (upValue === null) return 'unknown';
        return upValue >= 1 ? 'up' : 'down';
      })(),
      last_successful_player_heartbeat_at: parseUnixTime(
        metricValue('signhex_player_last_successful_heartbeat_unixtime')
      ),
    },
    latest_player_metrics: {
      cpu_percent: metricValue('signhex_player_system_cpu_usage_percent'),
      memory_used_bytes: metricValue('signhex_player_system_memory_bytes', (metric) => metric.state === 'used'),
      memory_total_bytes: metricValue('signhex_player_system_memory_bytes', (metric) => metric.state === 'total'),
      disk_used_bytes: metricValue('signhex_player_system_disk_bytes', (metric) => metric.state === 'used'),
      disk_total_bytes: metricValue('signhex_player_system_disk_bytes', (metric) => metric.state === 'total'),
      temperature_celsius: metricValue('signhex_player_system_temperature_celsius'),
      battery_percent: metricValue('signhex_player_battery_percent'),
      power_connected: (() => {
        const value = metricValue('signhex_player_power_connected');
        if (value === null) return null;
        return value >= 1;
      })(),
      request_queue_items: metricValue('signhex_player_request_queue_items'),
      request_queue_oldest_age_seconds: metricValue('signhex_player_request_queue_oldest_age_seconds'),
      cache_used_bytes: metricValue('signhex_player_cache_bytes', (metric) => metric.state === 'used'),
      cache_total_bytes: metricValue('signhex_player_cache_bytes', (metric) => metric.state === 'total'),
      last_schedule_sync_at: parseUnixTime(metricValue('signhex_player_last_schedule_sync_unixtime')),
      display_count: metricValue('signhex_player_display_count'),
    },
    latest_backend_telemetry: latestBackendTelemetry,
    grafana: {
      enabled: appConfig.OBSERVABILITY_GRAFANA_ENABLED,
      embed_enabled: appConfig.OBSERVABILITY_GRAFANA_EMBED_ENABLED,
      links: grafanaLinks,
      embed_url:
        appConfig.OBSERVABILITY_GRAFANA_ENABLED && appConfig.OBSERVABILITY_GRAFANA_EMBED_ENABLED
          ? buildDashboardUrl('signhex-players-fleet', {
              kiosk: 'tv',
              theme: 'light',
              'var-device_id': screenId,
              'var-screen_id': screenId,
            })
          : null,
    },
  };
}
