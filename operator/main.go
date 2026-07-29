package main

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"

	"hybrid-operator/pkg/collector"
)

type TelemetryPayload struct {
	PodName  string  `json:"pod_name"`
	MemoryMb float64 `json:"memory_mb"`
}

type BrainResponse struct {
	Action              string `json:"action"`
	Reason              string `json:"reason"`
	GlobalClusterStatus string `json:"global_cluster_status"`
}

func getEnv(key, defaultValue string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return defaultValue
}

func main() {
	brainURL := getEnv("BRAIN_SERVICE_URL", "http://brain-service.hybrid-apps.svc.cluster.local:5005/api/telemetry")
	targetNamespace := getEnv("TARGET_NAMESPACE", "hybrid-apps")
	targetLabel := getEnv("TARGET_LABEL", "predictive-monitoring=true")

	// Establish in-cluster config
	config, err := rest.InClusterConfig()
	if err != nil {
		log.Fatalf("Fatal error loading cluster configuration: %v", err)
	}

	// Standard Kubernetes client
	clientset, err := kubernetes.NewForConfig(config)
	if err != nil {
		log.Fatalf("Fatal error creating clientset: %v", err)
	}

	// Dynamic client for OLM CRD querying
	dynClient, err := dynamic.NewForConfig(config)
	if err != nil {
		log.Fatalf("Fatal error creating dynamic client: %v", err)
	}

	log.Printf("[OPERATOR] Hybrid Intelligent Engine Initialized.")
	log.Printf("[OPERATOR] Brain Endpoint: %s | Target NS: %s | Selector: %s", brainURL, targetNamespace, targetLabel)

	// --- ROUTINE 1: OLM Operator Inventory Governance ---
	go runGovernanceLoop(dynClient)

	// --- ROUTINE 2: Proactive Telemetry & Mitigation Loop ---
	runTelemetryLoop(clientset, brainURL, targetNamespace, targetLabel)
}

func runGovernanceLoop(dynClient dynamic.Interface) {
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()

	// Run initial collection immediately
	collectOperators(dynClient)

	for range ticker.C {
		collectOperators(dynClient)
	}
}

func collectOperators(dynClient dynamic.Interface) {
	log.Println("[GOVERNANCE] Running OLM operator inventory sweep...")
	ops, err := collector.TrackOperators(context.Background(), dynClient)
	if err != nil {
		log.Printf("[GOVERNANCE ERROR] Failed to query OLM resources: %v", err)
		return
	}

	log.Printf("[GOVERNANCE] Discovered %d operator(s) on cluster:", len(ops))
	for _, op := range ops {
		log.Printf("  -> Sub: %-25s | Pkg: %-20s | NS: %-15s | Channel: %-10s | CSV: %-30s | Version: %-10s | Phase: %s",
			op.Name, op.Package, op.Namespace, op.Channel, op.InstalledCSV, op.Version, op.Phase)
	}
}

func runTelemetryLoop(clientset *kubernetes.Clientset, brainURL, namespace, labelSelector string) {
	simulatedMemoryTracker := 420.0

	for {
		pods, err := clientset.CoreV1().Pods(namespace).List(context.TODO(), metav1.ListOptions{
			LabelSelector: labelSelector,
		})
		if err != nil {
			log.Printf("[TELEMETRY ERROR] Failed to list pods in %s: %v", namespace, err)
			time.Sleep(10 * time.Second)
			continue
		}

		for _, pod := range pods.Items {
			if pod.Status.Phase != corev1.PodRunning {
				continue
			}

			payload := TelemetryPayload{
				PodName:  pod.Name,
				MemoryMb: simulatedMemoryTracker,
			}

			log.Printf("[TELEMETRY] Outbound -> Pod: %s | Usage: %.1fMB", pod.Name, payload.MemoryMb)

			action, reason, clusterStatus := sendToExternalBrain(brainURL, payload)
			log.Printf("[TELEMETRY] Brain Feedback -> State: %s | Action: %s", clusterStatus, action)

			if action == "RESTART_PROACTIVE" {
				log.Printf("[MITIGATION ALARM] Brain flagged pod: %s (Reason: %s)", pod.Name, reason)
				log.Printf("[MITIGATION ACTION] Evicting pod %s...", pod.Name)

				err := clientset.CoreV1().Pods(namespace).Delete(context.TODO(), pod.Name, metav1.DeleteOptions{})
				if err != nil {
					log.Printf("[MITIGATION ERROR] Failed to evict pod: %v", err)
				} else {
					log.Println("[MITIGATION SUCCESS] Pod successfully evicted.")
					simulatedMemoryTracker = 420.0
				}
			}
		}

		if len(pods.Items) > 0 {
			simulatedMemoryTracker += 35.0
		}

		time.Sleep(10 * time.Second)
	}
}

func sendToExternalBrain(brainURL string, payload TelemetryPayload) (string, string, string) {
	jsonData, err := json.Marshal(payload)
	if err != nil {
		return "NONE", "", "UNKNOWN"
	}

	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Post(brainURL, "application/json", bytes.NewBuffer(jsonData))
	if err != nil {
		log.Printf("[TELEMETRY ERROR] Cannot reach Brain at %s: %v", brainURL, err)
		return "NONE", "", "UNKNOWN"
	}
	defer resp.Body.Close()

	var result BrainResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "NONE", "", "UNKNOWN"
	}

	return result.Action, result.Reason, result.GlobalClusterStatus
}