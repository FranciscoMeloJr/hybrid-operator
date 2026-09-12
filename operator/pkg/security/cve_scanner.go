package security

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
)

// CVEInfo represents a security vulnerability
type CVEInfo struct {
	ID          string   `json:"id"`
	Severity    string   `json:"severity"`    // Critical, High, Medium, Low
	Description string   `json:"description"`
	AffectedVersions []string `json:"affected_versions"`
	FixedVersion string   `json:"fixed_version"`
	PublishedDate string  `json:"published_date"`
	CVSS        float64  `json:"cvss_score"`
}

// CVECache stores CVE data with TTL
type CVECache struct {
	mu    sync.RWMutex
	data  map[string][]CVEInfo // operator package -> CVE list
	expiry map[string]time.Time
	ttl   time.Duration
}

var globalCache *CVECache

func init() {
	globalCache = &CVECache{
		data:   make(map[string][]CVEInfo),
		expiry: make(map[string]time.Time),
		ttl:    24 * time.Hour,
	}
}

// GetCVEsForOperator fetches CVEs from Red Hat Security Data API (with cache)
func GetCVEsForOperator(operatorPackage, version string) ([]CVEInfo, error) {
	cacheKey := fmt.Sprintf("%s:%s", operatorPackage, version)

	// Check cache first
	globalCache.mu.RLock()
	if cachedCVEs, exists := globalCache.data[cacheKey]; exists {
		if time.Now().Before(globalCache.expiry[cacheKey]) {
			globalCache.mu.RUnlock()
			return cachedCVEs, nil
		}
	}
	globalCache.mu.RUnlock()

	// Fetch from API (mock implementation for now - replace with real Red Hat API)
	cves := fetchCVEsFromAPI(operatorPackage, version)

	// Update cache
	globalCache.mu.Lock()
	globalCache.data[cacheKey] = cves
	globalCache.expiry[cacheKey] = time.Now().Add(globalCache.ttl)
	globalCache.mu.Unlock()

	return cves, nil
}

// Mock CVE fetcher - replace with real Red Hat Security Data API integration
func fetchCVEsFromAPI(operatorPackage, version string) []CVEInfo {
	// TODO: Replace with actual Red Hat Security Data API call
	// API: https://access.redhat.com/labs/securitydataapi/
	// Example: GET https://access.redhat.com/labs/securitydataapi/cve.json?package={package}

	// For now, return mock data for demonstration
	// In production, this would make HTTP request to Red Hat API

	// Simulate some operators having CVEs
	if strings.Contains(operatorPackage, "openshift") || strings.Contains(operatorPackage, "kubernetes") {
		return []CVEInfo{
			{
				ID:          "CVE-2024-1234",
				Severity:    "Medium",
				Description: "Sample CVE for demonstration purposes",
				AffectedVersions: []string{version},
				FixedVersion: "1.0.0",
				PublishedDate: "2024-01-15",
				CVSS:        5.5,
			},
		}
	}

	return []CVEInfo{} // No CVEs found
}

// FetchCVEsFromRedHat makes actual HTTP request to Red Hat API
func FetchCVEsFromRedHat(operatorPackage string) ([]CVEInfo, error) {
	// Real implementation for Red Hat Security Data API
	baseURL := "https://access.redhat.com/labs/securitydataapi/cve.json"

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, "GET", baseURL, nil)
	if err != nil {
		return nil, err
	}

	q := req.URL.Query()
	q.Add("package", operatorPackage)
	q.Add("per_page", "50")
	req.URL.RawQuery = q.Encode()

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch CVEs: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return []CVEInfo{}, nil // No CVEs or API error
	}

	var apiResponse []struct {
		CVE               string  `json:"CVE"`
		Severity          string  `json:"severity"`
		PublicDate        string  `json:"public_date"`
		Bugzilla          struct {
			Description string `json:"description"`
		} `json:"bugzilla"`
		AffectedRelease []struct {
			Package string `json:"package"`
			CPE     string `json:"cpe"`
		} `json:"affected_release"`
		CVSS3 struct {
			Score float64 `json:"cvss3_base_score"`
		} `json:"cvss3"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&apiResponse); err != nil {
		return nil, fmt.Errorf("failed to decode CVE response: %w", err)
	}

	cves := make([]CVEInfo, 0, len(apiResponse))
	for _, item := range apiResponse {
		cves = append(cves, CVEInfo{
			ID:          item.CVE,
			Severity:    item.Severity,
			Description: item.Bugzilla.Description,
			PublishedDate: item.PublicDate,
			CVSS:        item.CVSS3.Score,
		})
	}

	return cves, nil
}

// GetCVESummary returns CVE counts by severity
func GetCVESummary(cves []CVEInfo) map[string]int {
	summary := map[string]int{
		"Critical": 0,
		"High":     0,
		"Medium":   0,
		"Low":      0,
	}

	for _, cve := range cves {
		summary[cve.Severity]++
	}

	return summary
}
