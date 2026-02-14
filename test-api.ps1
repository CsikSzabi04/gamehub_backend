# GameHub Backend - API Test Script (PowerShell)
# Usage: .\test-api.ps1

$API_URL = "http://localhost:88"
$successful = 0
$failed = 0

Write-Host "================================" -ForegroundColor Yellow
Write-Host "   GameHub Backend - API Test    " -ForegroundColor Cyan
Write-Host "================================" -ForegroundColor Yellow
Write-Host ""

# Helper function to test endpoints
function Test-Endpoint {
    param(
        [string]$Method,
        [string]$Endpoint,
        [string]$Data = $null
    )
    
    Write-Host -NoNewline "Testing $Method $Endpoint... "
    
    try {
        if ($Method -eq "GET") {
            $response = Invoke-WebRequest -Uri "$API_URL$Endpoint" -Method GET -UseBasicParsing
        }
        else {
            $response = Invoke-WebRequest -Uri "$API_URL$Endpoint" -Method $Method `
                -Body $Data -ContentType "application/json" -UseBasicParsing
        }
        
        Write-Host "OK HTTP $($response.StatusCode)" -ForegroundColor Green
        $global:successful++
    }
    catch {
        Write-Host "ERROR" -ForegroundColor Red
        $global:failed++
    }
}

# Test Health Endpoint
Write-Host "1. Health & Status" -ForegroundColor Yellow
Test-Endpoint "GET" "/health"
Test-Endpoint "GET" "/"

Write-Host ""
Write-Host "2. Gaming Hub" -ForegroundColor Yellow
Test-Endpoint "GET" "/fetch-games"
Test-Endpoint "GET" "/stores"
Test-Endpoint "GET" "/free"
Test-Endpoint "GET" "/discounted"

Write-Host ""
Write-Host "3. Favorites" -ForegroundColor Yellow
Test-Endpoint "GET" "/getFav?userId=testuser"
$favData = '{"userId":"testuser","gameId":123,"name":"TestGame"}'
Test-Endpoint "POST" "/addfav" $favData

Write-Host ""
Write-Host "4. Reviews" -ForegroundColor Yellow
$reviewData = '{"gameId":1,"userId":"user1","email":"test@example.com","reviewText":"Great!","rating":8,"gameName":"Game"}'
Test-Endpoint "POST" "/submit-review" $reviewData
Test-Endpoint "GET" "/get-all-reviews"

Write-Host ""
Write-Host "5. Movies" -ForegroundColor Yellow
Test-Endpoint "GET" "/movies"
Test-Endpoint "GET" "/trending-movies"
Test-Endpoint "GET" "/top-rated-movies"

Write-Host ""
Write-Host "6. Dead by Daylight" -ForegroundColor Yellow
Test-Endpoint "GET" "/characters"
Test-Endpoint "GET" "/charactersK"
Test-Endpoint "GET" "/events"
Test-Endpoint "GET" "/addons"

Write-Host ""
Write-Host "================================" -ForegroundColor Yellow
Write-Host "Tests Complete: $successful passed, $failed failed" -ForegroundColor Cyan
if ($failed -eq 0) {
    Write-Host "✓ All tests passed!" -ForegroundColor Green
} else {
    Write-Host "✗ Some tests failed" -ForegroundColor Red
}
Write-Host "================================" -ForegroundColor Yellow
