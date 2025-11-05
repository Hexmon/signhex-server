#!/bin/bash

# Hexmon Signage API Testing Script
# This script tests all major API endpoints

set -e

API_URL="http://localhost:3000"
ADMIN_EMAIL="admin@hexmon.local"
ADMIN_PASSWORD="SecurePassword123!"

echo "🚀 Hexmon Signage API Testing Script"
echo "======================================"
echo ""

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to print test results
test_endpoint() {
  local method=$1
  local endpoint=$2
  local data=$3
  local expected_code=$4
  
  echo -n "Testing $method $endpoint... "
  
  if [ -z "$data" ]; then
    response=$(curl -s -w "\n%{http_code}" -X $method "$API_URL$endpoint" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json")
  else
    response=$(curl -s -w "\n%{http_code}" -X $method "$API_URL$endpoint" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -d "$data")
  fi
  
  http_code=$(echo "$response" | tail -n1)
  body=$(echo "$response" | head -n-1)
  
  if [ "$http_code" = "$expected_code" ]; then
    echo -e "${GREEN}✓ ($http_code)${NC}"
    echo "$body"
  else
    echo -e "${RED}✗ (Expected $expected_code, got $http_code)${NC}"
    echo "$body"
  fi
  echo ""
}

# Step 1: Health Check
echo -e "${YELLOW}Step 1: Health Check${NC}"
curl -s "$API_URL/health" | jq '.'
echo ""

# Step 2: Login
echo -e "${YELLOW}Step 2: Login${NC}"
login_response=$(curl -s -X POST "$API_URL/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d "{
    \"email\": \"$ADMIN_EMAIL\",
    \"password\": \"$ADMIN_PASSWORD\"
  }")

TOKEN=$(echo "$login_response" | jq -r '.access_token')
if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
  echo -e "${RED}Failed to login${NC}"
  echo "$login_response" | jq '.'
  exit 1
fi
echo -e "${GREEN}✓ Login successful${NC}"
echo "Token: ${TOKEN:0:20}..."
echo ""

# Step 3: Get Current User
echo -e "${YELLOW}Step 3: Get Current User${NC}"
curl -s -X GET "$API_URL/v1/auth/me" \
  -H "Authorization: Bearer $TOKEN" | jq '.'
echo ""

# Step 4: Create Department
echo -e "${YELLOW}Step 4: Create Department${NC}"
dept_response=$(curl -s -X POST "$API_URL/v1/departments" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Marketing",
    "description": "Marketing Department"
  }')
DEPT_ID=$(echo "$dept_response" | jq -r '.id')
echo "$dept_response" | jq '.'
echo ""

# Step 5: List Departments
echo -e "${YELLOW}Step 5: List Departments${NC}"
curl -s -X GET "$API_URL/v1/departments?page=1&limit=10" \
  -H "Authorization: Bearer $TOKEN" | jq '.'
echo ""

# Step 6: Create User
echo -e "${YELLOW}Step 6: Create User${NC}"
user_response=$(curl -s -X POST "$API_URL/v1/users" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "operator@hexmon.local",
    "name": "Operator User",
    "password": "SecurePassword123!",
    "role": "OPERATOR"
  }')
USER_ID=$(echo "$user_response" | jq -r '.id')
echo "$user_response" | jq '.'
echo ""

# Step 7: Create Screen
echo -e "${YELLOW}Step 7: Create Screen${NC}"
screen_response=$(curl -s -X POST "$API_URL/v1/screens" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Lobby Screen",
    "description": "Main lobby display",
    "location": "Lobby",
    "resolution": "1920x1080"
  }')
SCREEN_ID=$(echo "$screen_response" | jq -r '.id')
echo "$screen_response" | jq '.'
echo ""

# Step 8: Create Schedule
echo -e "${YELLOW}Step 8: Create Schedule${NC}"
schedule_response=$(curl -s -X POST "$API_URL/v1/schedules" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Morning Schedule",
    "description": "Morning content",
    "is_active": true
  }')
SCHEDULE_ID=$(echo "$schedule_response" | jq -r '.id')
echo "$schedule_response" | jq '.'
echo ""

# Step 9: Create Presentation
echo -e "${YELLOW}Step 9: Create Presentation${NC}"
presentation_response=$(curl -s -X POST "$API_URL/v1/presentations" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Q1 Campaign",
    "description": "Q1 Marketing Campaign"
  }')
PRESENTATION_ID=$(echo "$presentation_response" | jq -r '.id')
echo "$presentation_response" | jq '.'
echo ""

# Step 10: Create Request
echo -e "${YELLOW}Step 10: Create Request${NC}"
request_response=$(curl -s -X POST "$API_URL/v1/requests" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Update homepage content",
    "description": "Need to update the homepage with new images",
    "priority": "HIGH"
  }')
REQUEST_ID=$(echo "$request_response" | jq -r '.id')
echo "$request_response" | jq '.'
echo ""

# Step 11: Trigger Emergency
echo -e "${YELLOW}Step 11: Trigger Emergency${NC}"
emergency_response=$(curl -s -X POST "$API_URL/v1/emergency/trigger" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "System maintenance in progress",
    "severity": "HIGH"
  }')
EMERGENCY_ID=$(echo "$emergency_response" | jq -r '.id')
echo "$emergency_response" | jq '.'
echo ""

# Step 12: Get Emergency Status
echo -e "${YELLOW}Step 12: Get Emergency Status${NC}"
curl -s -X GET "$API_URL/v1/emergency/status" \
  -H "Authorization: Bearer $TOKEN" | jq '.'
echo ""

# Step 13: List Notifications
echo -e "${YELLOW}Step 13: List Notifications${NC}"
curl -s -X GET "$API_URL/v1/notifications?page=1&limit=10" \
  -H "Authorization: Bearer $TOKEN" | jq '.'
echo ""

# Step 14: List Audit Logs
echo -e "${YELLOW}Step 14: List Audit Logs${NC}"
curl -s -X GET "$API_URL/v1/audit-logs?page=1&limit=10" \
  -H "Authorization: Bearer $TOKEN" | jq '.'
echo ""

# Step 15: Device Pairing
echo -e "${YELLOW}Step 15: Generate Device Pairing Code${NC}"
pairing_response=$(curl -s -X POST "$API_URL/v1/device-pairing/generate" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "device_id": "device-001",
    "expires_in": 3600
  }')
PAIRING_CODE=$(echo "$pairing_response" | jq -r '.pairing_code')
echo "$pairing_response" | jq '.'
echo ""

# Step 16: Device Heartbeat
echo -e "${YELLOW}Step 16: Device Heartbeat${NC}"
curl -s -X POST "$API_URL/v1/device/heartbeat" \
  -H "Content-Type: application/json" \
  -d '{
    "device_id": "device-001",
    "status": "ONLINE",
    "uptime": 86400,
    "memory_usage": 512,
    "cpu_usage": 45.5,
    "temperature": 65.2
  }' | jq '.'
echo ""

echo -e "${GREEN}✅ All tests completed!${NC}"
echo ""
echo "Created Resources:"
echo "  Department ID: $DEPT_ID"
echo "  User ID: $USER_ID"
echo "  Screen ID: $SCREEN_ID"
echo "  Schedule ID: $SCHEDULE_ID"
echo "  Presentation ID: $PRESENTATION_ID"
echo "  Request ID: $REQUEST_ID"
echo "  Emergency ID: $EMERGENCY_ID"
echo "  Pairing Code: $PAIRING_CODE"

