#!/bin/bash
# GameHub Backend - API Test Script
# Usage: bash test-api.sh

API_URL="http://localhost:88"
SUCCESS=0
FAIL=0

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "================================"
echo "   GameHub Backend - API Test    "
echo "================================"
echo ""

# Helper function to test endpoints
test_endpoint() {
  local METHOD=$1
  local ENDPOINT=$2
  local DATA=$3
  local EXPECTED_FIELD=$4
  
  echo -n "Testing $METHOD $ENDPOINT... "
  
  if [ "$METHOD" = "GET" ]; then
    RESPONSE=$(curl -s -w "\n%{http_code}" "$API_URL$ENDPOINT")
  else
    RESPONSE=$(curl -s -w "\n%{http_code}" -X $METHOD "$API_URL$ENDPOINT" \
      -H "Content-Type: application/json" \
      -d "$DATA")
  fi
  
  HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
  BODY=$(echo "$RESPONSE" | sed '$d')
  
  if [[ "$HTTP_CODE" =~ ^[2]00$ ]]; then
    echo -e "${GREEN}✓ HTTP $HTTP_CODE${NC}"
    ((SUCCESS++))
  else
    echo -e "${RED}✗ HTTP $HTTP_CODE${NC}"
    ((FAIL++))
  fi
}

# Test Health Endpoint
echo -e "${YELLOW}1. Health & Status${NC}"
test_endpoint "GET" "/health"
test_endpoint "GET" "/"

echo ""
echo -e "${YELLOW}2. Gaming Hub${NC}"
test_endpoint "GET" "/fetch-games"
test_endpoint "GET" "/stores"
test_endpoint "GET" "/free"
test_endpoint "GET" "/discounted"

echo ""
echo -e "${YELLOW}3. Favorites${NC}"
test_endpoint "GET" "/getFav?userId=testuser"
test_endpoint "POST" "/addfav" '{"userId":"testuser","gameId":123,"name":"TestGame"}'
test_endpoint "DELETE" "/delfav/123" '{"userId":"testuser"}'

echo ""
echo -e "${YELLOW}4. Reviews${NC}"
test_endpoint "POST" "/submit-review" \
  '{"gameId":1,"userId":"user1","email":"test@example.com","reviewText":"Great!","rating":8,"gameName":"Game"}'
test_endpoint "GET" "/get-all-reviews"

echo ""
echo -e "${YELLOW}5. Movies${NC}"
test_endpoint "GET" "/movies"
test_endpoint "GET" "/trending-movies"
test_endpoint "GET" "/top-rated-movies"

echo ""
echo -e "${YELLOW}6. Dead by Daylight${NC}"
test_endpoint "GET" "/characters"
test_endpoint "GET" "/charactersK"
test_endpoint "GET" "/events"
test_endpoint "GET" "/addons"

echo ""
echo "================================"
echo -e "Tests Complete: ${GREEN}$SUCCESS passed${NC}, ${RED}$FAIL failed${NC}"
echo "================================"

# Exit with appropriate code
if [ $FAIL -eq 0 ]; then
  exit 0
else
  exit 1
fi
