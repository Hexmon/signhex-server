# Signhex Player API cURL (Electron Screen App)

Set env vars:  
`baseURL` (e.g., `http://localhost:3000`), `deviceId`, `pairingCode`, `commandId`

## Pairing
- Complete pairing (device)  
  ```bash
  curl -X POST "{{baseURL}}/v1/device-pairing/complete" \
    -H "Content-Type: application/json" \
    -d '{"pairing_code":"{{pairingCode}}","csr":"<base64_or_pem_csr>"}'
  ```

## Telemetry
- Heartbeat  
  ```bash
  curl -X POST "{{baseURL}}/v1/device/heartbeat" \
    -H "Content-Type: application/json" \
    -d '{"device_id":"{{deviceId}}","status":"ONLINE","uptime":1234,"memory_usage":42.1,"cpu_usage":12.3,"temperature":55,"current_schedule_id":"{{scheduleId}}","current_media_id":"{{mediaId}}"}'
  ```
- Proof of Play  
  ```bash
  curl -X POST "{{baseURL}}/v1/device/proof-of-play" \
    -H "Content-Type: application/json" \
    -d '{"device_id":"{{deviceId}}","media_id":"{{mediaId}}","schedule_id":"{{scheduleId}}","start_time":"2025-01-01T00:00:00Z","end_time":"2025-01-01T00:00:05Z","duration":5,"completed":true}'
  ```
- Screenshot  
  ```bash
  curl -X POST "{{baseURL}}/v1/device/screenshot" \
    -H "Content-Type: application/json" \
    -d '{"device_id":"{{deviceId}}","timestamp":"2025-01-01T00:00:00Z","image_data":"{{base64Png}}"}'
  ```

## Commands
- Get pending commands  
  ```bash
  curl "{{baseURL}}/v1/device/{{deviceId}}/commands"
  ```
- Acknowledge command  
  ```bash
  curl -X POST "{{baseURL}}/v1/device/{{deviceId}}/commands/{{commandId}}/ack"
  ```
