package collector

import (
	"context"
	"log"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
)

var (
	podGVR = schema.GroupVersionResource{
		Group:    "",
		Version:  "v1",
		Resource: "pods",
	}
)

// CollectOLMHealthStatus gathers comprehensive health metrics for OLM system components
func CollectOLMHealthStatus(ctx context.Context, dynClient dynamic.Interface, ips *unstructured.UnstructuredList, catsrcs *unstructured.UnstructuredList) OLMHealthStatus {
	health := OLMHealthStatus{
		OLMOperatorStatus:     "Unknown",
		CatalogOperatorStatus: "Unknown",
	}

	// === InstallPlan Statistics ===
	if ips != nil {
		health.InstallPlanCount = len(ips.Items)
		for _, ip := range ips.Items {
			phase, found, _ := unstructured.NestedString(ip.Object, "status", "phase")
			if found {
				switch phase {
				case "Installing", "RequiresApproval":
					health.InstallPlanPending++
				case "Failed":
					health.InstallPlanFailed++
				}
			}
		}
	}

	// === CatalogSource Statistics ===
	if catsrcs != nil {
		health.CatalogSourceCount = len(catsrcs.Items)
		for _, cs := range catsrcs.Items {
			// Check connection state
			connState, found, _ := unstructured.NestedString(cs.Object, "status", "connectionState", "lastObservedState")
			if found && connState == "READY" {
				health.CatalogSourceReady++
			} else if found && (connState == "TRANSIENT_FAILURE" || connState == "SHUTDOWN") {
				health.CatalogSourceFailed++
			}
		}
	}

	// === OLM Operator Pod Health ===
	// Check olm-operator pod in openshift-operator-lifecycle-manager namespace
	olmPods, err := dynClient.Resource(podGVR).Namespace("openshift-operator-lifecycle-manager").List(ctx, metav1.ListOptions{
		LabelSelector: "app=olm-operator",
	})
	if err == nil && len(olmPods.Items) > 0 {
		health.OLMOperatorStatus = getPodStatus(olmPods.Items[0])
	} else if err != nil {
		log.Printf("[OLM HEALTH] Failed to query olm-operator pod: %v", err)
		health.OLMOperatorStatus = "Error"
	} else {
		health.OLMOperatorStatus = "NotFound"
	}

	// === Catalog Operator Pod Health ===
	// Check catalog-operator pod in openshift-operator-lifecycle-manager namespace
	catalogPods, err := dynClient.Resource(podGVR).Namespace("openshift-operator-lifecycle-manager").List(ctx, metav1.ListOptions{
		LabelSelector: "app=catalog-operator",
	})
	if err == nil && len(catalogPods.Items) > 0 {
		health.CatalogOperatorStatus = getPodStatus(catalogPods.Items[0])
	} else if err != nil {
		log.Printf("[OLM HEALTH] Failed to query catalog-operator pod: %v", err)
		health.CatalogOperatorStatus = "Error"
	} else {
		health.CatalogOperatorStatus = "NotFound"
	}

	log.Printf("[OLM HEALTH] InstallPlans: %d total, %d pending, %d failed | CatalogSources: %d total, %d ready, %d failed | OLM Operator: %s | Catalog Operator: %s",
		health.InstallPlanCount,
		health.InstallPlanPending,
		health.InstallPlanFailed,
		health.CatalogSourceCount,
		health.CatalogSourceReady,
		health.CatalogSourceFailed,
		health.OLMOperatorStatus,
		health.CatalogOperatorStatus,
	)

	return health
}

// getPodStatus extracts the pod phase and checks container statuses
func getPodStatus(pod unstructured.Unstructured) string {
	phase, found, _ := unstructured.NestedString(pod.Object, "status", "phase")
	if !found {
		return "Unknown"
	}

	// If pod is Running, check container statuses for deeper health
	if phase == "Running" {
		containerStatuses, found, _ := unstructured.NestedSlice(pod.Object, "status", "containerStatuses")
		if found {
			for _, cs := range containerStatuses {
				csMap, ok := cs.(map[string]interface{})
				if !ok {
					continue
				}
				ready, found, _ := unstructured.NestedBool(csMap, "ready")
				if found && !ready {
					// Check for CrashLoopBackOff or other waiting states
					waitingState, found, _ := unstructured.NestedMap(csMap, "state", "waiting")
					if found {
						reason, _, _ := unstructured.NestedString(waitingState, "reason")
						if reason != "" {
							return "Degraded: " + reason
						}
						return "Degraded"
					}
					return "NotReady"
				}
			}
		}
		return "Running"
	}

	return phase
}
