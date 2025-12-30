export const API_PREFIX = '/api';
export const API_VERSION = 'v1';
export const API_BASE_PATH = `${API_PREFIX}/${API_VERSION}`;

const withBase = (path: string) => `${API_BASE_PATH}${path}`;

export const apiEndpoints = {
  auth: {
    login: withBase('/auth/login'),
    logout: withBase('/auth/logout'),
    me: withBase('/auth/me'),
  },
  users: {
    create: withBase('/users'),
    list: withBase('/users'),
    get: withBase('/users/:id'),
    update: withBase('/users/:id'),
    delete: withBase('/users/:id'),
  },
  userInvite: {
    invite: withBase('/users/invite'),
    list: withBase('/users/invite'),
    resetPassword: withBase('/users/:id/reset-password'),
    pending: withBase('/users/invite/pending'),
  },
  userActivate: {
    activate: withBase('/users/activate'),
  },
  departments: {
    create: withBase('/departments'),
    list: withBase('/departments'),
    get: withBase('/departments/:id'),
    update: withBase('/departments/:id'),
    delete: withBase('/departments/:id'),
  },
  media: {
    presignUpload: withBase('/media/presign-upload'),
    create: withBase('/media'),
    list: withBase('/media'),
    get: withBase('/media/:id'),
    complete: withBase('/media/:id/complete'),
  },
  presentations: {
    create: withBase('/presentations'),
    list: withBase('/presentations'),
    get: withBase('/presentations/:id'),
    update: withBase('/presentations/:id'),
    delete: withBase('/presentations/:id'),
  },
  schedules: {
    create: withBase('/schedules'),
    list: withBase('/schedules'),
    get: withBase('/schedules/:id'),
    update: withBase('/schedules/:id'),
    publish: withBase('/schedules/:id/publish'),
    publishes: withBase('/schedules/:id/publishes'),
    updatePublishTarget: withBase('/publishes/:publishId/targets/:targetId'),
    publishStatus: withBase('/publishes/:id'),
  },
  screens: {
    create: withBase('/screens'),
    list: withBase('/screens'),
    get: withBase('/screens/:id'),
    update: withBase('/screens/:id'),
    delete: withBase('/screens/:id'),
  },
  requests: {
    create: withBase('/requests'),
    list: withBase('/requests'),
    get: withBase('/requests/:id'),
    update: withBase('/requests/:id'),
    addMessage: withBase('/requests/:id/messages'),
    listMessages: withBase('/requests/:id/messages'),
  },
  notifications: {
    list: withBase('/notifications'),
    get: withBase('/notifications/:id'),
    markRead: withBase('/notifications/:id/read'),
    markAllRead: withBase('/notifications/read-all'),
    delete: withBase('/notifications/:id'),
  },
  auditLogs: {
    list: withBase('/audit-logs'),
    get: withBase('/audit-logs/:id'),
  },
  apiKeys: {
    create: withBase('/api-keys'),
    list: withBase('/api-keys'),
    rotate: withBase('/api-keys/:id/rotate'),
    revoke: withBase('/api-keys/:id/revoke'),
  },
  deviceTelemetry: {
    heartbeat: withBase('/device/heartbeat'),
    proofOfPlay: withBase('/device/proof-of-play'),
    screenshot: withBase('/device/screenshot'),
    commands: withBase('/device/:deviceId/commands'),
    ackCommand: withBase('/device/:deviceId/commands/:commandId/ack'),
  },
  devicePairing: {
    generate: withBase('/device-pairing/generate'),
    complete: withBase('/device-pairing/complete'),
    list: withBase('/device-pairing'),
  },
  emergency: {
    trigger: withBase('/emergency/trigger'),
    status: withBase('/emergency/status'),
    clear: withBase('/emergency/:id/clear'),
    history: withBase('/emergency/history'),
  },
  webhooks: {
    create: withBase('/webhooks'),
    list: withBase('/webhooks'),
    update: withBase('/webhooks/:id'),
    delete: withBase('/webhooks/:id'),
    test: withBase('/webhooks/:id/test'),
  },
  ssoConfig: {
    upsert: withBase('/sso-config'),
    list: withBase('/sso-config'),
    deactivate: withBase('/sso-config/:id/deactivate'),
  },
  settings: {
    list: withBase('/settings'),
    upsert: withBase('/settings'),
  },
  conversations: {
    start: withBase('/conversations'),
    list: withBase('/conversations'),
    listMessages: withBase('/conversations/:id/messages'),
    sendMessage: withBase('/conversations/:id/messages'),
    markRead: withBase('/conversations/:id/read'),
  },
  proofOfPlay: {
    list: withBase('/proof-of-play'),
    export: withBase('/proof-of-play/export'),
  },
  metrics: {
    overview: withBase('/metrics/overview'),
  },
  reports: {
    summary: withBase('/reports/summary'),
    trends: withBase('/reports/trends'),
    requestsByDepartment: withBase('/reports/requests-by-department'),
    offlineScreens: withBase('/reports/offline-screens'),
    storage: withBase('/reports/storage'),
    systemHealth: withBase('/reports/system-health'),
  },
};

export const PENDINGSTATUS = 'PENDING';
