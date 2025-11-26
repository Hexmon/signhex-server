
import 'dotenv/config';

const BASE_URL = 'http://localhost:3000';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@hexmon.local';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';

let authToken = '';

async function request(method: string, path: string, body?: any, token?: string) {
    const headers: any = {
        'Content-Type': 'application/json',
    };
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }

    try {
        const res = await fetch(`${BASE_URL}${path}`, {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined,
        });

        const contentType = res.headers.get('content-type');
        let data;
        if (contentType && contentType.includes('application/json')) {
            data = await res.json();
        } else {
            data = await res.text();
        }

        return {
            status: res.status,
            data,
        };
    } catch (error) {
        return {
            status: 0,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

async function runTests() {
    console.log('Starting API Tests...');
    console.log(`Target: ${BASE_URL}`);

    // 1. Login
    console.log('\n[Auth] Login');
    const loginRes = await request('POST', '/v1/auth/login', {
        email: ADMIN_EMAIL,
        password: ADMIN_PASSWORD,
    });

    if (loginRes.status !== 200 && loginRes.status !== 201) {
        console.error('Login failed:', JSON.stringify(loginRes, null, 2));
        process.exit(1);
    }

    authToken = loginRes.data.token || loginRes.data.accessToken;
    console.log('Login successful. Token obtained:', authToken ? 'YES' : 'NO');
    if (authToken) console.log('Token start:', authToken.substring(0, 10) + '...');

    // 2. Users
    console.log('\n[Users] List Users');
    const listUsers = await request('GET', '/v1/users', null, authToken);
    console.log(`Status: ${listUsers.status}`);

    // 3. Departments
    console.log('\n[Departments] List Departments');
    const listDepts = await request('GET', '/v1/departments', null, authToken);
    console.log(`Status: ${listDepts.status}`);

    // 4. Screens
    console.log('\n[Screens] List Screens');
    const listScreens = await request('GET', '/v1/screens', null, authToken);
    console.log(`Status: ${listScreens.status}`);

    // 5. Screen Groups (Expected Missing)
    console.log('\n[Screen Groups] List Screen Groups (Expect 404)');
    const listScreenGroups = await request('GET', '/v1/screen-groups', null, authToken);
    console.log(`Status: ${listScreenGroups.status} (Expected 404)`);

    // 6. Media
    console.log('\n[Media] List Media');
    const listMedia = await request('GET', '/v1/media', null, authToken);
    console.log(`Status: ${listMedia.status}`);

    // 7. Schedules
    console.log('\n[Schedules] List Schedules');
    const listSchedules = await request('GET', '/v1/schedules', null, authToken);
    console.log(`Status: ${listSchedules.status}`);

    // 8. Presentations
    console.log('\n[Presentations] List Presentations');
    const listPresentations = await request('GET', '/v1/presentations', null, authToken);
    console.log(`Status: ${listPresentations.status}`);

    // 9. Audit Logs
    console.log('\n[Audit Logs] List Audit Logs');
    const listAudit = await request('GET', '/v1/audit-logs', null, authToken);
    console.log(`Status: ${listAudit.status}`);

    // 10. Settings
    console.log('\n[Settings] List Settings');
    const listSettings = await request('GET', '/v1/settings', null, authToken);
    console.log(`Status: ${listSettings.status}`);

    // 11. Notifications
    console.log('\n[Notifications] List Notifications');
    const listNotifs = await request('GET', '/v1/notifications', null, authToken);
    console.log(`Status: ${listNotifs.status}`);

    // 12. Requests
    console.log('\n[Requests] List Requests');
    const listRequests = await request('GET', '/v1/requests', null, authToken);
    console.log(`Status: ${listRequests.status}`);

    // 13. API Keys
    console.log('\n[API Keys] List API Keys');
    const listApiKeys = await request('GET', '/v1/api-keys', null, authToken);
    console.log(`Status: ${listApiKeys.status}`);

    // 14. Webhooks
    console.log('\n[Webhooks] List Webhooks');
    const listWebhooks = await request('GET', '/v1/webhooks', null, authToken);
    console.log(`Status: ${listWebhooks.status}`);

    // 15. SSO Config
    console.log('\n[SSO Config] List SSO Config');
    const listSSO = await request('GET', '/v1/sso-config', null, authToken);
    console.log(`Status: ${listSSO.status}`);

    // 16. Conversations
    console.log('\n[Conversations] List Conversations');
    const listConvos = await request('GET', '/v1/conversations', null, authToken);
    console.log(`Status: ${listConvos.status}`);

    // 17. Proof of Play
    console.log('\n[Proof of Play] List Proof of Play');
    const listPoP = await request('GET', '/v1/proof-of-play', null, authToken);
    console.log(`Status: ${listPoP.status}`);

    // 18. Metrics
    console.log('\n[Metrics] Overview');
    const metrics = await request('GET', '/v1/metrics/overview', null, authToken);
    console.log(`Status: ${metrics.status}`);

    // 19. Reports
    console.log('\n[Reports] Summary');
    const reports = await request('GET', '/v1/reports/summary', null, authToken);
    console.log(`Status: ${reports.status}`);

    console.log('\nTests Completed.');
}

runTests();
