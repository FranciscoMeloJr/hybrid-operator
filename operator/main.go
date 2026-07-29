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
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
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

// Helper function to read from Env Vars with sensible fallbacks
func getEnv(key, defaultValue string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return defaultValue
}

func main() {
	// Dynamically configure endpoint & targets via environment variables
	brainURL := getEnv("BRAIN_SERVICE_URL", "http://brain-service.hybrid-apps.svc.cluster.local:5005/api/telemetry")
	targetNamespace := getEnv("TARGET_NAMESPACE", "hybrid-apps")
	targetLabel := getEnv("TARGET_LABEL", "predictive-monitoring=true")

	// 1. Establish secure, in-cluster connection to the OpenShift API
	config, err := rest.InClusterConfig()
	if err != nil {
		log.Fatalf("Fatal error loading cluster configuration: %v", err)
	}
	clientset, err := kubernetes.NewForConfig(config)
	if err != nil {
		log.Fatalf("Fatal error creating clientset: %v", err)
	}

	log.Printf("[OPERATOR] Hybrid Intelligent Engine Loop Initialized connecting to %s. Actively listening...", brainURL)

	// 2. Continuous control loop
	// Simulated leak value for demonstration tracking
	simulatedMemoryTracker := 420.0

	for {
		// Discover active target pods matching our label selector
		pods, err := clientset.CoreV1().Pods(targetNamespace).List(context.TODO(), metav1.ListOptions{
			LabelSelector: targetLabel,
		})
		if err != nil {
			log.Printf("[OPERATOR ERROR] Failed to fetch target pods: %v", err)
			time.Sleep(10 * time.Second)
			continue
		}

		for _, pod := range pods.Items {
			if pod.Status.Phase != corev1.PodRunning {
				continue
			}

			// Simulating a runtime telemetry collection loop
			payload := TelemetryPayload{
				PodName:  pod.Name,
				MemoryMb: simulatedMemoryTracker,
			}

			log.Printf("[OPERATOR] Telemetry outbound -> Pod: %s | Telemetry: %.1fMB", pod.Name, payload.MemoryMb)

			// Send metric data out to the brain endpoint
			action, reason, clusterStatus := sendToExternalBrain(brainURL, payload)
			log.Printf("[OPERATOR] Brain Feedback Received -> Global Cluster State: %s | Assessment: %s", clusterStatus, action)

			// 3. Act on external intelligence decisions
			if action == "RESTART_PROACTIVE" {
				log.Printf("[MITIGATION ALARM] External brain flagged urgent issue: %s", reason)
				log.Printf("[MITIGATION ACTION] Initiating proactive restart on pod: %s", pod.Name)

				// Proactively evict the leaky pod. Kubernetes deployment handles the clean rollout replacement.
				err := clientset.CoreV1().Pods(targetNamespace).Delete(context.TODO(), pod.Name, metav1.DeleteOptions{})
				if err != nil {
					log.Printf("[OPERATOR ERROR] Failed to execute proactive eviction: %v", err)
				} else {
					log.Println("[OPERATOR SUCCESS] Proactive pod eviction command successfully acknowledged by cluster.")
					// Reset simulation baseline for the new rolling pod spin-up
					simulatedMemoryTracker = 420.0
				}
			}
		}

		// Slowly increment simulation over execution cycles to trigger the brain's linear progression curve
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

	// Create request timeout window
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Post(brainURL, "application/json", bytes.NewBuffer(jsonData))
	if err != nil {
		log.Printf("[OPERATOR] Communication failure reaching External Brain at %s: %v", brainURL, err)
		return "NONE", "", "UNKNOWN"
	}
	defer resp.Body.Close()

	var result BrainResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "NONE", "", "UNKNOWN"
	}

	return result.Action, result.Reason, result.GlobalClusterStatus
}