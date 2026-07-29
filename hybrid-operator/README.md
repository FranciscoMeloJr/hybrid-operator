# Hybrid Operator: Proactive OpenShift Remediation Framework

**Hybrid Operator** is a decoupled, hybrid-cloud operator framework engineered to deliver proactive telemetry analysis and autonomous cluster remediation across Red Hat OpenShift environments.

By splitting operational responsibilities into a cluster-native **Go Operator** and an external **Python Analytical Brain**, Hybrid Operator isolates heavy computation from the core Kubernetes reconcile loop while maintaining full cluster-side enforcement capabilities.

---

## 🏛️ System Architecture

                   +---------------------------------------+
                   |           OpenShift Cluster           |
                   |                                       |
                   |   +-------------------------------+   |
                   |   |        Hybrid Operator        |   |
                   |   |   (Go / controller-runtime)   |   |
                   |   +---------------+---------------+   |
                   +-------------------|-------------------+
                                       |
                            Telemetry  |  Action
                               Stream  |  Directives
                                       v
                   +---------------------------------------+
                   |            External Control           |
                   |                                       |
                   |   +-------------------------------+   |
                   |   |     Hybrid Operator Brain     |   |
                   |   |   (Python / Flask & NumPy)    |   |
                   |   +-------------------------------+   |
                   +---------------------------------------+

## 📁 Repository Structure

```text
.
└── hybrid-operator/
    ├── brain/
    │   ├── app.py              # Flask API server handling analysis & decision routing
    │   └── requirements.txt    # Python runtime dependencies
    └── operator/
        ├── Dockerfile          # Container image build for the Go operator binary
        ├── go.mod              # Go module definitions
        ├── go.sum              # Go dependency checksums
        ├── main.go             # Reconciler logic, telemetry loop, and action dispatcher
        └── operator-manifest.yaml # Kubernetes/OpenShift deployment, RBAC, and ServiceAccount