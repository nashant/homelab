# Cluster bootstrap: nodes, then Cilium, then the Flux Operator. Order and known gaps: README.md.

USER = anthonynash
NODE1 = 172.16.0.10
NODE2 = 172.16.0.12
NODE3 = 172.16.0.13
EXTRA_ARGS = '--tls-san=k.nashes.uk --tls-san=k.23oak.uk --tls-san=172.16.0.9 --cluster-cidr=172.30.0.0/16 --service-cidr=172.31.0.0/16 --flannel-backend=none --disable-network-policy --disable-kube-proxy --kubelet-arg=system-reserved=cpu=1000m,memory=4Gi --node-taint=node.cilium.io/agent-not-ready:NoSchedule --kube-apiserver-arg=service-account-issuer=https://23oak-k8s-oidc.s3.eu-west-2.amazonaws.com --kube-apiserver-arg=api-audiences=sts.amazonaws.com,kubernetes.default.svc'

# The HelmReleases in git are the source of truth: each target reads its chart version and values from them.
GITOPS ?= $(CURDIR)/../gitops

CILIUM_HR = $(GITOPS)/platform/cilium/helmrelease.yaml
CILIUM_VALS = /tmp/cilium.vals.yaml
CILIUM_VERSION := $(shell yq .spec.chart.spec.version $(CILIUM_HR))

FLUX_OPERATOR = $(GITOPS)/platform/flux/operator.yaml
FLUX_OPERATOR_VALS = /tmp/flux-operator.vals.yaml
FLUX_OPERATOR_VERSION := $(shell yq 'select(.kind == "OCIRepository") | .spec.ref.tag' $(FLUX_OPERATOR))
FLUX_INSTANCE = $(GITOPS)/platform/flux/fluxinstance.yaml

.PHONY: install_amd64-1.home install_amd64-2.home install_amd64-3.home install_cilium install_flux_operator

install_amd64-1.home:
	k3sup install \
	  --ip $(NODE1) \
	  --user $(USER) \
	  --cluster \
	  --no-extras \
	  --k3s-extra-args \
	  $(EXTRA_ARGS)

install_amd64-2.home:
	k3sup join \
	  --ip $(NODE2) \
	  --user $(USER) \
	  --server-ip $(NODE1) \
	  --server-user $(USER) \
	  --server \
	  --no-extras \
	  --k3s-extra-args \
	  $(EXTRA_ARGS)

install_amd64-3.home:
	k3sup join \
	  --ip $(NODE3) \
	  --user $(USER) \
	  --server-ip $(NODE1) \
	  --server-user $(USER) \
	  --server \
	  --no-extras \
	  --k3s-extra-args \
	  $(EXTRA_ARGS)

# The nodes stay NotReady until Cilium runs (no flannel, no kube-proxy).
install_cilium:
	@yq .spec.values $(CILIUM_HR) > $(CILIUM_VALS)
	helm install -n kube-system cilium cilium/cilium --version $(CILIUM_VERSION) -f $(CILIUM_VALS)
	@rm $(CILIUM_VALS)
	kubectl apply -f $(GITOPS)/platform/cilium/bgpclusterconfig.yaml

# The Flux Operator, then the FluxInstance. The operator installs the Flux controllers and the sync.
install_flux_operator:
	@kubectl get ns flux-system > /dev/null 2>&1 || kubectl create ns flux-system
	@yq 'select(.kind == "HelmRelease") | .spec.values' $(FLUX_OPERATOR) > $(FLUX_OPERATOR_VALS)
	helm upgrade --install -n flux-system flux-operator oci://ghcr.io/controlplaneio-fluxcd/charts/flux-operator --version $(FLUX_OPERATOR_VERSION) -f $(FLUX_OPERATOR_VALS) --wait
	@rm $(FLUX_OPERATOR_VALS)
	kubectl apply -f $(FLUX_INSTANCE)
	kubectl wait fluxinstance/flux -n flux-system --for=condition=Ready --timeout=5m
