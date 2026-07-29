package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// HybridOperatorConfigSpec defines the desired state of HybridOperatorConfig
type HybridOperatorConfigSpec struct {
	// ExternalBrain defines configuration for external predictive engine
	ExternalBrain ExternalBrainSpec `json:"externalBrain"`

	// Governance defines settings for OLM operator tracking
	Governance GovernanceSpec `json:"governance"`
}

type ExternalBrainSpec struct {
	// Enabled toggles proactive telemetry reporting
	Enabled bool `json:"enabled"`
	// URL of the external predictive service
	URL string `json:"url,omitempty"`
	// TargetNamespace to monitor
	TargetNamespace string `json:"targetNamespace,omitempty"`
	// TargetLabel filter for workloads
	TargetLabel string `json:"targetLabel,omitempty"`
}

type GovernanceSpec struct {
	// Enabled toggles cluster-wide OLM inventory tracking
	Enabled bool `json:"enabled"`
	// PollIntervalInSeconds defines how often OLM resources are audited
	PollIntervalInSeconds int `json:"pollIntervalInSeconds,omitempty"`
}

// HybridOperatorConfigStatus defines the observed state of HybridOperatorConfig
type HybridOperatorConfigStatus struct {
	ActiveBrainURL string `json:"activeBrainURL,omitempty"`
	TrackedOperatorsCount int    `json:"trackedOperatorsCount,omitempty"`
	LastSyncTime          string `json:"lastSyncTime,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status

// HybridOperatorConfig is the Schema for the hybridoperatorconfigs API
type HybridOperatorConfig struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   HybridOperatorConfigSpec   `json:"spec,omitempty"`
	Status HybridOperatorConfigStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// HybridOperatorConfigList contains a list of HybridOperatorConfig
type HybridOperatorConfigList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []HybridOperatorConfig `json:"items"`
}