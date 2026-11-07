/**
 * Hybrid Workload — deployed by the Pulumi Kubernetes Operator (PKO)
 * ------------------------------------------------------------------
 * This is the program the PKO `Stack` CR pulls from Git and runs inside the
 * cluster. It provisions:
 *
 *   AWS (serverless backend)
 *     - DynamoDB table storing { email (PK), name } submissions.
 *     - A least-privilege IAM role + Lambda that writes (PutItem) to the table.
 *     - An API Gateway (REST API) with explicit CORS routing POST/GET/OPTIONS
 *       to the Lambda.
 *
 *   Kubernetes (frontend)
 *     - A ConfigMap holding the Pulumi-branded static site + Nginx config,
 *       with the live API Gateway URL substituted in at pod start.
 *     - An Nginx Deployment serving the site.
 *     - A Service of type LoadBalancer exposing the site publicly.
 *
 * Credentials for both AWS and Kubernetes come from the Pulumi ESC environment
 * attached to the Stack CR by the operator — no providers are configured with
 * static secrets here.
 */

import * as fs from "fs";
import * as path from "path";
import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as apigateway from "@pulumi/aws-apigateway";
import * as k8s from "@pulumi/kubernetes";
// NOTE: The AWS SDK is intentionally NOT imported at module scope. It is
// `require`d inside the Lambda callback so Pulumi's function serialization does
// not try to capture/serialize the SDK (which contains native code and fails
// to serialize).

const config = new pulumi.Config();
const appName = config.get("appName") ?? "pulumipus-signup";
const runtime = "nodejs18.x";

const baseTags = {
    // NOTE: do NOT set an `owner` tag here — the AWS provider applies a
    // stack-level default tag `Owner` (aws:defaultTags), and AWS IAM rejects
    // tag keys that collide case-insensitively ("Owner" vs "owner").
    project: pulumi.getProject(),
    PulumiStack: pulumi.getStack(),
    managedBy: "pulumi-kubernetes-operator",
};

// Shared CORS headers reused by the Lambda for every response (incl. preflight).
const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
};

// ---------------------------------------------------------------------------
// DynamoDB: user submissions keyed by email
// ---------------------------------------------------------------------------
const submissionsTable = new aws.dynamodb.Table(`${appName}-submissions`, {
    attributes: [{ name: "email", type: "S" }],
    hashKey: "email",
    billingMode: "PAY_PER_REQUEST",
    pointInTimeRecovery: { enabled: true },
    tags: { ...baseTags },
});

// ---------------------------------------------------------------------------
// IAM: least-privilege role for the Lambda (PutItem on this table only)
// ---------------------------------------------------------------------------
const lambdaRole = new aws.iam.Role(`${appName}-lambda-role`, {
    assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
            {
                Action: "sts:AssumeRole",
                Effect: "Allow",
                Principal: { Service: "lambda.amazonaws.com" },
            },
        ],
    }),
    tags: { ...baseTags },
});

// Basic execution role for CloudWatch Logs.
new aws.iam.RolePolicyAttachment(`${appName}-lambda-logs`, {
    role: lambdaRole.name,
    policyArn: aws.iam.ManagedPolicy.AWSLambdaBasicExecutionRole,
});

// Least-privilege inline policy: PutItem on the submissions table only.
new aws.iam.RolePolicy(`${appName}-lambda-ddb-policy`, {
    role: lambdaRole.id,
    policy: submissionsTable.arn.apply((tableArn) =>
        JSON.stringify({
            Version: "2012-10-17",
            Statement: [
                {
                    Effect: "Allow",
                    Action: ["dynamodb:PutItem"],
                    Resource: tableArn,
                },
            ],
        }),
    ),
});

