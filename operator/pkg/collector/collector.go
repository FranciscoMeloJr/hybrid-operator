package collector

import (
    "context"
    "fmt"
    "log"
    "regexp"
    "strconv"
    "strings"

    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
    "k8s.io/apimachinery/pkg/runtime/schema"
    "k8s.io/client-go/dynamic"
)

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
    packageManifestGVR = schema.GroupVersionResource{
        Group:    "packages.operators.coreos.com",
        Version:  "v1",
        Resource: "packagemanifests",
    }
    clusterVersionGVR = schema.GroupVersionResource{
        Group:    "config.openshift.io",
        Version:  "v1",
        Resource: "clusterversions",
    }
    routeGVR = schema.GroupVersionResource{
        Group:    "route.openshift.io",
        Version:  "v1",
        Resource: "routes",
    }
    serviceAccountGVR = schema.GroupVersionResource{
        Group:    "",
        Version:  "v1",
        Resource: "serviceaccounts",
    }
    deploymentGVR = schema.GroupVersionResource{
        Group:    "apps",
        Version:  "v1",
        Resource: "deployments",
    }
    installPlanGVR = schema.GroupVersionResource{
        Group:    "operators.coreos.com",
        Version:  "v1alpha1",
        Resource: "installplans",
    }
    catalogSourceGVR = schema.GroupVersionResource{
        Group:    "operators.coreos.com",
        Version:  "v1alpha1",
        Resource: "catalogsources",
    }
)

type CRDInfo struct {
    Name        string `json:"name"`
    Kind        string `json:"kind"`
    Version     string `json:"version"`
    DisplayName string `json:"displayName"`
    Description string `json:"description"`
    ActiveCount int    `json:"active_count"`
}

type OperatorComponent struct {
    Kind      string `json:"kind"`
    Name      string `json:"name"`
    Namespace string `json:"namespace"`
    Status    string `json:"status"`
}

type OperatorInfo struct {
    Name             string              `json:"name"`
    Package          string              `json:"package"`
    Namespace        string              `json:"namespace"`
    Channel          string              `json:"channel"`
    InstalledCSV     string              `json:"installedCSV"`
    Version          string              `json:"version"`
    Phase            string              `json:"phase"`
    TargetVersion    string              `json:"target_version"`
    TargetCSV        string              `json:"target_csv"`
    CanUpgrade       bool                `json:"can_upgrade"`
    UpgradeType      string              `json:"upgrade_type"`
    CRDs             []CRDInfo           `json:"crds"`
    OCPBlocker       bool                `json:"ocp_blocker"`
    OCPBlockerReason string              `json:"ocp_blocker_reason"`
    OCPNextSupported bool                `json:"ocp_next_supported"`
    IsIdle           bool                `json:"is_idle"`
    ActiveCRs        int                 `json:"active_crs"`
    CRDDiff          CRDDiffResult       `json:"crd_diff"`
    ExposedRoutes    []string            `json:"exposed_routes"`
    ApprovalStrategy string              `json:"approval_strategy"`
    CatalogSource    string              `json:"catalog_source"`
    ServiceAccounts  []string            `json:"service_accounts"`
    Components       []OperatorComponent `json:"components"`
    TopologyGraph    []TopologyNode      `json:"topology_graph"`
    EstDowntime      string              `json:"est_downtime"`
    RiskScore        int                 `json:"risk_score"`
    HealthScore      int                 `json:"health_score"`
    CVEs             []CVEInfo           `json:"cves"`
    CVECount         int                 `json:"cve_count"`
}

type CVEInfo struct {
    ID            string   `json:"id"`
    Severity      string   `json:"severity"`
    Description   string   `json:"description"`
    FixedVersion  string   `json:"fixed_version"`
    PublishedDate string   `json:"published_date"`
    CVSS          float64  `json:"cvss_score"`
}

type AnomalyInfo struct {
    Type        string `json:"type"`
    Severity    string `json:"severity"`
    Resource    string `json:"resource"`
    Namespace   string `json:"namespace"`
    Description string `json:"description"`
    Action      string `json:"action"`
}

type OLMHealthStatus struct {
    InstallPlanCount       int    `json:"installplan_count"`
    InstallPlanPending     int    `json:"installplan_pending"`
    InstallPlanFailed      int    `json:"installplan_failed"`
    CatalogSourceCount     int    `json:"catalogsource_count"`
    CatalogSourceReady     int    `json:"catalogsource_ready"`
    CatalogSourceFailed    int    `json:"catalogsource_failed"`
    OLMOperatorStatus      string `json:"olm_operator_status"`
    CatalogOperatorStatus  string `json:"catalog_operator_status"`
}

