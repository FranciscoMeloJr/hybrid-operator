package collector

import (
	"context"
	"fmt"
	"log"
	"regexp"
	"strconv"

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
)

type CRDInfo struct {
	Name        string `json:"name"`
	Kind        string `json:"kind"`
	Version     string `json:"version"`
	DisplayName string `json:"displayName"`
	Description string `json:"description"`
}

type OperatorInfo struct {
	Name          string    `json:"name"`
	Package       string    `json:"package"`
	Namespace     string    `json:"namespace"`
	Channel       string    `json:"channel"`
	InstalledCSV  string    `json:"installedCSV"`
	Version       string    `json:"version"`
	Phase         string    `json:"phase"`
	TargetVersion string    `json:"target_version"`
	TargetCSV     string    `json:"target_csv"`
	CanUpgrade    bool      `json:"can_upgrade"`
	UpgradeType   string    `json:"upgrade_type"`
	CRDs          []CRDInfo `json:"crds"`
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

func TrackOperators(ctx context.Context, dynClient dynamic.Interface) ([]OperatorInfo, error) {
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
		return nil, fmt.Errorf("failed to list subscriptions: %w", err)
	}

	var results []OperatorInfo

	for _, sub := range subs.Items {
		name := sub.GetName()
		namespace := sub.GetNamespace()

		packageName, _, _ := unstructured.NestedString(sub.Object, "spec", "name")
		if packageName == "" {
			packageName, _, _ = unstructured.NestedString(sub.Object, "spec", "packageName")
		}
		channel, _, _ := unstructured.NestedString(sub.Object, "spec", "channel")
		startingCSV, _, _ := unstructured.NestedString(sub.Object, "spec", "startingCSV")

		installedCSV, _, _ := unstructured.NestedString(sub.Object, "status", "installedCSV")
		if installedCSV == "" {
			installedCSV = startingCSV
		}

		op := OperatorInfo{
			Name:          name,
			Package:       packageName,
			Namespace:     namespace,
			Channel:       channel,
			InstalledCSV:  installedCSV,
			Phase:         "Unknown",
			TargetVersion: "0.0.0",
			TargetCSV:     installedCSV,
			CanUpgrade:    false,
			UpgradeType:   "NONE",
			CRDs:          []CRDInfo{},
		}

		if installedCSV != "" {
			csvKey := fmt.Sprintf("%s/%s", namespace, installedCSV)
			if csvData, exists := csvMap[csvKey]; exists {
				op.Version = csvData.Version
				op.Phase = csvData.Phase
				op.CRDs = csvData.CRDs
			}
		}

		if op.Version == "" {
			installedVer := parseSemver(installedCSV)
			op.Version = fmt.Sprintf("%d.%d.%d", installedVer[0], installedVer[1], installedVer[2])
		}
		op.TargetVersion = op.Version

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

	return results, nil
}