// ---------------------------------------------------------------------------
// Lambda: handles form submissions (POST JSON, optional GET query-string)
// ---------------------------------------------------------------------------
const submitHandler = new aws.lambda.CallbackFunction(`${appName}-handler`, {
    role: lambdaRole,
    runtime,
    // Pass the table name in via env so the handler doesn't capture Outputs.
    environment: {
        variables: {
            TABLE_NAME: submissionsTable.name,
        },
    },
    callback: async (ev: any) => {
        const method: string =
            ev.httpMethod || ev.requestContext?.http?.method || "POST";

        // CORS preflight.
        if (method === "OPTIONS") {
            return { statusCode: 204, headers: CORS_HEADERS, body: "" };
        }

        // Parse the submission from either a JSON body (POST) or the query
        // string (GET testing).
        let name: string | undefined;
        let email: string | undefined;
        try {
            if (method === "GET") {
                const q = ev.queryStringParameters || {};
                name = q.name;
                email = q.email;
            } else {
                const raw = ev.isBase64Encoded
                    ? Buffer.from(ev.body || "", "base64").toString("utf8")
                    : ev.body || "{}";
                const parsed = JSON.parse(raw || "{}");
                name = parsed.name;
                email = parsed.email;
            }
        } catch (e) {
            return {
                statusCode: 400,
                headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
                body: JSON.stringify({ error: "Invalid JSON payload" }),
            };
        }

        if (!name || !email) {
            return {
                statusCode: 400,
                headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
                body: JSON.stringify({
                    error: "Both 'name' and 'email' are required",
                }),
            };
        }

        const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
        const { DynamoDBDocument } = require("@aws-sdk/lib-dynamodb");
        const doc = DynamoDBDocument.from(new DynamoDBClient({}));
        await doc.put({
            TableName: process.env.TABLE_NAME,
            Item: {
                email,
                name,
                submittedAt: new Date().toISOString(),
            },
        });

        return {
            statusCode: 200,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
            body: JSON.stringify({ message: "Submission stored", email, name }),
        };
    },
    tags: { ...baseTags },
});

// ---------------------------------------------------------------------------
// API Gateway (REST API) — routes POST/GET/OPTIONS to the Lambda
// ---------------------------------------------------------------------------
const api = new apigateway.RestAPI(`${appName}-api`, {
    stageName: "prod",
    routes: [
        { path: "/submit", method: "POST", eventHandler: submitHandler },
        { path: "/submit", method: "GET", eventHandler: submitHandler },
        // Explicit preflight route so browsers get proper CORS headers.
        { path: "/submit", method: "OPTIONS", eventHandler: submitHandler },
    ],
    tags: { ...baseTags },
});

// Full invoke URL the browser posts to (stage URL already ends without slash).
const apiSubmitUrl = pulumi.interpolate`${api.url}submit`;

// ---------------------------------------------------------------------------
// Kubernetes frontend: Nginx serving the Pulumi-branded static site
// ---------------------------------------------------------------------------
const appLabels = { app: appName };

// Load the static assets from disk at deploy time.
const indexHtml = fs.readFileSync(
    path.join(__dirname, "frontend", "index.html"),
    "utf8",
);
const nginxConf = fs.readFileSync(
    path.join(__dirname, "frontend", "nginx.conf"),
    "utf8",
);

// Inject the live API endpoint into the HTML (replaces __API_ENDPOINT__).
const renderedHtml = apiSubmitUrl.apply((url) =>
    indexHtml.replace(/__API_ENDPOINT__/g, url),
);

const frontendConfig = new k8s.core.v1.ConfigMap(`${appName}-frontend`, {
    metadata: { name: `${appName}-frontend` },
    data: {
        "index.html": renderedHtml,
        "nginx.conf": nginxConf,
    },
});