type SankeyNode struct {
    ID       string `json:"id"`
    Label    string `json:"label"`
    Category string `json:"category"`
}

type SankeyLink struct {
    Source string   `json:"source"`
    Target string   `json:"target"`
    Value  int      `json:"value"`
    Type   string   `json:"type"`
    Operators []string `json:"operators"`
}

type SankeyData struct {
    Nodes []SankeyNode `json:"nodes"`
    Links []SankeyLink `json:"links"`
}

type ClusterGovernanceResponse struct {
    OCPCurrentVersion string         `json:"ocp_current_version"`
    OCPNextVersion    string         `json:"ocp_next_version"`
    Operators         []OperatorInfo `json:"operators"`
    Total             int            `json:"total"`
    Anomalies         []AnomalyInfo  `json:"anomalies"`
    OLMHealth         OLMHealthStatus `json:"olm_health"`
    UpgradeFlow       SankeyData     `json:"upgrade_flow"`
}

func parseSemver(versionStr string) [3]int {
    re := regexp.MustCompile(`(\d+)\.(\d+)\.(\d+)`)
    matches := re.FindStringSubmatch(versionStr)
    if len(matches) == 4 {
        major, _ := strconv.Atoi(matches[1])
        minor, _ := strconv.Atoi(matches[2])
        patch, _ := strconv.Atoi(matches[3])
        return [3]int{major, minor, patch}
    }
    return [3]int{0, 0, 0}
}

func isVersionGreater(target, current [3]int) bool {
    if target[0] != current[0] {
        return target[0] > current[0]
    }
    if target[1] != current[1] {
        return target[1] > current[1]
    }
    return target[2] > current[2]
}

func getOCPVersions(ctx context.Context, dynClient dynamic.Interface) (string, string) {
    current := "4.20.16"

    cv, err := dynClient.Resource(clusterVersionGVR).Get(ctx, "version", metav1.GetOptions{})
    if err == nil {
        desiredVer, found, _ := unstructured.NestedString(cv.Object, "status", "desired", "version")
        if found && desiredVer != "" {
            current = desiredVer
        } else {
            history, found, _ := unstructured.NestedSlice(cv.Object, "status", "history")
            if found && len(history) > 0 {
                if item, ok := history[0].(map[string]interface{}); ok {
                    if ver, ok := item["version"].(string); ok && ver != "" {
                        current = ver
                    }
                }
            }
        }
    }

    parts := strings.Split(current, ".")
    next := "4.21.0"
    if len(parts) >= 2 {
        major, _ := strconv.Atoi(parts[0])
        minor, _ := strconv.Atoi(parts[1])
        next = fmt.Sprintf("%d.%d.0", major, minor+1)
    }

    return current, next
}

func TrackOperators(ctx context.Context, dynClient dynamic.Interface) ([]OperatorInfo, error) {
    resp, err := GetClusterGovernance(ctx, dynClient)
    if err != nil {
        return nil, err
    }
    return resp.Operators, nil
}

