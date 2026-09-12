package main

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
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

var (
	cacheLock sync.RWMutex
	opCache   collector.ClusterGovernanceResponse
)

func inventoryHandler(w http.ResponseWriter, r *http.Request) {
	cacheLock.RLock()
	defer cacheLock.RUnlock()

	w.Header().Set("Content-Type", "application/json")
	if opCache.Operators == nil {
		opCache.Operators = []collector.OperatorInfo{}
	}
	if opCache.Anomalies == nil {
		opCache.Anomalies = []collector.AnomalyInfo{}
	}
	json.NewEncoder(w).Encode(map[string]interface{}{
		"ocp_current_version": opCache.OCPCurrentVersion,
		"ocp_next_version":    opCache.OCPNextVersion,
		"operators":           opCache.Operators,
		"total":               opCache.Total,
		"anomalies":           opCache.Anomalies,
		"olm_health":          opCache.OLMHealth,
		"upgrade_flow":        opCache.UpgradeFlow,
	})
}

func getEnv(key, defaultValue string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return defaultValue
}

// Quick Actions API Handlers
func handleApproveUpgrade(w http.ResponseWriter, r *http.Request, dynClient dynamic.Interface) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Namespace string `json:"namespace"`
		Name      string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request", http.StatusBadRequest)
		return
	}

	result := collector.ExecuteRemediationAction(context.Background(), dynClient, "REAPPROVE_INSTALLPLAN", req.Namespace, req.Name)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

func handleRestartPod(w http.ResponseWriter, r *http.Request, clientset *kubernetes.Clientset) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Namespace string `json:"namespace"`
		Name      string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request", http.StatusBadRequest)
		return
	}

	// Find operator pods by label
	pods, err := clientset.CoreV1().Pods(req.Namespace).List(context.Background(), metav1.ListOptions{
		LabelSelector: "operators.coreos.com/" + req.Name,
	})

	success := false
	message := "No pods found"

	if err == nil && len(pods.Items) > 0 {
		for _, pod := range pods.Items {
			err := clientset.CoreV1().Pods(req.Namespace).Delete(context.Background(), pod.Name, metav1.DeleteOptions{})
			if err == nil {
				success = true
				message = "Pod " + pod.Name + " deleted successfully"
				break
			}
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": success,
		"message": message,
	})
}

func handleDeleteSubscription(w http.ResponseWriter, r *http.Request, dynClient dynamic.Interface) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Namespace string `json:"namespace"`
		Name      string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request", http.StatusBadRequest)
		return
	}

	result := collector.ExecuteRemediationAction(context.Background(), dynClient, "PURGE_IDLE_SUBSCRIPTION", req.Namespace, req.Name)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

