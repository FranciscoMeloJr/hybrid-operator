package collector

import (
	"context"
	"fmt"
	"log"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
)

// OLM GroupVersionResources
var (
	subscriptionGVR = schema.GroupVersionResource{
		Group:    "operators.coreos.com",
		Version:  "v1alpha1",
		Resource: "subscriptions",
	}
	csvGVR = schema.GroupVersionResource{
		Group:    "operators.coreos.com",
		Version:  "v1alpha1",
		Resource: "clusterserviceversions",
	}
)

// OperatorInfo holds collected metadata for an installed OCP operator
type OperatorInfo struct {
	Name         string `json:"name"`
	Package      string `json:"package"`
	Namespace    string `json:"namespace"`
	Channel      string `json:"channel"`
	InstalledCSV string `json:"installedCSV"`
	Version      string `json:"version"`
	Phase        string `json:"phase"`
}

// TrackOperators queries all OLM Subscriptions and CSVs across the cluster
func TrackOperators(ctx context.Context, dynClient dynamic.Interface) ([]OperatorInfo, error) {
	// 1. Fetch all CSVs first and map them by "namespace/csvName" for instant lookup
	csvMap := make(map[string]struct {
		Version string
		Phase   string
	})

	csvs, err := dynClient.Resource(csvGVR).List(ctx, metav1.ListOptions{})
	if err != nil {
		log.Printf("[GOVERNANCE WARNING] Could not list CSVs: %v", err)
	} else {
		for _, csv := range csvs.Items {
			ns := csv.GetNamespace()
			name := csv.GetName()

			version, _, _ := unstructured.NestedString(csv.Object, "spec", "version")
			phase, _, _ := unstructured.NestedString(csv.Object, "status", "phase")

			key := fmt.Sprintf("%s/%s", ns, name)
			csvMap[key] = struct {
				Version string
				Phase   string
			}{
				Version: version,
				Phase:   phase,
			}
		}
	}

	// 2. Fetch all Subscriptions and join with their exact installed CSV
	subs, err := dynClient.Resource(subscriptionGVR).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("failed to list subscriptions: %w", err)
	}

	var results []OperatorInfo

	for _, sub := range subs.Items {
		name := sub.GetName()
		namespace := sub.GetNamespace()

		// Extract Subscription Spec fields
		packageName, _, _ := unstructured.NestedString(sub.Object, "spec", "name")
		channel, _, _ := unstructured.NestedString(sub.Object, "spec", "channel")
		startingCSV, _, _ := unstructured.NestedString(sub.Object, "spec", "startingCSV")

		// Extract Subscription Status fields
		installedCSV, _, _ := unstructured.NestedString(sub.Object, "status", "installedCSV")
		if installedCSV == "" {
			installedCSV = startingCSV
		}

		op := OperatorInfo{
			Name:         name,
			Package:      packageName,
			Namespace:    namespace,
			Channel:      channel,
			InstalledCSV: installedCSV,
			Phase:        "Unknown",
		}

		// Direct lookup of the matching CSV by namespace/installedCSV
		if installedCSV != "" {
			csvKey := fmt.Sprintf("%s/%s", namespace, installedCSV)
			if csvData, exists := csvMap[csvKey]; exists {
				op.Version = csvData.Version
				op.Phase = csvData.Phase
			}
		}

		results = append(results, op)
	}

	return results, nil
}