func GetClusterGovernance(ctx context.Context, dynClient dynamic.Interface) (ClusterGovernanceResponse, error) {
    ocpCurrent, ocpNext := getOCPVersions(ctx, dynClient)

    csvMap := make(map[string]struct {
        Version string
        Phase   string
        CRDs    []CRDInfo
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

            var crdList []CRDInfo
            ownedCRDs, found, _ := unstructured.NestedSlice(csv.Object, "spec", "customresourcedefinitions", "owned")
            if found {
                for _, item := range ownedCRDs {
                    crdMap, ok := item.(map[string]interface{})
                    if !ok {
                        continue
                    }
                    crdName, _, _ := unstructured.NestedString(crdMap, "name")
                    kind, _, _ := unstructured.NestedString(crdMap, "kind")
                    ver, _, _ := unstructured.NestedString(crdMap, "version")
                    dispName, _, _ := unstructured.NestedString(crdMap, "displayName")
                    desc, _, _ := unstructured.NestedString(crdMap, "description")

                    crdList = append(crdList, CRDInfo{
                        Name:        crdName,
                        Kind:        kind,
                        Version:     ver,
                        DisplayName: dispName,
                        Description: desc,
                        ActiveCount: 0,
                    })
                }
            }

            key := fmt.Sprintf("%s/%s", ns, name)
            csvMap[key] = struct {
                Version string
                Phase   string
                CRDs    []CRDInfo
            }{
                Version: version,
                Phase:   phase,
                CRDs:    crdList,
            }
        }
    }

    subs, err := dynClient.Resource(subscriptionGVR).List(ctx, metav1.ListOptions{})
    if err != nil {
        return ClusterGovernanceResponse{}, fmt.Errorf("failed to list subscriptions: %w", err)
    }

    ips, _ := dynClient.Resource(installPlanGVR).List(ctx, metav1.ListOptions{})
    catsrcs, _ := dynClient.Resource(catalogSourceGVR).List(ctx, metav1.ListOptions{})

    var results []OperatorInfo

    for _, sub := range subs.Items {
        name := sub.GetName()
        namespace := sub.GetNamespace()

        packageName, _, _ := unstructured.NestedString(sub.Object, "spec", "name")
        if packageName == "" {
            packageName, _, _ = unstructured.NestedString(sub.Object, "spec", "packageName")
        }
        if packageName == "" {
            packageName, _, _ = unstructured.NestedString(sub.Object, "spec", "package")
        }
        if packageName == "" {
            packageName = name
        }

        channel, _, _ := unstructured.NestedString(sub.Object, "spec", "channel")
        startingCSV, _, _ := unstructured.NestedString(sub.Object, "spec", "startingCSV")

        approvalStrategy, _, _ := unstructured.NestedString(sub.Object, "spec", "installPlanApproval")
        if approvalStrategy == "" {
            approvalStrategy = "Automatic"
        }

        catalogSource, _, _ := unstructured.NestedString(sub.Object, "spec", "source")
        if catalogSource == "" {
            catalogSource = "redhat-operators"
        }

        installedCSV, _, _ := unstructured.NestedString(sub.Object, "status", "installedCSV")
        if installedCSV == "" {
            installedCSV = startingCSV
        }

        subState, _, _ := unstructured.NestedString(sub.Object, "status", "state")

        op := OperatorInfo{
            Name:             name,
            Package:          packageName,
            Namespace:        namespace,
            Channel:          channel,
            InstalledCSV:     installedCSV,
            Phase:            "Unknown",
            TargetVersion:    "0.0.0",
            TargetCSV:        installedCSV,
            CanUpgrade:       false,
            UpgradeType:      "NONE",
            CRDs:             []CRDInfo{},
            OCPBlocker:       false,
            OCPBlockerReason: "None",
            OCPNextSupported: true,
            IsIdle:           false,
            ActiveCRs:        0,
            ApprovalStrategy: approvalStrategy,
            CatalogSource:    catalogSource,
            ExposedRoutes:    []string{},
            ServiceAccounts:  []string{},
            Components:       []OperatorComponent{},
            TopologyGraph:    []TopologyNode{},
            EstDowntime:      "0m",
            RiskScore:        0,
        }

        if installedCSV != "" {
            csvKey := fmt.Sprintf("%s/%s", namespace, installedCSV)
            if csvData, exists := csvMap[csvKey]; exists {
                op.Version = csvData.Version
                op.Phase = csvData.Phase
                op.CRDs = csvData.CRDs
            }
        }

        if op.Phase == "Unknown" || op.Phase == "" {
            if subState != "" {
                op.Phase = subState
            }
            if op.Phase == "UpgradeFailed" || op.Phase == "InstallPlanFailed" || op.Phase == "Unknown" {
                op.Phase = "Failed"
            }
        }

        // Calculate total active Custom Resource instances across all owned CRDs
        // Also collect namespaces where CRs are deployed for route scanning
        activeCRCount := 0
        crNamespaces := make(map[string]bool)
        crNamespaces[namespace] = true // Always include operator's own namespace

        for i := range op.CRDs {
            // CRD names are formatted as <plural>.<group>
            parts := strings.SplitN(op.CRDs[i].Name, ".", 2)
            if len(parts) == 2 {
                gvr := schema.GroupVersionResource{
                    Group:    parts[1],
                    Version:  op.CRDs[i].Version,
                    Resource: parts[0],
                }
                crs, err := dynClient.Resource(gvr).List(ctx, metav1.ListOptions{})
                if err == nil {
                    op.CRDs[i].ActiveCount = len(crs.Items)
                    activeCRCount += len(crs.Items)

                    // Collect namespaces where CRs exist
                    for _, cr := range crs.Items {
                        crNS := cr.GetNamespace()
                        if crNS != "" {
                            crNamespaces[crNS] = true
                        }
                    }
                }
            }
        }
        op.ActiveCRs = activeCRCount

        // Mark operator as idle only if it provides CRDs but none are instantiated
        if len(op.CRDs) > 0 && activeCRCount == 0 {
            op.IsIdle = true
        }

        // Scan OpenShift Routes in all namespaces where this operator has CRs deployed
        routeHostMap := make(map[string]bool) // Deduplication by host

        for ns := range crNamespaces {
            routes, errRoute := dynClient.Resource(routeGVR).Namespace(ns).List(ctx, metav1.ListOptions{})
            if errRoute == nil {
                for _, r := range routes.Items {
                    host, foundHost, _ := unstructured.NestedString(r.Object, "spec", "host")
                    if foundHost && host != "" {
                        routeName := r.GetName()
                        routeNS := r.GetNamespace()

                        // Deduplicate by host to avoid counting the same route multiple times
                        if !routeHostMap[host] {
                            routeHostMap[host] = true
                            routeIdentifier := fmt.Sprintf("%s (ns: %s)", host, routeNS)
                            op.ExposedRoutes = append(op.ExposedRoutes, routeIdentifier)
                            op.Components = append(op.Components, OperatorComponent{
                                Kind:      "Route",
                                Name:      routeName,
                                Namespace: routeNS,
                                Status:    fmt.Sprintf("Host: %s", host),
                            })
                        }
                    }
                }
            }
        }

        // Scan ServiceAccounts in operator namespace
        sas, errSA := dynClient.Resource(serviceAccountGVR).Namespace(namespace).List(ctx, metav1.ListOptions{})
        if errSA == nil {
            for _, sa := range sas.Items {
                op.ServiceAccounts = append(op.ServiceAccounts, sa.GetName())
                op.Components = append(op.Components, OperatorComponent{
                    Kind:      "ServiceAccount",
                    Name:      sa.GetName(),
                    Namespace: namespace,
                    Status:    "Active",
                })
            }
        }

        // Scan Deployments in operator namespace
        deps, errDep := dynClient.Resource(deploymentGVR).Namespace(namespace).List(ctx, metav1.ListOptions{})
        if errDep == nil {
            for _, dep := range deps.Items {
                availReplicas, _, _ := unstructured.NestedInt64(dep.Object, "status", "availableReplicas")
                replicas, _, _ := unstructured.NestedInt64(dep.Object, "status", "replicas")
                op.Components = append(op.Components, OperatorComponent{
                    Kind:      "Deployment",
                    Name:      dep.GetName(),
                    Namespace: namespace,
                    Status:    fmt.Sprintf("%d/%d Replicas Available", availReplicas, replicas),
                })
            }
        }

        if op.Version == "" {
            installedVer := parseSemver(installedCSV)
            op.Version = fmt.Sprintf("%d.%d.%d", installedVer[0], installedVer[1], installedVer[2])
        }
        op.TargetVersion = op.Version

        if op.Phase == "Failed" {
            op.OCPBlocker = true
            op.OCPNextSupported = false
            op.OCPBlockerReason = "Operator in Failed state blocks OCP payload reconciliation"
        }

        if packageName != "" {
            pm, err := dynClient.Resource(packageManifestGVR).Namespace(namespace).Get(ctx, packageName, metav1.GetOptions{})
            if err != nil {
                pms, errList := dynClient.Resource(packageManifestGVR).List(ctx, metav1.ListOptions{})
                if errList == nil {
                    for _, item := range pms.Items {
                        if item.GetName() == packageName {
                            pm = &item
                            break
                        }
                    }
                }
            }

            if pm != nil {
                channels, found, _ := unstructured.NestedSlice(pm.Object, "status", "channels")
                if found {
                    for _, ch := range channels {
                        chMap, ok := ch.(map[string]interface{})
                        if !ok {
                            continue
                        }
                        chName, _, _ := unstructured.NestedString(chMap, "name")
                        if chName == channel {
                            targetCSV, _, _ := unstructured.NestedString(chMap, "currentCSVDesc", "name")
                            targetRawVer, _, _ := unstructured.NestedString(chMap, "currentCSVDesc", "version")

                            var targetCSVUnstructured *unstructured.Unstructured
                            if currentCSVDesc, foundDesc, _ := unstructured.NestedMap(chMap, "currentCSVDesc"); foundDesc {
                                targetCSVUnstructured = &unstructured.Unstructured{Object: currentCSVDesc}
                            }

                            if targetRawVer == "" {
                                targetRawVer = targetCSV
                            }

                            currVer := parseSemver(op.Version)
                            targVer := parseSemver(targetRawVer)

                            op.TargetCSV = targetCSV
                            op.TargetVersion = fmt.Sprintf("%d.%d.%d", targVer[0], targVer[1], targVer[2])

                            if isVersionGreater(targVer, currVer) {
                                op.CanUpgrade = true
                                if targVer[0] > currVer[0] {
                                    op.UpgradeType = "MAJOR"
                                    op.OCPBlocker = true
                                    op.OCPBlockerReason = fmt.Sprintf("Pending MAJOR operator upgrade (%s -> %s) may introduce schema breaking changes on OCP %s", op.Version, op.TargetVersion, ocpNext)
                                    op.CRDDiff = AnalyzeCRDBreakingChanges(ctx, dynClient, namespace, op.CRDs, targetCSVUnstructured)
                                } else if targVer[1] > currVer[1] {
                                    op.UpgradeType = "MINOR"
                                } else {
                                    op.UpgradeType = "PATCH"
                                }
                            }
                            break
                        }
                    }
                }
            }
        }

        // Inject Predictive Intelligence & Topology Graph
        op.TopologyGraph = BuildDependencyGraph(op)
        op.EstDowntime = EstimateMaintenanceWindow(op, 3) // Assuming 3 worker node baseline
        op.RiskScore = CalculateSecurityRiskScore(op)
        op.HealthScore = CalculateHealthScore(op)

        results = append(results, op)
    }

    anomalies := DetectAnomalies(subs, ips, csvs, catsrcs)
    olmHealth := CollectOLMHealthStatus(ctx, dynClient, ips, catsrcs)
    upgradeFlow := BuildUpgradeFlowData(results)

    return ClusterGovernanceResponse{
        OCPCurrentVersion: ocpCurrent,
        OCPNextVersion:    ocpNext,
        Operators:         results,
        Total:             len(results),
        Anomalies:         anomalies,
        OLMHealth:         olmHealth,
        UpgradeFlow:       upgradeFlow,
    }, nil
}

