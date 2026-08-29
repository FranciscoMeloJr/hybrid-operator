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

		// Diff OpenAPI properties
		removed, mutated := compareOpenAPISchemas(targetSchema)
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

func compareOpenAPISchemas(targetSchema map[string]interface{}) ([]string, []string) {
	removedFields := make([]string, 0)
	typeMutations := make([]string, 0)

	var walkProps func(prefix string, targetProps map[string]interface{})
	walkProps = func(prefix string, targetProps map[string]interface{}) {
		for propName, val := range targetProps {
			fieldPath := propName
			if prefix != "" {
				fieldPath = fmt.Sprintf("%s.%s", prefix, propName)
			}
			if propMap, ok := val.(map[string]interface{}); ok {
				if nestedProps, ok := propMap["properties"].(map[string]interface{}); ok {
					walkProps(fieldPath, nestedProps)
				}
			}
		}
	}

	if targetProps, ok := targetSchema["properties"].(map[string]interface{}); ok {
		walkProps("", targetProps)
	}

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