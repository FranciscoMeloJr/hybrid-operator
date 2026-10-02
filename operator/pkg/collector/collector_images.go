package collector

import (
	"context"
	"strings"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/client-go/dynamic"
)

// ImageRef is a container image discovered on a workload. Images (ideally by
// digest) are the unit a vulnerability scanner keys on, so this is what any
// real CVE lookup for the operator or its operands must be built on top of.
type ImageRef struct {
	Image     string `json:"image"`     // reference as declared on the container spec (tag or digest)
	Digest    string `json:"digest"`    // resolved sha256 digest from pod status, when available
	Registry  string `json:"registry"`  // registry host parsed from the reference
	Namespace string `json:"namespace"` // namespace the workload runs in
	Container string `json:"container"` // container name
	Source    string `json:"source"`    // "operator" (operator namespace) or "operand" (CR namespace)
}

// parseRegistry extracts the registry host from an image reference. Images with
// no explicit registry default to docker.io, matching container runtime rules.
func parseRegistry(image string) string {
	ref := image
	if at := strings.Index(ref, "@"); at >= 0 {
		ref = ref[:at]
	}
	slash := strings.IndexByte(ref, '/')
	if slash < 0 {
		return "docker.io"
	}
	first := ref[:slash]
	// A registry host contains a '.' or ':' (port), or is the special "localhost".
	if strings.ContainsAny(first, ".:") || first == "localhost" {
		return first
	}
	return "docker.io"
}

// collectImages walks the pods in the operator namespace (source=operator) and
// in the namespaces where the operator's CRs live (source=operand), pulling the
// real container image references and resolving digests from pod status where
// available. Results are deduplicated per operator.
func collectImages(ctx context.Context, dynClient dynamic.Interface, operatorNS string, crNamespaces map[string]bool) []ImageRef {
	seen := make(map[string]bool)
	images := make([]ImageRef, 0)

	scan := func(ns, source string) {
		pods, err := dynClient.Resource(podGVR).Namespace(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return
		}
		for _, pod := range pods.Items {
			digestByContainer := imageDigests(pod)
			for _, section := range []string{"containers", "initContainers"} {
				containers, found, _ := unstructured.NestedSlice(pod.Object, "spec", section)
				if !found {
					continue
				}
				for _, c := range containers {
					cMap, ok := c.(map[string]interface{})
					if !ok {
						continue
					}
					image, _, _ := unstructured.NestedString(cMap, "image")
					if image == "" {
						continue
					}
					name, _, _ := unstructured.NestedString(cMap, "name")
					digest := digestByContainer[name]

					// Dedup by the most specific identity available (digest beats ref).
					key := ns + "|" + digest
					if digest == "" {
						key = ns + "|" + image
					}
					if seen[key] {
						continue
					}
					seen[key] = true

					images = append(images, ImageRef{
						Image:     image,
						Digest:    digest,
						Registry:  parseRegistry(image),
						Namespace: ns,
						Container: name,
						Source:    source,
					})
				}
			}
		}
	}

	scan(operatorNS, "operator")
	for ns := range crNamespaces {
		if ns == operatorNS {
			continue // already scanned as operator images
		}
		scan(ns, "operand")
	}

	return images
}

// imageDigests maps container name -> sha256 digest using the pod's running
// status, which reports the resolved imageID (e.g. "registry/repo@sha256:...").
func imageDigests(pod unstructured.Unstructured) map[string]string {
	out := make(map[string]string)
	for _, section := range []string{"containerStatuses", "initContainerStatuses"} {
		statuses, found, _ := unstructured.NestedSlice(pod.Object, "status", section)
		if !found {
			continue
		}
		for _, s := range statuses {
			sMap, ok := s.(map[string]interface{})
			if !ok {
				continue
			}
			name, _, _ := unstructured.NestedString(sMap, "name")
			imageID, _, _ := unstructured.NestedString(sMap, "imageID")
			if at := strings.Index(imageID, "@"); at >= 0 {
				out[name] = imageID[at+1:]
			}
		}
	}
	return out
}