func DetectAnomalies(
    subs *unstructured.UnstructuredList,
    ips *unstructured.UnstructuredList,
    csvs *unstructured.UnstructuredList,
    catsrcs *unstructured.UnstructuredList,
) []AnomalyInfo {
    var anomalies []AnomalyInfo

    subMap := make(map[string]bool)

    // 1. Dependency Deadlocks (Subscriptions failing resolution)
    if subs != nil {
        for _, sub := range subs.Items {
            subKey := sub.GetNamespace() + "/" + sub.GetName()
            subMap[subKey] = true

            status, ok := sub.Object["status"].(map[string]interface{})
            if ok {
                conditions, hasCond := status["conditions"].([]interface{})
                if hasCond {
                    for _, c := range conditions {
                        cond, isMap := c.(map[string]interface{})
                        if isMap && cond["reason"] == "ResolutionFailed" && cond["status"] == "True" {
                            msg, _ := cond["message"].(string)
                            anomalies = append(anomalies, AnomalyInfo{
                                Type:        "Dependency Deadlock",
                                Severity:    "CRITICAL",
                                Resource:    sub.GetName(),
                                Namespace:   sub.GetNamespace(),
                                Description: "Subscription cannot resolve dependencies: " + msg,
                                Action:      "VERIFY_CATALOG_SOURCES",
                            })
                        }
                    }
                }
            }
        }
    }

    // 2. InstallPlan Step Conflicts
    if ips != nil {
        for _, ip := range ips.Items {
            status, ok := ip.Object["status"].(map[string]interface{})
            if ok {
                phase, _ := status["phase"].(string)
                if phase == "Failed" {
                    conditions, hasCond := status["conditions"].([]interface{})
                    if hasCond {
                        for _, c := range conditions {
                            cond, isMap := c.(map[string]interface{})
                            if isMap && cond["type"] == "Installed" && cond["status"] == "False" && cond["reason"] == "InstallCheckFailed" {
                                anomalies = append(anomalies, AnomalyInfo{
                                    Type:        "InstallPlan Conflict",
                                    Severity:    "CRITICAL",
                                    Resource:    ip.GetName(),
                                    Namespace:   ip.GetNamespace(),
                                    Description: "InstallPlan failed due to ownership conflicts or step failure.",
                                    Action:      "DELETE_CONFLICTING_RESOURCE",
                                })
                            }
                        }
                    }
                }
            }
        }
    }

    // 3. Webhook Timeouts, API Deprecations, and Zombie CSVs
    if csvs != nil {
        for _, csv := range csvs.Items {
            name := csv.GetName()
            ns := csv.GetNamespace()

            // Skip global OLM namespaces for zombie check
            if ns != "openshift-operator-lifecycle-manager" && ns != "openshift-marketplace" && !strings.HasPrefix(ns, "openshift-") {
                hasParentSub := false
                for k := range subMap {
                    if strings.HasPrefix(k, ns+"/") {
                        hasParentSub = true
                        break
                    }
                }
                
                if !hasParentSub {
                    anomalies = append(anomalies, AnomalyInfo{
                        Type:        "Zombie CSV",
                        Severity:    "WARNING",
                        Resource:    name,
                        Namespace:   ns,
                        Description: "ClusterServiceVersion exists without an active parent OLM Subscription.",
                        Action:      "PURGE_ZOMBIE_CSV",
                    })
                }
            }

            status, ok := csv.Object["status"].(map[string]interface{})
            if ok {
                reason, _ := status["reason"].(string)
                
                if reason == "APIServiceResourceIssue" || reason == "RequirementsNotMet" {
                    anomalies = append(anomalies, AnomalyInfo{
                        Type:        "Webhook/API Timeout",
                        Severity:    "WARNING",
                        Resource:    name,
                        Namespace:   ns,
                        Description: "CSV is stuck waiting for APIService or Webhook requirement.",
                        Action:      "RESTART_OPERATOR_POD",
                    })
                } else if reason == "UnpackFailed" || reason == "UnsupportedAPI" {
                    anomalies = append(anomalies, AnomalyInfo{
                        Type:        "API Deprecation Rejection",
                        Severity:    "CRITICAL",
                        Resource:    name,
                        Namespace:   ns,
                        Description: "CSV contains deprecated Kubernetes API resources no longer supported in this OCP version.",
                        Action:      "CHANGE_SUBSCRIPTION_CHANNEL",
                    })
                }
            }
        }
    }

    // 4. Catalog Source Failures
    if catsrcs != nil {
        for _, cs := range catsrcs.Items {
            status, ok := cs.Object["status"].(map[string]interface{})
            if ok {
                connState, hasState := status["connectionState"].(map[string]interface{})
                if hasState {
                    lastState, _ := connState["lastObservedState"].(string)
                    if lastState != "READY" {
                        anomalies = append(anomalies, AnomalyInfo{
                            Type:        "Catalog Source",
                            Severity:    "CRITICAL",
                            Resource:    cs.GetName(),
                            Namespace:   cs.GetNamespace(),
                            Description: "CatalogSource gRPC connection is failing or pod is CrashLoopBackOff. State: " + lastState,
                            Action:      "RESTART_CATALOG_POD",
                        })
                    }
                }
            }
        }
    }

    return anomalies
}

