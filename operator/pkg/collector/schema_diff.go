package collector

import (
	"context"
	"fmt"
	"strings"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
)

// CRDDiffResult holds field-level breaking change analysis for an operator target upgrade
type CRDDiffResult struct {
	HasBreakingImpact bool             `json:"has_breaking_impact"`
	RemovedFields     []string         `json:"removed_fields"`
	TypeMutations     []string         `json:"type_mutations"`
	ViolatingCRs      []CRImpactDetail `json:"violating_crs"`
}

type CRImpactDetail struct {
	CRName        string `json:"cr_name"`
	CRNamespace   string `json:"cr_namespace"`
	CRDKind       string `json:"crd_kind"`
	BreakingField string `json:"breaking_field"`
	Reason        string `json:"reason"`
}

// AnalyzeCRDBreakingChanges compares current active CRs against target CSV OpenAPI schemas
func AnalyzeCRDBreakingChanges(
	ctx context.Context,
	dynClient dynamic.Interface,
	namespace string,
	currentCRDs []CRDInfo,
	targetCSVUnstructured *unstructured.Unstructured,
) CRDDiffResult {
	result := CRDDiffResult{
		RemovedFields: make([]string, 0),
		TypeMutations: make([]string, 0),
		ViolatingCRs:  make([]CRImpactDetail, 0),
	}

	if targetCSVUnstructured == nil {
		return result
	}

	// Extract target owned CRDs schema descriptors from target CSV spec
	targetCRDSpecs, found, _ := unstructured.NestedSlice(targetCSVUnstructured.Object, "spec", "customresourcedefinitions", "owned")
	if !found {
		return result
	}

	targetSchemaMap := make(map[string]map[string]interface{})
	for _, item := range targetCRDSpecs {
		crdMap, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		kind, _, _ := unstructured.NestedString(crdMap, "kind")
		if openAPISchema, hasSchema, _ := unstructured.NestedMap(crdMap, "openAPIV3Schema"); hasSchema {
			targetSchemaMap[kind] = openAPISchema
		}
	}

	// Evaluate active cluster CRs against target schemas
	for _, crd := range currentCRDs {
		targetSchema, exists := targetSchemaMap[crd.Kind]
		if !exists {
			continue
		}

		parts := strings.SplitN(crd.Name, ".", 2)
		if len(parts) != 2 {
			continue
		}

		gvr := schema.GroupVersionResource{
			Group:    parts[1],
			Version:  crd.Version,
			Resource: parts[0],
		}

		crList, err := dynClient.Resource(gvr).Namespace(namespace).List(ctx, metav1.ListOptions{})
		if err != nil || len(crList.Items) == 0 {
			continue
		}

		// Diff the live (current) CRD schema against the target CSV schema.
		// Without a current schema to compare against there is nothing to
		// diff, so skip rather than report every field as removed.
		currentSchema := getCurrentCRDSchema(ctx, dynClient, crd.Name, crd.Version)
		if currentSchema == nil {
			continue
		}
		removed, mutated := compareOpenAPISchemas(currentSchema, targetSchema)
		result.RemovedFields = append(result.RemovedFields, removed...)
		result.TypeMutations = append(result.TypeMutations, mutated...)

		// Inspect active CR instances on cluster
		for _, cr := range crList.Items {
			crSpec, found, _ := unstructured.NestedMap(cr.Object, "spec")
			if !found {
				continue
			}

			for _, removedField := range removed {
				if hasFieldInSpec(crSpec, removedField) {
					result.HasBreakingImpact = true
					result.ViolatingCRs = append(result.ViolatingCRs, CRImpactDetail{
						CRName:        cr.GetName(),
						CRNamespace:   cr.GetNamespace(),
						CRDKind:       crd.Kind,
						BreakingField: fmt.Sprintf("spec.%s", removedField),
						Reason:        fmt.Sprintf("Field 'spec.%s' is removed in target version but actively configured on this CR", removedField),
					})
				}
			}
		}
	}

	return result
}