const deployment = new k8s.apps.v1.Deployment(`${appName}-web`, {
    metadata: { name: `${appName}-web`, labels: appLabels },
    spec: {
        replicas: 3,
        selector: { matchLabels: appLabels },
        template: {
            metadata: {
                labels: appLabels,
                // Roll pods when the rendered HTML changes.
                annotations: {
                    "configmap/checksum": renderedHtml.apply((h) =>
                        Buffer.from(h).length.toString(),
                    ),
                },
            },
            spec: {
                containers: [
                    {
                        name: "nginx",
                        image: "nginx:1.27-alpine",
                        ports: [{ containerPort: 80 }],
                        volumeMounts: [
                            {
                                name: "web-content",
                                mountPath: "/usr/share/nginx/html/index.html",
                                subPath: "index.html",
                            },
                            {
                                name: "nginx-config",
                                mountPath: "/etc/nginx/conf.d/default.conf",
                                subPath: "nginx.conf",
                            },
                        ],
                        readinessProbe: {
                            httpGet: { path: "/healthz", port: 80 },
                            initialDelaySeconds: 3,
                            periodSeconds: 10,
                        },
                        livenessProbe: {
                            httpGet: { path: "/healthz", port: 80 },
                            initialDelaySeconds: 5,
                            periodSeconds: 15,
                        },
                        resources: {
                            requests: { cpu: "50m", memory: "64Mi" },
                            limits: { cpu: "250m", memory: "128Mi" },
                        },
                    },
                ],
                volumes: [
                    {
                        name: "web-content",
                        configMap: {
                            name: frontendConfig.metadata.name,
                            items: [{ key: "index.html", path: "index.html" }],
                        },
                    },
                    {
                        name: "nginx-config",
                        configMap: {
                            name: frontendConfig.metadata.name,
                            items: [{ key: "nginx.conf", path: "nginx.conf" }],
                        },
                    },
                ],
            },
        },
    },
});

const service = new k8s.core.v1.Service(`${appName}-web`, {
    metadata: { name: `${appName}-web`, labels: appLabels },
    spec: {
        type: "LoadBalancer",
        selector: appLabels,
        ports: [{ port: 80, targetPort: 80, protocol: "TCP" }],
    },
});

// Resolve the LoadBalancer's external address (IP on AKS/GKE, hostname on EKS).
const lbIngress = service.status.apply((s) => s?.loadBalancer?.ingress?.[0]);
const webHost = lbIngress.apply((i) => i?.ip || i?.hostname || "<pending>");

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------
export const webApplicationUrl = pulumi.interpolate`http://${webHost}`;
export const apiGatewayEndpoint = apiSubmitUrl;
export const dynamoTableName = submissionsTable.name;
export const dynamoTableArn = submissionsTable.arn;

// ===========================================================================
// Testing the API directly (commented out)
// ===========================================================================
//
// After PKO reconciles this stack, grab the API endpoint:
//
//   export API=$(pulumi stack output apiGatewayEndpoint)
//
// 1) POST a JSON submission:
//
//   curl -i -X POST "$API" \
//     -H "Content-Type: application/json" \
//     -d '{"name":"Ada Lovelace","email":"ada@example.com"}'
//
//   # Expected: HTTP/1.1 200 with
//   # {"message":"Submission stored","email":"ada@example.com","name":"Ada Lovelace"}
//
// 2) GET query-string test (no body):
//
//   curl -i "$API?name=Grace+Hopper&email=grace@example.com"
//
// 3) CORS preflight (OPTIONS) — verify the Access-Control-* headers:
//
//   curl -i -X OPTIONS "$API" \
//     -H "Origin: http://example-frontend" \
//     -H "Access-Control-Request-Method: POST"
//
//   # Expected: HTTP/1.1 204 with
//   #   Access-Control-Allow-Origin: *
//   #   Access-Control-Allow-Methods: GET,POST,OPTIONS
//   #   Access-Control-Allow-Headers: Content-Type
//
// 4) Verify the record landed in DynamoDB:
//
//   aws dynamodb get-item \
//     --table-name "$(pulumi stack output dynamoTableName)" \
//     --key '{"email":{"S":"ada@example.com"}}'
//
// 5) Open the web frontend in a browser:
//
//   pulumi stack output webApplicationUrl
//
// ===========================================================================
