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
}

type ClusterGovernanceResponse struct {
    OCPCurrentVersion string         `json:"ocp_current_version"`
    OCPNextVersion    string         `json:"ocp_next_version"`
    Operators         []OperatorInfo `json:"operators"`
    Total             int            `json:"total"`
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
        activeCRCount := 0
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
                }
            }
        }
        op.ActiveCRs = activeCRCount

        // Mark operator as idle only if it provides CRDs but none are instantiated
        if len(op.CRDs) > 0 && activeCRCount == 0 {
            op.IsIdle = true
        }

        // Scan OpenShift Routes in operator namespace
        routes, errRoute := dynClient.Resource(routeGVR).Namespace(namespace).List(ctx, metav1.ListOptions{})
        if errRoute == nil {
            for _, r := range routes.Items {
                host, foundHost, _ := unstructured.NestedString(r.Object, "spec", "host")
                if foundHost && host != "" {
                    op.ExposedRoutes = append(op.ExposedRoutes, host)
                    op.Components = append(op.Components, OperatorComponent{
                        Kind:      "Route",
                        Name:      r.GetName(),
                        Namespace: namespace,
                        Status:    fmt.Sprintf("Host: %s", host),
                    })
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

        results = append(results, op)
    }

    return ClusterGovernanceResponse{
        OCPCurrentVersion: ocpCurrent,
        OCPNextVersion:    ocpNext,
        Operators:         results,
        Total:             len(results),
    }, nil
}