// BuildUpgradeFlowData generates Sankey diagram data for upgrade visualization
func BuildUpgradeFlowData(operators []OperatorInfo) SankeyData {
    // Track flows: map[sourceVersion][targetVersion] = operators
    flowMap := make(map[string]map[string][]string)
    nodeCounts := make(map[string]int)
    nodeCategories := make(map[string]string)

    for _, op := range operators {
        currentVer := op.Version
        if currentVer == "" {
            currentVer = "Unknown"
        }

        var targetVer string
        var category string

        if !op.CanUpgrade {
            // Up-to-date or no upgrade available
            targetVer = "Up-to-Date"
            category = "safe"
        } else if op.Phase == "UpgradePending" || strings.Contains(op.Phase, "RequiresApproval") {
            // Blocked/pending approval
            targetVer = "Blocked"
            category = "blocked"
        } else {
            // Has upgrade available
            targetVer = op.TargetVersion
            if targetVer == "" {
                targetVer = "Available"
            }
            category = "target"
        }

        // Initialize nested map
        if flowMap[currentVer] == nil {
            flowMap[currentVer] = make(map[string][]string)
        }
        flowMap[currentVer][targetVer] = append(flowMap[currentVer][targetVer], op.Name)

        // Track node counts
        nodeCounts[currentVer]++
        nodeCounts[targetVer]++

        // Set categories
        if nodeCategories[currentVer] == "" {
            nodeCategories[currentVer] = "current"
        }
        if nodeCategories[targetVer] == "" {
            nodeCategories[targetVer] = category
        }
    }

    // Build nodes
    var nodes []SankeyNode
    nodeSet := make(map[string]bool)
    for nodeID := range nodeCounts {
        if !nodeSet[nodeID] {
            count := nodeCounts[nodeID]
            category := nodeCategories[nodeID]
            label := fmt.Sprintf("%s (%d)", nodeID, count)
            nodes = append(nodes, SankeyNode{
                ID:       nodeID,
                Label:    label,
                Category: category,
            })
            nodeSet[nodeID] = true
        }
    }

    // Build links
    var links []SankeyLink
    for source, targets := range flowMap {
        for target, ops := range targets {
            flowType := "minor"
            if target == "Blocked" {
                flowType = "blocked"
            } else if target == "Up-to-Date" {
                flowType = "uptodate"
            } else {
                // Determine upgrade type from first operator in this flow
                for _, opName := range ops {
                    for _, op := range operators {
                        if op.Name == opName {
                            flowType = strings.ToLower(op.UpgradeType)
                            break
                        }
                    }
                    break
                }
            }

            links = append(links, SankeyLink{
                Source:    source,
                Target:    target,
                Value:     len(ops),
                Type:      flowType,
                Operators: ops,
            })
        }
    }

    return SankeyData{
        Nodes: nodes,
        Links: links,
    }
}

