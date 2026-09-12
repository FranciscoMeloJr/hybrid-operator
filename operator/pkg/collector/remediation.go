package collector

import (
	"context"
	"fmt"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
)

// TopologyNode represents a node in the predictive dependency graph
type TopologyNode struct {
	ID       string   `json:"id"`
	Type     string   `json:"type"` // "Operator", "CSV", "CRD", "CR", "Route"
	Name     string   `json:"name"`
	Status   string   `json:"status"`
	Children []string `json:"children"`
}

// RemediationResult holds outcomes of self-healing directives
type RemediationResult struct {
	Action    string `json:"action"`
	Target    string `json:"target"`
	Namespace string `json:"namespace"`
	Success   bool   `json:"success"`
	Message   string `json:"message"`
}

// BuildDependencyGraph generates a DAG connecting Subscription -> CSV -> CRDs -> CRs
func BuildDependencyGraph(op OperatorInfo) []TopologyNode {
	nodes := make([]TopologyNode, 0)

	opNodeID := fmt.Sprintf("sub-%s", op.Name)
	csvNodeID := fmt.Sprintf("csv-%s", op.InstalledCSV)

	crdIDs := make([]string, 0)
	for _, crd := range op.CRDs {
		crdID := fmt.Sprintf("crd-%s", crd.Kind)
		crdIDs = append(crdIDs, crdID)

		nodes = append(nodes, TopologyNode{
			ID:       crdID,
			Type:     "CRD",
			Name:     crd.Kind,
			Status:   fmt.Sprintf("%d Active CRs", crd.ActiveCount),
			Children: []string{},
		})
	}

	nodes = append(nodes, TopologyNode{
		ID:       csvNodeID,
		Type:     "CSV",
		Name:     op.InstalledCSV,
		Status:   op.Phase,
		Children: crdIDs,
	})

	nodes = append(nodes, TopologyNode{
		ID:       opNodeID,
		Type:     "Subscription",
		Name:     op.Name,
		Status:   op.Phase,
		Children: []string{csvNodeID},
	})

	return nodes
}

// EstimateMaintenanceWindow calculates downtime and rollout durations
func EstimateMaintenanceWindow(op OperatorInfo, workerNodeCount int) string {
	if !op.CanUpgrade {
		return "0m (Aligned)"
	}

	baseDurationMinutes := 2 // CSV reconciliation baseline
	if op.UpgradeType == "MAJOR" {
		baseDurationMinutes = 5
	} else if op.UpgradeType == "MINOR" {
		baseDurationMinutes = 3
	}

	// Factor active CRs and worker node count
	crImpactMinutes := (op.ActiveCRs * 15) / 60 // 15s rollout buffer per active CR
	nodeFactor := workerNodeCount * 1           // 1 min per node rolling restart

	totalMinutes := baseDurationMinutes + crImpactMinutes + nodeFactor
	return fmt.Sprintf("~%dm (Est. Downtime)", totalMinutes)
}

// CalculateSecurityRiskScore computes proactive risk metrics (0 to 100)
func CalculateSecurityRiskScore(op OperatorInfo) int {
	score := 0
	if op.UpgradeType == "MAJOR" {
		score += 40
	}
	if op.CRDDiff.HasBreakingImpact {
		score += 30
	}
	if len(op.ExposedRoutes) > 0 {
		score += 15
	}
	if op.Phase == "Failed" {
		score += 15
	}
	return score
}

// CalculateHealthScore computes an overall health score (0-100) for an operator
// Higher score = healthier. Factors: phase status, upgrade readiness, activity, stability
func CalculateHealthScore(op OperatorInfo) int {
	score := 100 // Start with perfect score

	// Phase Status (40 points max deduction)
	switch op.Phase {
	case "Failed", "UpgradeFailed", "InstallPlanFailed":
		score -= 40
	case "Unknown", "Pending":
		score -= 25
	case "UpgradePending":
		score -= 10
	case "Succeeded":
		// No deduction - healthy
	default:
		score -= 5 // Minor deduction for unexpected phase
	}

	// Upgrade Status (20 points max deduction)
	if op.CanUpgrade {
		if op.UpgradeType == "MAJOR" {
			score -= 15 // Major upgrades = higher risk
		} else if op.UpgradeType == "MINOR" {
			score -= 5 // Minor upgrades = lower risk
		}
	}

	// CRD Breaking Changes (15 points deduction)
	if op.CRDDiff.HasBreakingImpact {
		score -= 15
	}

	// Activity & Usefulness (10 points deduction)
	if op.IsIdle && op.ActiveCRs == 0 {
		score -= 10 // Idle with no CRs = wasting resources
	}

	// External Exposure Risk (10 points deduction)
	if len(op.ExposedRoutes) > 2 {
		score -= 10 // Many external routes = attack surface
	} else if len(op.ExposedRoutes) > 0 {
		score -= 5
	}

	// OCP Compatibility (5 points deduction)
	if op.OCPBlocker {
		score -= 5
	}

	// Ensure score is within 0-100 range
	if score < 0 {
		score = 0
	}
	if score > 100 {
		score = 100
	}

	return score
}

// ExecuteRemediationAction executes autonomous self-healing fix directives
func ExecuteRemediationAction(ctx context.Context, dynClient dynamic.Interface, action string, namespace string, target string) RemediationResult {
	result := RemediationResult{
		Action:    action,
		Target:    target,
		Namespace: namespace,
		Success:   false,
	}

	switch action {
	case "REAPPROVE_INSTALLPLAN":
		// Clear stuck OLM InstallPlans by forcing approval
		installPlanGVR := schema.GroupVersionResource{
			Group:    "operators.coreos.com",
			Version:  "v1alpha1",
			Resource: "installplans",
		}
		ipList, err := dynClient.Resource(installPlanGVR).Namespace(namespace).List(ctx, metav1.ListOptions{})
		if err != nil {
			result.Message = fmt.Sprintf("Failed to query InstallPlans: %v", err)
			return result
		}

		for _, ip := range ipList.Items {
			approved, _, _ := unstructured.NestedBool(ip.Object, "spec", "approved")
			if !approved {
				unstructured.SetNestedField(ip.Object, true, "spec", "approved")
				_, errUpdate := dynClient.Resource(installPlanGVR).Namespace(namespace).Update(ctx, &ip, metav1.UpdateOptions{})
				if errUpdate == nil {
					result.Success = true
					result.Message = fmt.Sprintf("Successfully approved stuck InstallPlan %s", ip.GetName())
					return result
				}
			}
		}
		result.Message = "No unapproved InstallPlans required intervention."

	case "PURGE_IDLE_SUBSCRIPTION":
		// Auto-reclaim idle subscriptions (0 active CRs)
		subGVR := schema.GroupVersionResource{
			Group:    "operators.coreos.com",
			Version:  "v1alpha1",
			Resource: "subscriptions",
		}
		err := dynClient.Resource(subGVR).Namespace(namespace).Delete(ctx, target, metav1.DeleteOptions{})
		if err != nil {
			result.Message = fmt.Sprintf("Failed to remove idle subscription: %v", err)
			return result
		}
		result.Success = true
		result.Message = fmt.Sprintf("Successfully purged idle subscription %s to reclaim cluster compute resources.", target)

	default:
		result.Message = fmt.Sprintf("Unknown remediation directive: %s", action)
	}

	return result
}