package collector

import (
	"context"
	"sort"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"

	"hybrid-operator/pkg/security"
)

// CVESourceReport is the output of the CVE-source spike: a factual summary of
// which real vulnerability data sources are actually available in this cluster,
// so we can pick an integration based on evidence rather than assumption.
type CVESourceReport struct {
	RHACSAvailable bool     `json:"rhacs_available"`
	RHACSDetail    string   `json:"rhacs_detail"`
	PyxisReachable bool     `json:"pyxis_reachable"`
	PyxisDetail    string   `json:"pyxis_detail"`
	Registries     []string `json:"registries"`
	ImageCount     int      `json:"image_count"`
	DigestCoverage int      `json:"digest_coverage"` // images with a resolved sha256 digest
	Recommendation string   `json:"recommendation"`
}

var namespaceGVR = schema.GroupVersionResource{
	Group:    "",
	Version:  "v1",
	Resource: "namespaces",
}

// ProbeCVESources inspects the cluster for usable CVE data sources and summarizes
// the collected image fleet. It is read-only and tolerant of missing permissions.
func ProbeCVESources(ctx context.Context, dynClient dynamic.Interface, images []ImageRef) CVESourceReport {
	report := CVESourceReport{}

	report.RHACSAvailable, report.RHACSDetail = detectRHACS(ctx, dynClient)
	report.PyxisReachable, report.PyxisDetail = security.CheckPyxisReachable()

	registrySet := make(map[string]bool)
	hasRedHatRegistry := false
	for _, img := range images {
		if img.Registry != "" {
			registrySet[img.Registry] = true
		}
		if img.Digest != "" {
			report.DigestCoverage++
		}
		if isRedHatRegistry(img.Registry) {
			hasRedHatRegistry = true
		}
	}
	report.ImageCount = len(images)
	report.Registries = make([]string, 0, len(registrySet))
	for r := range registrySet {
		report.Registries = append(report.Registries, r)
	}
	sort.Strings(report.Registries)

	report.Recommendation = recommendSource(report, hasRedHatRegistry)
	return report
}

// detectRHACS looks for Red Hat Advanced Cluster Security (StackRox): its install
// namespaces or the Central CRD. Either is strong evidence ACS can scan images.
func detectRHACS(ctx context.Context, dynClient dynamic.Interface) (bool, string) {
	for _, ns := range []string{"stackrox", "rhacs-operator"} {
		if _, err := dynClient.Resource(namespaceGVR).Get(ctx, ns, metav1.GetOptions{}); err == nil {
			return true, "found namespace '" + ns + "'"
		}
	}
	for _, crd := range []string{"centrals.platform.stackrox.io", "securedclusters.platform.stackrox.io"} {
		if _, err := dynClient.Resource(crdGVR).Get(ctx, crd, metav1.GetOptions{}); err == nil {
			return true, "found CRD '" + crd + "'"
		}
	}
	return false, "no RHACS namespace or Central/SecuredCluster CRD detected"
}

func isRedHatRegistry(registry string) bool {
	switch registry {
	case "registry.redhat.io", "registry.access.redhat.com", "quay.io":
		return true
	}
	return false
}

func recommendSource(r CVESourceReport, hasRedHatRegistry bool) string {
	switch {
	case r.RHACSAvailable:
		return "Use RHACS: Advanced Cluster Security is installed and already scans in-cluster images (most authoritative, covers operands)."
	case r.PyxisReachable && hasRedHatRegistry:
		return "Use Pyxis: the cluster can reach catalog.redhat.com and runs Red Hat-published images; resolve CVEs per image digest."
	case r.PyxisReachable:
		return "Pyxis reachable but few/no Red Hat registries detected; Pyxis coverage will be partial. Consider an image scanner (Trivy/Clair) for non-RH images."
	default:
		return "No automated CVE source detected in-cluster; an offline feed or an added scanner (RHACS/Trivy) is required."
	}
}
