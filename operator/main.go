package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
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

// AuditEvent records a single operator lifecycle action taken through this API.
type AuditEvent struct {
	Timestamp string `json:"timestamp"`
	Type      string `json:"type"`
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
	Detail    string `json:"detail"`
	Success   bool   `json:"success"`
}

// auditLog is an in-memory ring buffer of the most recent actions. It records
// real events as they are performed (approve / channel change / restart /
// delete); it is intentionally bounded and non-persistent (lost on restart).
const auditLogCapacity = 500

var (
	auditLock sync.Mutex
	auditLog  []AuditEvent
)

func recordAudit(eventType, namespace, name, detail string, success bool) {
	auditLock.Lock()
	defer auditLock.Unlock()
	auditLog = append(auditLog, AuditEvent{
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Type:      eventType,
		Namespace: namespace,
		Name:      name,
		Detail:    detail,
		Success:   success,
	})
	if len(auditLog) > auditLogCapacity {
		auditLog = auditLog[len(auditLog)-auditLogCapacity:]
	}
}

// handleGetAuditEvents returns recorded events newest-first, optionally filtered
// by ?namespace= and ?name=.
func handleGetAuditEvents(w http.ResponseWriter, r *http.Request) {
	nsFilter := r.URL.Query().Get("namespace")
	nameFilter := r.URL.Query().Get("name")

	auditLock.Lock()
	events := make([]AuditEvent, 0, len(auditLog))
	for i := len(auditLog) - 1; i >= 0; i-- {
		e := auditLog[i]
		if nsFilter != "" && e.Namespace != nsFilter {
			continue
		}
		if nameFilter != "" && e.Name != nameFilter {
			continue
		}
		events = append(events, e)
	}
	auditLock.Unlock()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"total":  len(events),
		"events": events,
	})
}

