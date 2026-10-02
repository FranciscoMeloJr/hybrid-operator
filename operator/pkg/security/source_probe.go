package security

import (
	"context"
	"fmt"
	"net/http"
	"time"
)

// CheckPyxisReachable tests whether the cluster has egress to the Red Hat
// Container Catalog (Pyxis) API, which is one candidate source for real
// image-based CVE data. This only tests reachability, not authorization.
func CheckPyxisReachable() (bool, string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Lightweight, unauthenticated catalog endpoint used purely as a reachability probe.
	const url = "https://catalog.redhat.com/api/containers/v1/images/registries"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return false, err.Error()
	}

	resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		return false, fmt.Sprintf("no egress to catalog.redhat.com: %v", err)
	}
	defer resp.Body.Close()

	// Any HTTP response (even 4xx) proves egress works; connection errors are the
	// real signal that Pyxis cannot be used from this cluster.
	if resp.StatusCode < 500 {
		return true, fmt.Sprintf("catalog.redhat.com reachable (HTTP %d)", resp.StatusCode)
	}
	return false, fmt.Sprintf("catalog.redhat.com returned HTTP %d", resp.StatusCode)
}