// GVR helper functions for API handlers
func SubscriptionsGVR() schema.GroupVersionResource {
    return subscriptionGVR
}

func ClusterServiceVersionsGVR() schema.GroupVersionResource {
    return csvGVR
}

// DependencyGraph structures for visualization
type DependencyNode struct {
    ID       string `json:"id"`
    Label    string `json:"label"`
    Type     string `json:"type"` // "operator" or "crd"
    Group    string `json:"group"` // "provider", "consumer", "both"
    Shape    string `json:"shape"`
    Color    string `json:"color"`
}

type DependencyEdge struct {
    From  string `json:"from"`
    To    string `json:"to"`
    Label string `json:"label"`
    Type  string `json:"type"` // "provides", "consumes"
}

type DependencyGraphData struct {
    Nodes []DependencyNode `json:"nodes"`
    Edges []DependencyEdge `json:"edges"`
}

type ImpactAnalysis struct {
    Operator          string   `json:"operator"`
    DirectDependents  []string `json:"direct_dependents"`
    IndirectDependents []string `json:"indirect_dependents"`
    ProvidedCRDs      []string `json:"provided_crds"`
    ConsumedCRDs      []string `json:"consumed_crds"`
    BreakageRisk      string   `json:"breakage_risk"` // "Low", "Medium", "High", "Critical"
}