func inventoryHandler(w http.ResponseWriter, r *http.Request) {
	cacheLock.RLock()
	defer cacheLock.RUnlock()

	w.Header().Set("Content-Type", "application/json")
	// Read shared cache fields into locals; do not mutate opCache here. This
	// handler only holds a read lock, so concurrent requests would otherwise
	// race when writing the nil->empty-slice normalization.
	operators := opCache.Operators
	if operators == nil {
		operators = []collector.OperatorInfo{}
	}
	anomalies := opCache.Anomalies
	if anomalies == nil {
		anomalies = []collector.AnomalyInfo{}
	}
	json.NewEncoder(w).Encode(map[string]interface{}{
		"ocp_current_version": opCache.OCPCurrentVersion,
		"ocp_next_version":    opCache.OCPNextVersion,
		"operators":           operators,
		"total":               opCache.Total,
		"anomalies":           anomalies,
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
	recordAudit("approve", req.Namespace, req.Name, result.Message, result.Success)

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

	recordAudit("restart", req.Namespace, req.Name, message, success)

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
	recordAudit("delete", req.Namespace, req.Name, result.Message, result.Success)

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

// handleChangeChannel switches a Subscription's update channel (Feature 16).
// It merge-patches spec.channel, which makes OLM resolve the operator against
// the new channel (and, on a Manual approval strategy, generate a fresh
// InstallPlan for approval). Returns the patched channel on success.
func handleChangeChannel(w http.ResponseWriter, r *http.Request, dynClient dynamic.Interface) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Namespace string `json:"namespace"`
		Name      string `json:"name"`
		Channel   string `json:"channel"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request", http.StatusBadRequest)
		return
	}
	if req.Namespace == "" || req.Name == "" || req.Channel == "" {
		http.Error(w, "Missing namespace, name, or channel", http.StatusBadRequest)
		return
	}

	patch := []byte(fmt.Sprintf(`{"spec":{"channel":%q}}`, req.Channel))
	gvr := collector.SubscriptionsGVR()
	_, err := dynClient.Resource(gvr).Namespace(req.Namespace).Patch(
		context.Background(), req.Name, types.MergePatchType, patch, metav1.PatchOptions{},
	)

	w.Header().Set("Content-Type", "application/json")
	if err != nil {
		msg := fmt.Sprintf("Failed to switch channel: %v", err)
		recordAudit("channel-change", req.Namespace, req.Name, msg, false)
		w.WriteHeader(http.StatusBadGateway)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"success": false,
			"message": msg,
		})
		return
	}
	recordAudit("channel-change", req.Namespace, req.Name, fmt.Sprintf("channel -> %s", req.Channel), true)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"channel": req.Channel,
		"message": fmt.Sprintf("Subscription %s/%s switched to channel %q", req.Namespace, req.Name, req.Channel),
	})
}

// podMetricsGVR is the metrics.k8s.io resource exposing live pod CPU/memory
// usage (served by metrics-server / the OpenShift metrics stack).
var podMetricsGVR = schema.GroupVersionResource{
	Group:    "metrics.k8s.io",
	Version:  "v1beta1",
	Resource: "pods",
}

// handleGetControllerMetrics returns live resource usage for an operator's
// controller pods (Features 17 & 40). It finds the controller pods via the OLM
// label, reads their real CPU/memory usage from metrics.k8s.io, and aggregates
// per pod (milli-cores and MiB). Returns an availability flag so the UI can
// distinguish "metrics API unavailable" from "no usage".
func handleGetControllerMetrics(w http.ResponseWriter, r *http.Request, clientset *kubernetes.Clientset, dynClient dynamic.Interface) {
	namespace := r.URL.Query().Get("namespace")
	name := r.URL.Query().Get("name")
	if namespace == "" || name == "" {
		http.Error(w, "Missing namespace or name", http.StatusBadRequest)
		return
	}

	usage, err := gatherControllerUsage(context.Background(), clientset, dynClient, namespace, name)

	w.Header().Set("Content-Type", "application/json")
	if err != nil {
		w.WriteHeader(http.StatusBadGateway)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"metrics_available": false,
			"message":           err.Error(),
		})
		return
	}

	json.NewEncoder(w).Encode(map[string]interface{}{
		"operator":          name,
		"namespace":         namespace,
		"metrics_available": usage.Available,
		"pod_count":         len(usage.Pods),
		"total_cpu_milli":   usage.CPUMilli,
		"total_memory_mib":  usage.MemMi,
		"pods":              usage.Pods,
	})
}

// controllerUsage is the aggregated live usage of an operator's controller pods.
type controllerUsage struct {
	CPUMilli  int64
	MemMi     int64
	Pods      []map[string]interface{}
	Available bool
}

// gatherControllerUsage lists an operator's controller pods via the OLM label
// and sums their real CPU/memory usage from metrics.k8s.io. Available is false
// when the metrics API returned nothing usable (not installed / not yet scraped).
func gatherControllerUsage(ctx context.Context, clientset *kubernetes.Clientset, dynClient dynamic.Interface, namespace, name string) (controllerUsage, error) {
	pods, err := clientset.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{
		LabelSelector: "operators.coreos.com/" + name,
	})
	if err != nil {
		return controllerUsage{}, fmt.Errorf("failed to list controller pods: %w", err)
	}

	u := controllerUsage{Pods: make([]map[string]interface{}, 0, len(pods.Items)), Available: true}
	for _, pod := range pods.Items {
		pm, merr := dynClient.Resource(podMetricsGVR).Namespace(namespace).Get(ctx, pod.Name, metav1.GetOptions{})
		if merr != nil {
			u.Available = false
			continue
		}
		cpuMilli, memMi := sumPodUsage(pm.Object)
		u.CPUMilli += cpuMilli
		u.MemMi += memMi
		u.Pods = append(u.Pods, map[string]interface{}{
			"pod":        pod.Name,
			"cpu_milli":  cpuMilli,
			"memory_mib": memMi,
		})
	}
	u.Available = u.Available && len(u.Pods) > 0
	return u, nil
}

// handleGetOperatorCost returns an estimated infrastructure cost footprint for
// an operator's controller pods (Feature 10). It is a transparent estimate:
// real CPU/memory usage from metrics.k8s.io multiplied by configurable hourly
// rates (COST_CPU_CORE_HOUR / COST_MEM_GIB_HOUR). The rates used are returned in
// the response, and the payload is explicitly flagged as an estimate so the UI
// never presents these figures as billed amounts.
func handleGetOperatorCost(w http.ResponseWriter, r *http.Request, clientset *kubernetes.Clientset, dynClient dynamic.Interface) {
	namespace := r.URL.Query().Get("namespace")
	name := r.URL.Query().Get("name")
	if namespace == "" || name == "" {
		http.Error(w, "Missing namespace or name", http.StatusBadRequest)
		return
	}

	usage, err := gatherControllerUsage(context.Background(), clientset, dynClient, namespace, name)

	w.Header().Set("Content-Type", "application/json")
	if err != nil {
		w.WriteHeader(http.StatusBadGateway)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"metrics_available": false,
			"message":           err.Error(),
		})
		return
	}

	cpuRate := getEnvFloat("COST_CPU_CORE_HOUR", 0.031) // ~ on-demand vCPU/hr
	memRate := getEnvFloat("COST_MEM_GIB_HOUR", 0.004)  // ~ on-demand GiB/hr
	const hoursPerMonth = 730.0

	cpuCores := float64(usage.CPUMilli) / 1000.0
	memGiB := float64(usage.MemMi) / 1024.0
	hourly := cpuCores*cpuRate + memGiB*memRate

	json.NewEncoder(w).Encode(map[string]interface{}{
		"operator":          name,
		"namespace":         namespace,
		"estimate":          true,
		"metrics_available": usage.Available,
		"cpu_cores":         cpuCores,
		"memory_gib":        memGiB,
		"rates": map[string]interface{}{
			"cpu_core_hour": cpuRate,
			"mem_gib_hour":  memRate,
		},
		"hourly_cost":  hourly,
		"monthly_cost": hourly * hoursPerMonth,
		"currency":     "USD",
	})
}

// getEnvFloat reads a float env var, falling back to def when unset/invalid.
func getEnvFloat(key string, def float64) float64 {
	if v := os.Getenv(key); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return f
		}
	}
	return def
}

// sumPodUsage aggregates CPU (milli-cores) and memory (MiB) across all
// containers of a metrics.k8s.io PodMetrics object.
func sumPodUsage(podMetrics map[string]interface{}) (cpuMilli, memMi int64) {
	containers, found, _ := unstructured.NestedSlice(podMetrics, "containers")
	if !found {
		return 0, 0
	}
	for _, c := range containers {
		cMap, ok := c.(map[string]interface{})
		if !ok {
			continue
		}
		cpuStr, _, _ := unstructured.NestedString(cMap, "usage", "cpu")
		memStr, _, _ := unstructured.NestedString(cMap, "usage", "memory")
		if q, err := resource.ParseQuantity(cpuStr); err == nil {
			cpuMilli += q.MilliValue()
		}
		if q, err := resource.ParseQuantity(memStr); err == nil {
			memMi += q.Value() / (1024 * 1024)
		}
	}
	return cpuMilli, memMi
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

// handleGetCVESources reports which real CVE data sources are available in this
// cluster (the CVE-source spike), along with a summary of the collected image
// fleet it would scan. Read-only; used to choose a live integration.
func handleGetCVESources(w http.ResponseWriter, r *http.Request, dynClient dynamic.Interface) {
	cacheLock.RLock()
	var images []collector.ImageRef
	for _, op := range opCache.Operators {
		images = append(images, op.Images...)
	}
	cacheLock.RUnlock()

	report := collector.ProbeCVESources(r.Context(), dynClient, images)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(report)
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
		http.HandleFunc("/api/v1/actions/change-channel", func(w http.ResponseWriter, r *http.Request) {
			handleChangeChannel(w, r, dynClient)
		})
		http.HandleFunc("/api/v1/resources/subscription", func(w http.ResponseWriter, r *http.Request) {
			handleGetSubscriptionYAML(w, r, dynClient)
		})
		http.HandleFunc("/api/v1/resources/csv", func(w http.ResponseWriter, r *http.Request) {
			handleGetCSVYAML(w, r, dynClient)
		})
		http.HandleFunc("/api/v1/resources/metrics", func(w http.ResponseWriter, r *http.Request) {
			handleGetControllerMetrics(w, r, clientset, dynClient)
		})
		http.HandleFunc("/api/v1/resources/cost", func(w http.ResponseWriter, r *http.Request) {
			handleGetOperatorCost(w, r, clientset, dynClient)
		})
		http.HandleFunc("/api/v1/cves", handleGetAllCVEs)
		http.HandleFunc("/api/v1/cves/", handleGetOperatorCVEs)
		http.HandleFunc("/api/v1/security/cve-sources", func(w http.ResponseWriter, r *http.Request) {
			handleGetCVESources(w, r, dynClient)
		})
		http.HandleFunc("/api/v1/audit/events", handleGetAuditEvents)
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