func handleGetSubscriptionYAML(w http.ResponseWriter, r *http.Request, dynClient dynamic.Interface) {
	namespace := r.URL.Query().Get("namespace")
	name := r.URL.Query().Get("name")

	if namespace == "" || name == "" {
		http.Error(w, "Missing namespace or name", http.StatusBadRequest)
		return
	}

	gvr := collector.SubscriptionsGVR()
	obj, err := dynClient.Resource(gvr).Namespace(namespace).Get(context.Background(), name, metav1.GetOptions{})

	if err != nil {
		http.Error(w, "Resource not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(obj.Object)
}

func handleGetCSVYAML(w http.ResponseWriter, r *http.Request, dynClient dynamic.Interface) {
	namespace := r.URL.Query().Get("namespace")
	name := r.URL.Query().Get("name")

	if namespace == "" || name == "" {
		http.Error(w, "Missing namespace or name", http.StatusBadRequest)
		return
	}

	gvr := collector.ClusterServiceVersionsGVR()
	obj, err := dynClient.Resource(gvr).Namespace(namespace).Get(context.Background(), name, metav1.GetOptions{})

	if err != nil {
		http.Error(w, "Resource not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(obj.Object)
}

// CVE API Handlers
func handleGetAllCVEs(w http.ResponseWriter, r *http.Request) {
	cacheLock.RLock()
	defer cacheLock.RUnlock()

	summary := make(map[string]map[string]int)

	for _, op := range opCache.Operators {
		if len(op.CVEs) > 0 {
			counts := map[string]int{"Critical": 0, "High": 0, "Medium": 0, "Low": 0}
			for _, cve := range op.CVEs {
				counts[cve.Severity]++
			}
			summary[op.Name] = counts
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(summary)
}

func handleGetOperatorCVEs(w http.ResponseWriter, r *http.Request) {
	operatorName := strings.TrimPrefix(r.URL.Path, "/api/v1/cves/")

	if operatorName == "" {
		http.Error(w, "Operator name required", http.StatusBadRequest)
		return
	}

	cacheLock.RLock()
	defer cacheLock.RUnlock()

	for _, op := range opCache.Operators {
		if op.Name == operatorName || op.Package == operatorName {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{
				"operator": op.Name,
				"package":  op.Package,
				"version":  op.Version,
				"cves":     op.CVEs,
				"count":    len(op.CVEs),
			})
			return
		}
	}

	http.Error(w, "Operator not found", http.StatusNotFound)
}

// Dependency Graph API Handlers
func handleGetDependencyGraph(w http.ResponseWriter, r *http.Request) {
	cacheLock.RLock()
	defer cacheLock.RUnlock()

	graphData := collector.BuildDependencyGraphData(opCache.Operators)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(graphData)
}

func handleGetImpactAnalysis(w http.ResponseWriter, r *http.Request) {
	operatorName := strings.TrimPrefix(r.URL.Path, "/api/v1/dependencies/impact/")

	if operatorName == "" {
		http.Error(w, "Operator name required", http.StatusBadRequest)
		return
	}

	cacheLock.RLock()
	defer cacheLock.RUnlock()

	impact := collector.AnalyzeOperatorImpact(opCache.Operators, operatorName)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(impact)
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

	// --- ROUTINE 0: Internal Inventory HTTP Server ---
	go func() {
		http.HandleFunc("/api/v1/inventory", inventoryHandler)
		http.HandleFunc("/api/v1/actions/approve", func(w http.ResponseWriter, r *http.Request) {
			handleApproveUpgrade(w, r, dynClient)
		})
		http.HandleFunc("/api/v1/actions/restart-pod", func(w http.ResponseWriter, r *http.Request) {
			handleRestartPod(w, r, clientset)
		})
		http.HandleFunc("/api/v1/actions/delete", func(w http.ResponseWriter, r *http.Request) {
			handleDeleteSubscription(w, r, dynClient)
		})
		http.HandleFunc("/api/v1/resources/subscription", func(w http.ResponseWriter, r *http.Request) {
			handleGetSubscriptionYAML(w, r, dynClient)
		})
		http.HandleFunc("/api/v1/resources/csv", func(w http.ResponseWriter, r *http.Request) {
			handleGetCSVYAML(w, r, dynClient)
		})
		http.HandleFunc("/api/v1/cves", handleGetAllCVEs)
		http.HandleFunc("/api/v1/cves/", handleGetOperatorCVEs)
		http.HandleFunc("/api/v1/dependencies/graph", handleGetDependencyGraph)
		http.HandleFunc("/api/v1/dependencies/impact/", handleGetImpactAnalysis)
		log.Println("[GO OPERATOR] Serving internal inventory API on 127.0.0.1:8080")
		if err := http.ListenAndServe("127.0.0.1:8080", nil); err != nil {
			log.Printf("[GO OPERATOR ERROR] Failed to start internal HTTP server: %v", err)
		}
	}()

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
	govResp, err := collector.GetClusterGovernance(context.Background(), dynClient)
	if err != nil {
		log.Printf("[GOVERNANCE ERROR] Failed to query OLM resources: %v", err)
		return
	}

	cacheLock.Lock()
	opCache = govResp
	cacheLock.Unlock()

	log.Printf("[GOVERNANCE] Discovered %d operator(s) on cluster:", len(govResp.Operators))
	for _, op := range govResp.Operators {
		log.Printf("  -> Sub: %-25s | Pkg: %-20s | NS: %-15s | Channel: %-10s | CSV: %-30s | Version: %-10s | Phase: %s", op.Name, op.Package, op.Namespace, op.Channel, op.InstalledCSV, op.Version, op.Phase)
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