// BuildDependencyGraphData generates dependency graph from operators
// Note: This creates a visualization showing operator CRD relationships
// Real cross-operator dependencies would require querying all CRs in cluster
func BuildDependencyGraphData(operators []OperatorInfo) DependencyGraphData {
    nodes := make([]DependencyNode, 0)
    edges := make([]DependencyEdge, 0)

    // Track all CRDs across all operators
    allCRDKinds := make(map[string]string) // CRD kind -> operator that provides it

    // First pass: collect all CRDs
    for _, op := range operators {
        opID := op.Name
        if opID == "" {
            opID = op.Package
        }
        if opID == "" {
            continue
        }

        for _, crd := range op.CRDs {
            if _, exists := allCRDKinds[crd.Kind]; !exists {
                allCRDKinds[crd.Kind] = opID
            }
        }
    }

    // Second pass: build nodes and detect patterns
    operatorRoles := make(map[string]string) // operator -> role

    for _, op := range operators {
        opID := op.Name
        if opID == "" {
            opID = op.Package
        }
        if opID == "" {
            continue
        }

        // Determine operator characteristics
        hasCRDs := len(op.CRDs) > 0
        hasActiveCRs := op.ActiveCRs > 0

        var role string
        var color string

        if hasCRDs && hasActiveCRs {
            // Has CRDs and uses them
            role = "both"
            color = "#9333ea" // purple
        } else if hasCRDs {
            // Provides CRDs only
            role = "provider"
            color = "#3b82f6" // blue
        } else if hasActiveCRs {
            // Consumes CRDs only
            role = "consumer"
            color = "#22c55e" // green
        } else {
            // No CRDs or CRs
            role = "standalone"
            color = "#6b7280" // gray
        }

        operatorRoles[opID] = role

        nodes = append(nodes, DependencyNode{
            ID:    opID,
            Label: opID,
            Type:  "operator",
            Group: role,
            Shape: "box",
            Color: color,
        })
    }

    // Third pass: build edges - create simple connections between operators
    // that share CRD kinds (simplified dependency detection)
    edgeMap := make(map[string]bool) // deduplicate edges

    // Group operators by the CRDs they provide
    crdToOperators := make(map[string][]string)
    for _, op := range operators {
        opID := op.Name
        if opID == "" {
            opID = op.Package
        }
        if opID == "" {
            continue
        }

        for _, crd := range op.CRDs {
            crdToOperators[crd.Kind] = append(crdToOperators[crd.Kind], opID)
        }
    }

    // Create edges between operators that provide the same CRD type
    // (indicating potential collaboration or shared resource patterns)
    for crdKind, opList := range crdToOperators {
        if len(opList) > 1 {
            // Multiple operators provide same CRD - they're related
            for i := 0; i < len(opList)-1; i++ {
                for j := i + 1; j < len(opList); j++ {
                    edgeKey := opList[i] + "->" + opList[j]
                    if !edgeMap[edgeKey] {
                        edgeMap[edgeKey] = true
                        edges = append(edges, DependencyEdge{
                            From:  opList[i],
                            To:    opList[j],
                            Label: crdKind + " (shared)",
                            Type:  "shares",
                        })
                    }
                }
            }
        }
    }

    return DependencyGraphData{
        Nodes: nodes,
        Edges: edges,
    }
}

