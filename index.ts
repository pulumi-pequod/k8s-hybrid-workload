/**
 * PKO Stack CR Deployer
 * ---------------------
 * This Pulumi program deploys a Pulumi Kubernetes Operator (PKO v2) `Stack`
 * Custom Resource (`pulumi.com/v1:Stack`) into an existing Kubernetes cluster
 * where the operator is already installed.
 *
 * The Stack CR instructs the operator to:
 *   1. Clone the workload Pulumi program from a Git repository.
 *   2. Attach a Pulumi ESC environment that supplies AWS credentials and the
 *      Kubernetes provider context to the operator's workspace pod.
 *   3. Continuously reconcile (deploy / update) that workload stack in-cluster.
 *
 * The Kubernetes provider for THIS program reads its kubeconfig from the ESC
 * environment `lotctl/k8s-cluster-aks`, which is imported by `Pulumi.dev.yaml`
 * and surfaced to the Pulumi CLI as `kubernetes:kubeconfig` config / the
 * `KUBECONFIG` environment variable.
 */

import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";

const config = new pulumi.Config();

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
// Fully-qualified name of the workload stack the operator will manage,
// e.g. "lotctl/k8s-hybrid-app/dev".
const workloadOrg = config.get("workloadOrg") ?? pulumi.getOrganization();
const workloadProject = config.get("workloadProject") ?? "k8s-hybrid-app";
const workloadStackName = config.get("workloadStackName") ?? "dev";
const workloadStack = `${workloadOrg}/${workloadProject}/${workloadStackName}`;

// Git repository that contains the workload Pulumi program.
const projectRepo =
    config.get("projectRepo") ??
    "https://github.com/pulumi-pequod/k8s-hybrid-app.git";
const branch = config.get("branch") ?? "refs/heads/main";
// Sub-directory within the repo that contains Pulumi.yaml (empty = repo root).
const repoDir = config.get("repoDir") ?? "workload";

// Pulumi ESC environment(s) providing AWS creds + Kubernetes provider context
// to the operator's workspace pod. The workload provisions BOTH AWS resources
// (DynamoDB/Lambda/API Gateway) and Kubernetes resources (Nginx frontend), so
// it needs two environments:
//   - cloud-access/aws-access  -> AWS_ACCESS_KEY_ID/SECRET/SESSION_TOKEN
//   - lotctl/k8s-cluster-aks   -> kubeconfig for the target cluster
const escEnvironments = config.getObject<string[]>("escEnvironments") ?? [
    "cloud-access/aws-access",
    "lotctl/k8s-cluster-aks",
];

// Namespace the operator (and this Stack CR) live in.
const operatorNamespace = config.get("operatorNamespace") ?? "pulumi-kubernetes-operator";

// Name of the Kubernetes ServiceAccount the operator's workspace pod runs as.
// This SA is created alongside the operator install (e.g. via IRSA / Workload
// Identity) and grants the pod its cloud identity. The PKO v2 install in this
// cluster provisions the `controller-manager` ServiceAccount in the operator
// namespace, so that is the default.
const workspaceServiceAccount =
    config.get("workspaceServiceAccount") ?? "controller-manager";

// ---------------------------------------------------------------------------
// Kubernetes provider (targets the cluster from the ESC environment)
// ---------------------------------------------------------------------------
const provider = new k8s.Provider("k8s-provider", {
    // When kubeconfig is provided by the ESC environment via the KUBECONFIG
    // env var / ambient config, this can be omitted. It is read here so the
    // provider is explicit and the program is self-documenting.
    kubeconfig: config.getSecret("kubeconfig"),
});

// ---------------------------------------------------------------------------
// Pulumi API token for the operator workspace
// ---------------------------------------------------------------------------
// The operator needs a PULUMI_ACCESS_TOKEN to talk to the Pulumi Cloud backend
// for the workload stack's state. We store it in a Kubernetes Secret and
// reference it from the Stack CR via `envRefs`.
//
// The token itself is supplied as a Pulumi secret config value:
//   pulumi config set --secret pulumiAccessToken <token>
const accessTokenSecret = new k8s.core.v1.Secret(
    "pulumi-access-token",
    {
        metadata: {
            name: "pulumi-api-secret",
            namespace: operatorNamespace,
        },
        stringData: {
            PULUMI_ACCESS_TOKEN: config.requireSecret("pulumiAccessToken"),
        },
    },
    { provider },
);

