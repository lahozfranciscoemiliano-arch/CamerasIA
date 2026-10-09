export type Role = "admin" | "operator" | "viewer";
export type Severity = "info" | "low" | "medium" | "high" | "critical";
export type EventStatus = "new" | "ack" | "investigating" | "resolved" | "false_positive";

export interface User {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  totpEnabled: boolean;
  mustChangePassword: boolean;
  disabled: boolean;
  lockedUntil: number | null;
  lastLoginAt: number | null;
  lastLoginIp: string | null;
  createdAt: number;
}

export interface Me {
  user: User;
  restrictions: { mustChangePassword: boolean; mustEnrollTotp: boolean };
  stepUpUntil: number | null;
  recoveryCodesLeft: number;
}

export interface Camera {
  id: string;
  serverId: string;
  serverName: string;
  sourceKind: "exacq" | "demo";
  cameraId: string;
  name: string;
  zone: string | null;
  enabled: boolean;
  motionEnabled: boolean;
  aiVerify: boolean;
  sensitivity: number;
  online: boolean;
  lastSeenAt: number | null;
  sortOrder: number;
}

export interface VisionResult {
  summary: string;
  people_count: number;
  vehicles_count: number;
  detected: string[];
  activities: string[];
  anomalies: string[];
  event_type: string;
  threat_level: "none" | "low" | "medium" | "high" | "critical";
  recommended_action: string;
  confidence: number;
  simulated?: boolean;
  model?: string;
}

export interface SecEvent {
  id: number;
  ts: number;
  type: string;
  severity: Severity;
  source: string;
  cameraId: string | null;
  cameraName: string | null;
  title: string;
  description: string | null;
  hasSnapshot: boolean;
  ai: VisionResult | null;
  status: EventStatus;
  assignedTo: string | null;
  ackBy: string | null;
  ackAt: number | null;
  resolvedBy: string | null;
  resolvedAt: number | null;
  meta: Record<string, unknown> | null;
  notes?: Array<{ id: number; username: string; ts: number; text: string }>;
}

export interface EventStats {
  hours: number;
  bucketMs: number;
  total: number;
  open: number;
  openCritical: number;
  mttaMs: number | null;
  aiVerified: number;
  bySeverity: Partial<Record<Severity, number>>;
  byType: Array<{ type: string; count: number }>;
  byCamera: Array<{ cameraId: string; cameraName: string; count: number }>;
  timeline: Array<{ bucket: number; severity: Severity; n: number }>;
  threat: Threat;
}

export interface Threat {
  level: number;
  label: string;
  score: number;
}

export interface VpnStatus {
  state: "disconnected" | "connecting" | "connected" | "disconnecting" | "error";
  mode: "openfortivpn" | "simulate" | "disabled";
  binaryAvailable: boolean;
  binaryVersion: string | null;
  profileId: string | null;
  profileName: string | null;
  gateway: string | null;
  since: number | null;
  assignedIp: string | null;
  iface: string | null;
  error: string | null;
  untrustedCertDigest: string | null;
  rxBytes: number;
  txBytes: number;
  connectedBy: string | null;
}

export interface VpnProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  realm: string | null;
  trustedCerts: string[];
  setRoutes: boolean;
  setDns: boolean;
  halfInternetRoutes: boolean;
  otpRequired: boolean;
  credentialId: string | null;
  autoConnect: boolean;
  updatedAt: number;
}

export interface Host {
  id: string;
  name: string;
  host: string;
  port: number;
  kind: string;
  enabled: boolean;
  status: "up" | "down" | "unknown";
  latencyMs: number | null;
  checkedAt: number | null;
  changedAt: number | null;
  simulated: boolean;
}

export interface SystemInfo {
  hostname: string;
  platform: string;
  uptimeSec: number;
  processUptimeSec: number;
  cpuPct: number;
  cores: number;
  load: number[];
  memTotal: number;
  memFree: number;
  rss: number;
  disk: { total: number; free: number } | null;
}

export interface SourceStatus {
  id: string;
  name: string;
  kind: "exacq" | "demo";
  ok: boolean;
  detail: string;
  lastOkAt: number | null;
  latencyMs?: number;
}

export interface Dashboard {
  now: number;
  demo: boolean;
  threat: Threat;
  stats: EventStats;
  cameras: { total: number; online: number; offline: Array<{ id: string; name: string }>; detection: number; aiVerify: number };
  sources: SourceStatus[];
  vpn: VpnStatus;
  hosts: Host[];
  system: SystemInfo;
  ai: {
    available: boolean;
    model: string;
    budget: { usedLastHour: number; maxPerHour: number };
    engine: { framesAnalyzed: number; motionEvents: number; aiVerified: number; aiDismissed: number; errors: number };
  };
  recent: SecEvent[];
}

export interface VaultEntry {
  id: string;
  name: string;
  kind: "fortivpn" | "exacq" | "anthropic" | "camera" | "api" | "generic";
  host: string | null;
  notes: string | null;
  usernameMasked: string | null;
  hasPassword: boolean;
  hasToken: boolean;
  extraKeys: string[];
  keyVersion: number;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
}

export interface ExacqServer {
  id: string;
  name: string;
  baseUrl: string;
  credentialId: string | null;
  enabled: boolean;
  snapshotTemplate: string | null;
  liveTemplate: string | null;
  vpnProfileId: string | null;
  timezone: string | null;
  lastOkAt: number | null;
  lastError: string | null;
}

export interface Clip {
  start: string;
  end: string;
}

export interface ExportJob {
  id: string;
  cameraKey: string;
  cameraName: string;
  start: string;
  end: string;
  status: "queued" | "exporting" | "downloading" | "ready" | "error";
  progress: number;
  kind: "mp4" | "mjpeg";
  filename?: string;
  bytes?: number;
  error?: string;
  createdBy: string;
  createdAt: number;
}

export interface AuditRow {
  id: number;
  ts: number;
  user_id: number | null;
  username: string | null;
  action: string;
  target: string | null;
  ip: string | null;
  outcome: "success" | "failure" | "denied";
  details: Record<string, unknown> | null;
  hash: string;
}