// AnalyzeOperatorImpact analyzes what would break if an operator is removed
func AnalyzeOperatorImpact(operators []OperatorInfo, operatorName string) ImpactAnalysis {
    result := ImpactAnalysis{
        Operator:          operatorName,
        DirectDependents:  []string{},
        IndirectDependents: []string{},
        ProvidedCRDs:      []string{},
        ConsumedCRDs:      []string{},
        BreakageRisk:      "Low",
    }

    // Find the target operator
    var targetOp *OperatorInfo
    for i := range operators {
        if operators[i].Name == operatorName || operators[i].Package == operatorName {
            targetOp = &operators[i]
            break
        }
    }

    if targetOp == nil {
        return result
    }

    // Collect CRDs provided by this operator
    providedCRDKinds := make(map[string]bool)
    for _, crd := range targetOp.CRDs {
        result.ProvidedCRDs = append(result.ProvidedCRDs, crd.Kind)
        providedCRDKinds[crd.Kind] = true

        if crd.ActiveCount > 0 {
            result.ConsumedCRDs = append(result.ConsumedCRDs, crd.Kind)
        }
    }

    // Find operators that depend on CRDs provided by this operator
    dependentMap := make(map[string]bool)

    for _, op := range operators {
        if op.Name == operatorName || op.Package == operatorName {
            continue
        }

        // Check if this operator uses any CRDs provided by target
        for _, crd := range op.CRDs {
            if providedCRDKinds[crd.Kind] && crd.ActiveCount > 0 {
                opID := op.Name
                if opID == "" {
                    opID = op.Package
                }
                if !dependentMap[opID] {
                    dependentMap[opID] = true
                    result.DirectDependents = append(result.DirectDependents, opID)
                }
            }
        }
    }

    // Calculate risk
    directCount := len(result.DirectDependents)
    providedCount := len(result.ProvidedCRDs)

    if directCount == 0 && providedCount == 0 {
        result.BreakageRisk = "Low"
    } else if directCount == 0 && providedCount > 0 {
        result.BreakageRisk = "Low"
    } else if directCount <= 2 {
        result.BreakageRisk = "Medium"
    } else if directCount <= 5 {
        result.BreakageRisk = "High"
    } else {
        result.BreakageRisk = "Critical"
    }

    return result
}