// crdGVR is the cluster-scoped GroupVersionResource for CRD definitions, used
// to read the currently-installed openAPIV3Schema for an operator's CRDs.
var crdGVR = schema.GroupVersionResource{
	Group:    "apiextensions.k8s.io",
	Version:  "v1",
	Resource: "customresourcedefinitions",
}

// getCurrentCRDSchema fetches the live openAPIV3Schema for the named CRD at the
// given served version. Returns nil if the CRD or version cannot be resolved,
// in which case the caller skips the diff (no current baseline to compare).
func getCurrentCRDSchema(ctx context.Context, dynClient dynamic.Interface, crdName, version string) map[string]interface{} {
	obj, err := dynClient.Resource(crdGVR).Get(ctx, crdName, metav1.GetOptions{})
	if err != nil {
		return nil
	}
	versions, found, _ := unstructured.NestedSlice(obj.Object, "spec", "versions")
	if !found {
		return nil
	}
	for _, v := range versions {
		vMap, ok := v.(map[string]interface{})
		if !ok {
			continue
		}
		name, _, _ := unstructured.NestedString(vMap, "name")
		if name != version {
			continue
		}
		if s, has, _ := unstructured.NestedMap(vMap, "schema", "openAPIV3Schema"); has {
			return s
		}
	}
	return nil
}

// specProperties returns the `.spec` property map of an openAPIV3Schema, or nil
// if absent. The diff only considers spec fields since that is what user CRs set.
func specProperties(schema map[string]interface{}) map[string]interface{} {
	props, ok := schema["properties"].(map[string]interface{})
	if !ok {
		return nil
	}
	spec, ok := props["spec"].(map[string]interface{})
	if !ok {
		return nil
	}
	specProps, ok := spec["properties"].(map[string]interface{})
	if !ok {
		return nil
	}
	return specProps
}

// compareOpenAPISchemas diffs the current CRD schema against the target schema
// and returns (removedFields, typeMutations) as spec-relative dotted paths
// (e.g. "replicas", "config.timeout"). A field present in the current spec but
// missing from the target is a breaking removal; a field whose declared type
// changes is a breaking mutation. If either schema lacks spec properties the
// diff is skipped (returns empty) to avoid false positives when a target CSV
// simply omits the embedded schema.
func compareOpenAPISchemas(currentSchema, targetSchema map[string]interface{}) ([]string, []string) {
	removedFields := make([]string, 0)
	typeMutations := make([]string, 0)

	currentSpec := specProperties(currentSchema)
	targetSpec := specProperties(targetSchema)
	if currentSpec == nil || targetSpec == nil {
		return removedFields, typeMutations
	}

	var walk func(prefix string, cur, tgt map[string]interface{})
	walk = func(prefix string, cur, tgt map[string]interface{}) {
		for name, cRaw := range cur {
			path := name
			if prefix != "" {
				path = fmt.Sprintf("%s.%s", prefix, name)
			}
			cMap, _ := cRaw.(map[string]interface{})
			tRaw, inTarget := tgt[name]
			if !inTarget {
				removedFields = append(removedFields, path)
				continue
			}
			tMap, _ := tRaw.(map[string]interface{})

			cType, _ := cMap["type"].(string)
			tType, _ := tMap["type"].(string)
			if cType != "" && tType != "" && cType != tType {
				typeMutations = append(typeMutations, fmt.Sprintf("%s (%s -> %s)", path, cType, tType))
			}

			cNested, cHas := cMap["properties"].(map[string]interface{})
			if !cHas {
				continue
			}
			tNested, tHas := tMap["properties"].(map[string]interface{})
			if !tHas {
				// Nested object collapsed in target: treat its children as removed.
				tNested = map[string]interface{}{}
			}
			walk(path, cNested, tNested)
		}
	}
	walk("", currentSpec, targetSpec)

	return removedFields, typeMutations
}

func hasFieldInSpec(spec map[string]interface{}, fieldPath string) bool {
	parts := strings.Split(fieldPath, ".")
	var current interface{} = spec

	for _, part := range parts {
		currMap, ok := current.(map[string]interface{})
		if !ok {
			return false
		}
		val, exists := currMap[part]
		if !exists {
			return false
		}
		current = val
	}
	return true
}