// ---------------------------------------------------------------------------
// RBAC: allow the workspace ServiceAccount to use the TokenReview API
// ---------------------------------------------------------------------------
// PKO v2 workspace pods authenticate the operator's gRPC calls using
// Kubernetes token auth, which requires the workspace ServiceAccount to be
// bound to the `system:auth-delegator` ClusterRole so it can create
// TokenReviews. Without this the workspace agent rejects the operator with
// "TokenReview API is unavailable".
const authDelegatorBinding = new k8s.rbac.v1.ClusterRoleBinding(
    "workspace-auth-delegator",
    {
        metadata: {
            name: `${operatorNamespace}:${workspaceServiceAccount}:system:auth-delegator`,
        },
        roleRef: {
            apiGroup: "rbac.authorization.k8s.io",
            kind: "ClusterRole",
            name: "system:auth-delegator",
        },
        subjects: [
            {
                kind: "ServiceAccount",
                namespace: operatorNamespace,
                name: workspaceServiceAccount,
            },
        ],
    },
    { provider },
);

// ---------------------------------------------------------------------------
// PKO Stack Custom Resource (pulumi.com/v1:Stack)
// ---------------------------------------------------------------------------
const workloadStackCr = new k8s.apiextensions.CustomResource(
    "k8s-hybrid-workload-stack",
    {
        apiVersion: "pulumi.com/v1",
        kind: "Stack",
        metadata: {
            name: "k8s-hybrid-workload",
            namespace: operatorNamespace,
            // Changing this value forces the operator to re-run a stalled stack
            // ("up failed N times; not retrying until the spec or source
            // changes"). Bump it via: pulumi config set reconcileTrigger <val>
            annotations: {
                "demo.pulumi.com/reconcile-trigger":
                    config.get("reconcileTrigger") ?? "1",
            },
        },
        spec: {
            // Fully-qualified target stack (org/project/stack).
            stack: workloadStack,

            // Git source of the workload program. The repo is public, so the
            // workspace pod clones it anonymously (no gitAuth). A stale token
            // here makes GitHub return 401 even for public repos.
            projectRepo: projectRepo,
            branch: branch,
            repoDir: repoDir,

            // Attach the Pulumi ESC environment(s) that provide AWS credentials
            // and the Kubernetes provider context to the workspace pod.
            environment: escEnvironments,

            // Provide PULUMI_ACCESS_TOKEN from the Kubernetes Secret above.
            envRefs: {
                PULUMI_ACCESS_TOKEN: {
                    type: "Secret",
                    secret: {
                        name: accessTokenSecret.metadata.name,
                        key: "PULUMI_ACCESS_TOKEN",
                    },
                },
            },

            // Run the workspace pod under a ServiceAccount that carries the
            // cloud identity (IRSA / Workload Identity) for AWS + Kubernetes.
            serviceAccountName: workspaceServiceAccount,

            // Poll the branch for new commits and re-run on drift.
            resyncFrequencySeconds: 60,
            continueResyncOnCommitMatch: false,

            // Refresh the stack's state before each update to detect drift.
            refresh: true,

            // Retry the update when it hits an HTTP 409 "another update in
            // progress" conflict instead of treating it as a hard failure.
            // The workspace pod can be recreated mid-update (e.g. on a transient
            // first-connect timeout), which orphans the Pulumi Cloud update lock;
            // subsequent attempts then 409 until the lock clears. Retrying rides
            // that out and lets an attempt win once a workspace instance stays up.
            retryOnUpdateConflict: true,

            // Destroy the managed cloud resources when this Stack CR is deleted.
            destroyOnFinalize: true,
        },
    },
    {
        provider,
        dependsOn: [accessTokenSecret, authDelegatorBinding],
    },
);

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------
export const stackCrName = workloadStackCr.metadata.name;
export const stackCrNamespace = workloadStackCr.metadata.namespace;
export const managedStack = workloadStack;
export const sourceRepo = pulumi.interpolate`${projectRepo} (${branch}, dir=${repoDir})`;
export const escEnvironmentsAttached = escEnvironments;
